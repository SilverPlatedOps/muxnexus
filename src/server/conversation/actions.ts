// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { ConvError, GenericKey } from "../../shared/conversation";
import type { Tmux, WindowAgentInfo } from "../tmux";
import { adapterFor } from "./adapter";
import type { PaneRead } from "./pane";
import { readPage } from "./reader";

export type { KeyPlan } from "./adapter";

/**
 * Typing into an agent's terminal from the phone. A wrong key approves or
 * denies something the user didn't choose, so every action reads the pane
 * right before it writes and refuses on any doubt.
 */

type ConvTmux = Pick<Tmux, "agentOfWindow" | "capturePane" | "pasteInto" | "sendKeys">;
type Refusal = { ok: false; error: ConvError };

const refuse = (error: ConvError): Refusal => ({ ok: false, error });

/** How long an agent gets to redraw after a key before the action gives up. */
const REDRAW_MS = 2000;
/** Codex's decline: how long until its composer is back, polled every `FOLLOW_UP_POLL_MS`. */
const FOLLOW_UP_MS = 5000;
const FOLLOW_UP_POLL_MS = 250;
/** C-c arms "press again to exit" in Claude (Codex: quit) for a moment: never a second one in that time. */
const CLEAR_AGAIN_MS = 5000;
const lastClear = new Map<string, number>();

const GENERIC_KEYS: readonly string[] = ["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"] satisfies GenericKey[];

/** The conversation a tab holds: Claude's session id, Codex's thread id. */
export function conversationOf(info: WindowAgentInfo): string | null {
  return (info.kind === "claude" ? info.conversation?.sessionId : info.thread?.id) ?? null;
}

/** The text with C0 controls (other than newline and tab) and DEL removed: an ESC could end the bracketed paste early and type the rest as keys. */
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

async function readNow(tmux: Pick<Tmux, "capturePane">, kind: AgentKind, windowId: string): Promise<PaneRead> {
  return adapterFor(kind).readPane(await tmux.capturePane(windowId));
}

/** Reads the pane every `every` ms until `ok` accepts it; null after `ms`. */
async function readUntil(
  tmux: Pick<Tmux, "capturePane">, kind: AgentKind, windowId: string, ok: (r: PaneRead) => boolean, ms: number, every: number,
): Promise<PaneRead | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    await Bun.sleep(every);
    const r = await readNow(tmux, kind, windowId);
    if (ok(r)) return r;
    if (Date.now() >= deadline) return null;
  }
}

const idle = (r: PaneRead) => !r.dialog && !r.unrecognised && !r.working;

/**
 * Sends `text` as the user's next message to the conversation the phone
 * showed: pasted, then Enter. A draft at the desk is returned for the user to
 * decide on, and with `replace` cleared first.
 */
export async function sendText(
  tmux: ConvTmux, windowId: string, conversation: string, text: string, replace: boolean,
): Promise<{ ok: true } | Refusal | { ok: false; draft: string }> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  if (conversationOf(info) !== conversation) return refuse("another-conversation");
  const words = cleanText(text);
  if (words.trim() === "") return { ok: true };
  const adapter = adapterFor(info.kind);
  const r = await readNow(tmux, info.kind, windowId);
  // Typed into a dialog, digits would pick its options. A prompt that can't be read is no better.
  if (r.dialog || r.unrecognised || r.draft === "unknown") return refuse("waiting");
  if (r.draft === "text") {
    if (!replace) return { ok: false, draft: r.draftText ?? "" };
    // Claude's C-c interrupts a running turn instead, and text streaming under a draft shows no sign of work: ask the stamp too.
    if (r.working || info.state === "running") return refuse("working");
    if (Date.now() - (lastClear.get(windowId) ?? 0) < CLEAR_AGAIN_MS) return refuse("prompt-changed");
    lastClear.set(windowId, Date.now());
    await tmux.sendKeys(windowId, adapter.clearDraft);
    const cleared = await readUntil(tmux, info.kind, windowId, (x) => !x.dialog && !x.unrecognised && x.draft === "empty", REDRAW_MS, 50);
    if (!cleared) return refuse("prompt-changed");
  }
  await tmux.pasteInto(windowId, words);
  await tmux.sendKeys(windowId, ["Enter"]);
  return { ok: true };
}

/**
 * Chooses `option` on the dialog the pane shows, if it is still the one
 * `fingerprint` was read from. `text` is the user's words for a choice that
 * takes them.
 */
export async function answer(
  tmux: ConvTmux, windowId: string, fingerprint: string, option: number, text?: string,
): Promise<{ ok: true } | Refusal> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  const adapter = adapterFor(info.kind);
  const words = cleanText(text ?? "");
  const hasText = words.trim() !== "";
  // Before the pane, so the pane is read right before the keys go.
  const multi = info.kind === "claude" && (await pendingQuestionMulti("claude", info.conversation?.transcriptPath ?? "").catch(() => true));
  const r = await readNow(tmux, info.kind, windowId);
  const card = r.dialog;
  if (!card || card.fingerprint !== fingerprint) return refuse("prompt-changed");
  // The pane shows one question at a time: a multi-select one later in the call would be met half-answered (Decision 4).
  if (card.kind === "question" && multi) return refuse("waiting");
  const plan = adapter.keysFor(card, option, hasText);
  if (!plan) return refuse("prompt-changed");
  await tmux.sendKeys(windowId, plan.keys);
  if (plan.text) {
    // The field has focus once the dialog no longer reads as a card (every reader refuses a focused field)
    // and the prompt hasn't come back either: only then can the words not pick an option.
    const focused = await readUntil(tmux, info.kind, windowId, (x) => x.unrecognised, REDRAW_MS, 50);
    if (!focused) return refuse("prompt-changed");
    await tmux.pasteInto(windowId, words);
    await tmux.sendKeys(windowId, ["Enter"]);
  }
  if (plan.followUp) {
    if (!(await readUntil(tmux, info.kind, windowId, idle, FOLLOW_UP_MS, FOLLOW_UP_POLL_MS))) return refuse("prompt-changed");
    const sent = await sendText(tmux, windowId, conversationOf(info) ?? "", words, false);
    // A draft back in the composer is the desk's: the words are not added to it.
    if (!sent.ok) return "error" in sent ? sent : refuse("prompt-changed");
  }
  return { ok: true };
}

/** Interrupts the agent (Escape), only while the pane shows it working with no dialog up. */
export async function stop(tmux: Pick<Tmux, "agentOfWindow" | "capturePane" | "sendKeys">, windowId: string): Promise<void> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return;
  const r = await readNow(tmux, info.kind, windowId);
  if (r.working && !r.dialog && !r.unrecognised) await tmux.sendKeys(windowId, ["Escape"]);
}

/** One of Screen's keys, as pressed at the desk: any tab, any screen. */
export async function pressKey(tmux: Pick<Tmux, "sendKeys">, windowId: string, key: GenericKey): Promise<void> {
  if (!GENERIC_KEYS.includes(key)) throw new Error(`not a generic key: ${JSON.stringify(key)}`);
  await tmux.sendKeys(windowId, [key]);
}

/**
 * Whether the newest unanswered AskUserQuestion in the transcript's last page
 * has a multi-select question: such a call is answered on Screen, card by
 * card being only for single-select. An input that can't be read counts as one.
 */
export async function pendingQuestionMulti(kind: AgentKind, transcriptPath: string): Promise<boolean> {
  if (kind !== "claude") return false;
  const { items } = await readPage(kind, transcriptPath, {});
  const answered = new Set(items.flatMap((i) => (i.kind === "step-result" || (i.kind === "step" && i.result) ? [i.id] : [])));
  const step = items.findLast((i) => i.kind === "step" && i.tool === "AskUserQuestion" && !answered.has(i.id));
  if (!step || step.kind !== "step") return false;
  try {
    const questions: unknown = JSON.parse(step.input)?.questions;
    return !Array.isArray(questions) || questions.some((q) => q?.multiSelect === true);
  } catch {
    return true;
  }
}
