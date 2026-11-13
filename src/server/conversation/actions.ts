// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { ConvError, GenericKey } from "../../shared/conversation";
import { believedState, type Tmux, type WindowAgentInfo } from "../tmux";
import { adapterFor } from "./adapter";
import { QUEUED } from "./claude";
import { fingerprint, paneLines, type PaneRead } from "./pane";
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
/** A second Escape soon after the first is Claude's Esc Esc (it opens the rewind list): a double tap stops once. */
const STOP_AGAIN_MS = 2000;
const lastStop = new Map<string, number>();

export const GENERIC_KEYS: readonly string[] =["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"] satisfies GenericKey[];

/** The conversation a tab holds: Claude's session id, Codex's thread id. */
export function conversationOf(info: WindowAgentInfo): string | null {
  return (info.kind === "claude" ? info.conversation?.sessionId : info.thread?.id) ?? null;
}

/** The text with C0 controls (other than newline and tab), DEL and C1 controls removed: an ESC (or C1's CSI) could end the bracketed paste early and type the rest as keys. */
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// Every read and write goes to the agent's own pane (`info.paneId`), never the
// window's active one: in a split window that may be another agent's.

async function readNow(tmux: Pick<Tmux, "capturePane">, kind: AgentKind, pane: string): Promise<PaneRead> {
  return adapterFor(kind).readPane(await tmux.capturePane(pane));
}

/**
 * Reads the pane every `every` ms until `ok` accepts it; null after `ms`, or
 * as soon as `still` (checked before each read, so the read stays the last
 * look before whatever follows) says the tab has changed.
 */
async function readUntil(
  tmux: Pick<Tmux, "capturePane">, kind: AgentKind, pane: string, ok: (r: PaneRead) => boolean, ms: number, every: number,
  still?: () => Promise<boolean>,
): Promise<PaneRead | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    await Bun.sleep(every);
    if (still && !(await still())) return null;
    const r = await readNow(tmux, kind, pane);
    if (ok(r)) return r;
    if (Date.now() >= deadline) return null;
  }
}

const idle = (r: PaneRead) => !r.dialog && !r.unrecognised && !r.working;

/**
 * The prompt shows some text after a paste: the words are not matched (Claude
 * wraps a long line and folds a big paste into `[Pasted text #1 +N lines]`,
 * and Codex's composer draws them its own way). Claude's dim hint for queued
 * messages is text too, but not the words.
 */
const holdsWords = (r: PaneRead) => !r.dialog && !r.unrecognised && r.draft === "text" && r.draftText !== QUEUED;

/** Whether the window still holds the agent's pane `pane` and `conversation`: a `/clear` or a resume at the desk changes the one, a new agent the other. */
const sameAgent = (tmux: Pick<Tmux, "agentOfWindow">, windowId: string, pane: string, conversation: string) => async () => {
  const now = await tmux.agentOfWindow(windowId);
  return !!now && now.paneId === pane && conversationOf(now) === conversation;
};

/**
 * Enter after a paste, only once the prompt shows the words: the same agent
 * and conversation in the window, no dialog, some text. Anything else and the
 * words stay in the prompt unsent. A dialog drawn over the paste would take
 * the Enter, and its option 1 is usually Yes.
 */
async function submit(tmux: ConvTmux, windowId: string, kind: AgentKind, pane: string, conversation: string): Promise<{ ok: true } | Refusal> {
  // Polled over the redraw delay: a read right after the paste would see the prompt before the agent redrew it.
  // A dialog stops the wait at once; an unrecognised screen may be a redraw caught halfway, so it is read again.
  const r = await readUntil(tmux, kind, pane, (x) => !!x.dialog || holdsWords(x), REDRAW_MS, 50, sameAgent(tmux, windowId, pane, conversation));
  if (!r || r.dialog) return refuse("unsent");
  // What is left: a dialog drawn between this read and the Enter still takes it. The read and the key are two tmux
  // calls, so the window is one round trip, a few milliseconds.
  await tmux.sendKeys(pane, ["Enter"]);
  return { ok: true };
}

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
  const pane = info.paneId;
  const r = await readNow(tmux, info.kind, pane);
  // Typed into a dialog, digits would pick its options.
  if (r.dialog || r.unrecognised) return refuse("waiting");
  // A prompt whose text can't be read is asked about as if it held some (empty: none to show), and cleared the same way.
  if (r.draft !== "empty") {
    if (!replace) return { ok: false, draft: r.draftText ?? "" };
    // Claude's C-c interrupts a running turn instead, and text streaming under a draft shows no sign of work: the
    // stamp must say the turn is done, or the transcript that it was interrupted since. `input` with the prompt on
    // screen otherwise is a turn going on after a "No, and tell Claude…" (no tool ran, so no hook moved it back to `running`).
    if (r.working || (await believedState(info)) !== "done") return refuse("working");
    if (Date.now() - (lastClear.get(windowId) ?? 0) < CLEAR_AGAIN_MS) return refuse("prompt-changed");
    lastClear.set(windowId, Date.now());
    await tmux.sendKeys(pane, adapterFor(info.kind).clearDraft);
    const cleared = await readUntil(tmux, info.kind, pane, (x) => !x.dialog && !x.unrecognised && x.draft === "empty", REDRAW_MS, 50);
    if (!cleared) return refuse("prompt-changed");
  }
  await tmux.pasteInto(pane, words);
  return submit(tmux, windowId, info.kind, pane, conversation);
}

/**
 * Chooses `option` on the dialog the pane shows, if the tab still holds
 * `conversation` and the dialog is still the one `fingerprint` was read from.
 * `text` is the user's words for a choice that takes them.
 */
export async function answer(
  tmux: ConvTmux, windowId: string, conversation: string, fingerprint: string, option: number, text?: string,
): Promise<{ ok: true } | Refusal> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  // The fingerprint is the dialog's alone: the same prompt in another conversation would match it.
  if (conversationOf(info) !== conversation) return refuse("another-conversation");
  const adapter = adapterFor(info.kind);
  const pane = info.paneId;
  const words = cleanText(text ?? "");
  const hasText = words.trim() !== "";
  // Before the pane, so the pane is read right before the keys go.
  const multi = info.kind === "claude" && (await pendingQuestionMulti("claude", info.conversation?.transcriptPath ?? "").catch(() => true));
  const r = await readNow(tmux, info.kind, pane);
  const card = r.dialog;
  if (!card || card.fingerprint !== fingerprint) return refuse("prompt-changed");
  // The pane shows one question at a time: a multi-select one later in the call would be met half-answered (Decision 4).
  if (card.kind === "question" && multi) return refuse("waiting");
  const plan = adapter.keysFor(card, option, hasText);
  if (!plan) return refuse("prompt-changed");
  await tmux.sendKeys(pane, plan.keys);
  if (plan.text) {
    // The words go in only once this dialog's own field has focus, and Enter only while it still has: anything else
    // on screen (the prompt back, another dialog, a shell) would take them as keys or as a message.
    const inField = (x: PaneRead) => x.field?.fingerprint === card.fingerprint;
    if (!(await readUntil(tmux, info.kind, pane, inField, REDRAW_MS, 50))) return refuse("prompt-changed");
    await tmux.pasteInto(pane, words);
    // The words are in now: a refusal from here says so. (A long note can scroll a near-full-screen dialog's top away.)
    if (!(await readUntil(tmux, info.kind, pane, inField, REDRAW_MS, 50, sameAgent(tmux, windowId, pane, conversation)))) return refuse("unsent");
    // As in `submit`: a dialog drawn between this read and the Enter would take it, one round trip.
    await tmux.sendKeys(pane, ["Enter"]);
  }
  if (plan.followUp) {
    if (!(await readUntil(tmux, info.kind, pane, idle, FOLLOW_UP_MS, FOLLOW_UP_POLL_MS))) return refuse("prompt-changed");
    const sent = await sendText(tmux, windowId, conversation, words, false);
    // A draft back in the composer is the desk's: the words are not added to it.
    if (!sent.ok) return "error" in sent ? sent : refuse("prompt-changed");
  }
  return { ok: true };
}

/**
 * Interrupts the agent (Escape) while it works and no dialog is up, if the
 * tab still holds `conversation`. The pane can't always tell (Claude
 * streaming text under a draft shows nothing), so a `running` stamp counts
 * too. Nothing to stop, or a stop just sent, is ok.
 */
export async function stop(tmux: Pick<Tmux, "agentOfWindow" | "capturePane" | "sendKeys">, windowId: string, conversation: string): Promise<{ ok: true } | Refusal> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  // A tap meant for the conversation before a /clear, a resume or a new agent would stop the one there now.
  if (conversationOf(info) !== conversation) return refuse("another-conversation");
  const r = await readNow(tmux, info.kind, info.paneId);
  // Escape answers a dialog: the card or Screen does that.
  if (r.dialog || r.unrecognised) return refuse("waiting");
  // A stamp left `running` by an interrupt (no hook fires for Esc) has nothing to stop: Escape would reach an idle prompt.
  if (!r.working && (await believedState(info)) !== "running") return { ok: true };
  if (Date.now() - (lastStop.get(windowId) ?? 0) < STOP_AGAIN_MS) return { ok: true };
  lastStop.set(windowId, Date.now());
  await tmux.sendKeys(info.paneId, ["Escape"]);
  return { ok: true };
}

// --- Screen ---

type ScreenTmux = Pick<Tmux, "agentOfWindow" | "activePane" | "capturePane" | "paneSize">;

/** What Screen shows of a tab: its pane's capture and size, and the token a key pressed on it carries back. */
export interface ScreenShot { ansi: string; cols: number; rows: number; token: string }

/** Settling: read every `SETTLE_MS` until two reads agree, for at most `SETTLE_CAP_MS`. */
const SETTLE_MS = 150;
const SETTLE_CAP_MS = 1000;

/** The pane Screen shows and its keys reach: the agent's, or for a tab with none, the window's active pane. */
async function screenTarget(tmux: Pick<Tmux, "agentOfWindow" | "activePane">, windowId: string): Promise<{ info: WindowAgentInfo | null; pane: string }> {
  const info = await tmux.agentOfWindow(windowId);
  return { info, pane: info?.paneId ?? (await tmux.activePane(windowId)) };
}

/**
 * What a Screen key is bound to, worked out afresh before each key (nothing
 * is kept): the tab, the pane Screen shows, the conversation it holds ("" for
 * none) and the screen's text, with what the agent redraws on its own made
 * steady. Shell tabs too: a key is refused while their screen keeps changing.
 */
export function screenToken(windowId: string, pane: string, info: WindowAgentInfo | null, ansi: string): string {
  const texts = paneLines(ansi).map((l) => l.text.trimEnd());
  const rows = info ? adapterFor(info.kind).steady(texts) : texts;
  return fingerprint([windowId, pane, (info && conversationOf(info)) ?? "", ...rows]);
}

/** The tab's screen now, as Screen shows it. */
export async function screenNow(tmux: ScreenTmux, windowId: string): Promise<ScreenShot> {
  const { info, pane } = await screenTarget(tmux, windowId);
  const [ansi, size] = await Promise.all([tmux.capturePane(pane), tmux.paneSize(pane)]);
  return { ansi, ...size, token: screenToken(windowId, pane, info, ansi) };
}

/**
 * The screen once it has settled after a key: two reads in a row that agree
 * (by token, so a statusline tick doesn't count), or the last after about a
 * second for a screen that never stops (a spinner). The next key is pressed
 * on this, so Down, Down, Enter never races the agent's redraw.
 */
async function settled(tmux: ScreenTmux, windowId: string): Promise<ScreenShot> {
  const deadline = Date.now() + SETTLE_CAP_MS;
  await Bun.sleep(SETTLE_MS);
  let last = await screenNow(tmux, windowId);
  for (;;) {
    await Bun.sleep(SETTLE_MS);
    const next = await screenNow(tmux, windowId);
    if (next.token === last.token || Date.now() >= deadline) return next;
    last = next;
  }
}

/**
 * One of Screen's keys, pressed only while the tab shows what the user saw
 * (`token`, from the screen they pressed it on): read again right before the
 * key, any change since (a desk key, another pane, another conversation) and
 * it is refused. Either way the answer is the screen after, settled.
 */
export async function pressKey(
  tmux: ScreenTmux & Pick<Tmux, "sendKeys">, windowId: string, token: string, key: GenericKey,
): Promise<{ screen: ScreenShot; error?: ConvError }> {
  if (!GENERIC_KEYS.includes(key)) throw new Error(`not a generic key: ${JSON.stringify(key)}`);
  const { info, pane } = await screenTarget(tmux, windowId);
  if (screenToken(windowId, pane, info, await tmux.capturePane(pane)) !== token) return { screen: await settled(tmux, windowId), error: "prompt-changed" };
  await tmux.sendKeys(pane, [key]);
  return { screen: await settled(tmux, windowId) };
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
