// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { ConvError, GenericKey } from "../../shared/conversation";
import type { AgentState } from "../../shared/protocol";
import { believedState, type Tmux, type WindowAgentInfo } from "../tmux";
import { adapterFor, type KeyPlan } from "./adapter";
import { fingerprint, paneLines, rowKey, type PaneRead } from "./pane";
import { readPage } from "./reader";

export type { KeyPlan } from "./adapter";

/**
 * Typing into an agent's terminal from the phone. A wrong key approves or
 * denies something the user didn't choose, so every action reads the pane
 * right before it writes and refuses on any doubt.
 */

type ConvTmux = Pick<Tmux, "agentOfWindow" | "snapshot" | "pasteInto" | "sendKeys">;
type Refusal = { ok: false; error: ConvError };

const refuse = (error: ConvError): Refusal => ({ ok: false, error });

/** How long an agent gets to redraw after a key before the action gives up. */
const REDRAW_MS = 2000;
/** How often the pane is read while waiting on a redraw. */
const REDRAW_POLL_MS = 50;
/** Codex's decline: how long until its composer is back, polled every `FOLLOW_UP_POLL_MS`. */
const FOLLOW_UP_MS = 5000;
const FOLLOW_UP_POLL_MS = 250;
/** C-c arms "press again to exit" in Claude (Codex: quit) for a moment: never a second one in that time. */
const CLEAR_AGAIN_MS = 5000;
const lastClear = new Map<string, number>();
/** A second Escape soon after the first is Claude's Esc Esc (it opens the rewind list): a double tap stops once. */
const STOP_AGAIN_MS = 2000;
/** When Stop's Escape last went to each window, and the pane, conversation and turn (the stamp's `since`) it went to. */
const stopSent = new Map<string, { pane: string; conversation: string | null; since: number | undefined; at: number }>();

export const GENERIC_KEYS: readonly string[] =["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"] satisfies GenericKey[];

/** The conversation a tab holds: Claude's session id, Codex's thread id. */
export function conversationOf(info: WindowAgentInfo): string | null {
  return (info.kind === "claude" ? info.conversation?.sessionId : info.thread?.id) ?? null;
}

/** The text with C0 controls (other than newline and tab), DEL and C1 controls removed: an ESC (or C1's CSI) could end the bracketed paste early and type the rest as keys. */
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// --- The guard: every write from the phone goes through `guarded` ---
//
// Every read and write goes to the agent's own pane (`info.paneId`), never the
// window's active one: in a split window that may be another agent's.

/**
 * What a write is bound to, from the look-up the action began with: the tab,
 * the pane it writes to, whether that pane is the tab's agent's (else the
 * window's active pane, a shell tab's), and the conversation the tab held then
 * (null: none, as a shell tab or a fresh Codex has).
 */
interface Bound { windowId: string; pane: string; agent: boolean; conversation: string | null }

const bound = (windowId: string, info: WindowAgentInfo): Bound => ({ windowId, pane: info.paneId, agent: true, conversation: conversationOf(info) });

type Write = { keys: string[] } | { paste: string };
/** What the pane, read right before a write, says: write this, not yet (read it again), nothing to write, or refused. */
type Verdict = { write: Write } | "wait" | "skip" | ConvError;

/**
 * A verdict on the agent's pane as its adapter reads it, and on the tab's agent as the same snapshot found it: a
 * write that depends on the turn (Replace's clear, Stop's Escape) goes by the stamp read with the screen, never one
 * read before it.
 */
const onPane = (kind: AgentKind, verdict: (r: PaneRead, agent: WindowAgentInfo | null) => Verdict) =>
  (ansi: string, agent: WindowAgentInfo | null): Verdict => verdict(adapterFor(kind).readPane(ansi), agent);

/** Whether two looks at a tab found the same turn: the stamp's state and when it was set. */
const sameTurn = (a: WindowAgentInfo, b: WindowAgentInfo | null) => !!b && a.state === b.state && a.since === b.since;

/**
 * The one way the conversation view writes to a pane. Right before the write
 * it takes a snapshot of the tab (the window's agent and the pane's screen,
 * in one tmux call) and writes only if the tab still holds the same pane and
 * the same conversation, and `verdict` accepts the screen as the input state
 * the write expects. Anything else and nothing is written: another
 * conversation or pane is refused at once, and a screen `verdict` waits on is
 * read again every `every` ms (sleeping first, so an agent has time to redraw
 * after a key) until `ms` runs out, then refused as `late`. `wordsIn`: the
 * user's words are already in the prompt, so every refusal says so (`unsent`).
 *
 * What no read can close: a dialog drawn, or a conversation begun, after this
 * snapshot and before the write reaches the pane. The snapshot and the write
 * are two tmux calls, so that window is one round trip, a few milliseconds.
 */
async function guarded(
  tmux: Pick<Tmux, "snapshot" | "pasteInto" | "sendKeys">, b: Bound, verdict: (ansi: string, agent: WindowAgentInfo | null) => Verdict,
  opts: { ms?: number; every?: number; wordsIn?: boolean; late?: ConvError } = {},
): Promise<{ ok: true; wrote: boolean; ansi: string; agent: WindowAgentInfo | null } | Refusal> {
  const no = (error: ConvError) => refuse(opts.wordsIn ? "unsent" : error);
  const deadline = Date.now() + (opts.ms ?? 0);
  for (;;) {
    if (opts.every !== undefined) await Bun.sleep(opts.every);
    const snap = await tmux.snapshot(b.windowId, b.pane).catch(() => null);
    // The window or the pane is gone.
    if (!snap) return no(b.agent ? "no-agent" : "prompt-changed");
    if (b.agent && !snap.agent) return no("no-agent");
    const pane = snap.agent?.paneId ?? snap.active;
    const conversation = snap.agent ? conversationOf(snap.agent) : null;
    if (!!snap.agent !== b.agent || pane !== b.pane || conversation !== b.conversation) return no("another-conversation");
    const v = verdict(snap.ansi, snap.agent);
    if (v === "wait") {
      if (Date.now() >= deadline) return no(opts.late ?? "prompt-changed");
      continue;
    }
    if (v === "skip") return { ok: true, wrote: false, ansi: snap.ansi, agent: snap.agent };
    if (typeof v === "string") return no(v);
    if ("paste" in v.write) await tmux.pasteInto(b.pane, v.write.paste);
    else await tmux.sendKeys(b.pane, v.write.keys);
    return { ok: true, wrote: true, ansi: snap.ansi, agent: snap.agent };
  }
}

/**
 * Enter after a paste, only once the prompt shows the words: the same agent
 * and conversation in the window, no dialog, and the prompt holding the words
 * pasted and nothing else (the adapter's `owns`: wrapped, or folded into the
 * agent's placeholder of their size). Anything else and the words stay in the
 * prompt unsent: a dialog drawn over the paste would take the Enter (its
 * option 1 is usually Yes), and words typed at the desk meanwhile would be
 * sent as the phone's.
 */
async function submit(tmux: ConvTmux, b: Bound, kind: AgentKind, words: string): Promise<{ ok: true } | Refusal> {
  const adapter = adapterFor(kind);
  // Polled over the redraw delay: a read right after the paste would see the prompt before the agent redrew it.
  // A dialog stops the wait at once; anything else may be a redraw caught halfway, so it is read again.
  const entered = await guarded(tmux, b, onPane(kind, (x) => (x.dialog ? "unsent" : adapter.owns(x, words) ? { write: { keys: ["Enter"] } } : "wait")),
    { ms: REDRAW_MS, every: REDRAW_POLL_MS, wordsIn: true });
  return entered.ok ? { ok: true } : entered;
}

/**
 * The desk's draft as read, for a Replace to name: its text's fingerprint,
 * or for one whose text can't be read, its rows' as drawn, attributes and
 * all (the user was told it can't be shown; any change to it since asks
 * again). A prompt with no rows to go by gets a fingerprint no Replace can
 * carry back: it is never cleared.
 */
export function draftFingerprint(r: PaneRead): string {
  if (r.draft === "text") return fingerprint(["text", r.draftText ?? ""]);
  return fingerprint(r.draftRows ? ["rows", ...r.draftRows] : ["none", crypto.randomUUID()]);
}

/**
 * Sends `text` as the user's next message to the conversation the phone
 * showed: pasted, then Enter. A draft at the desk is returned for the user to
 * decide on, and with `replace` (the fingerprint of the draft they were
 * shown) cleared first.
 */
export async function sendText(
  tmux: ConvTmux, windowId: string, conversation: string, text: string, replace: string | null,
): Promise<{ ok: true } | Refusal | { ok: false; draft: string; draftFingerprint: string }> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  if (conversationOf(info) !== conversation) return refuse("another-conversation");
  const words = cleanText(text);
  if (words.trim() === "") return { ok: true };
  const b = bound(windowId, info);
  const adapter = adapterFor(info.kind);
  // Typed into a dialog, digits would pick its options. An empty prompt takes the words on this read; one holding
  // text (or text that can't be read, asked about as if it held some, and cleared the same way) is asked about first.
  // What is left before the paste is the guard's round trip: a dialog drawn after its snapshot would take the words as
  // typed keys. Enter is still withheld then: `submit` refuses on a dialog.
  const first = await guarded(tmux, b, onPane(info.kind, (r) =>
    r.dialog || r.unrecognised ? "waiting" : r.draft === "empty" ? { write: { paste: words } } : "skip"));
  if (!first.ok) return first;
  if (!first.wrote) {
    const r = adapter.readPane(first.ansi);
    // Replace clears only the draft the user saw: one changed at the desk since is shown instead, and kept.
    const shown = draftFingerprint(r);
    if (replace !== shown) return { ok: false, draft: r.draftText ?? "", draftFingerprint: shown };
    // Claude's C-c interrupts a running turn instead, and text streaming under a draft shows no sign of work: the
    // stamp must say the turn is done, or the transcript that it was interrupted since. `input` with the prompt on
    // screen otherwise is a turn going on after a "No, and tell Claude…" (no tool ran, so no hook moved it back to `running`).
    // A Stop before any output ends the turn with neither (`afterStop`).
    const stamp = await believedState(info);
    if (r.working || afterStop(windowId, info, stamp, r) !== "done") return refuse("working");
    if (Date.now() - (lastClear.get(windowId) ?? 0) < CLEAR_AGAIN_MS) return refuse("prompt-changed");
    // Read again after the transcript: the clear goes only to the draft shown, with the turn still over. A stamp moved
    // since the transcript was read against it is a turn begun (a queued or peer message): C-c would interrupt it.
    const cleared = await guarded(tmux, b, onPane(info.kind, (x, now) =>
      x.dialog || x.unrecognised ? "waiting" : draftFingerprint(x) !== shown ? "prompt-changed"
        : x.working || !sameTurn(info, now) || afterStop(windowId, info, stamp, x) !== "done" ? "working" : { write: { keys: adapter.clearDraft } }));
    if (!cleared.ok) return cleared;
    lastClear.set(windowId, Date.now());
    // The words go in once the prompt reads empty.
    const pasted = await guarded(tmux, b, onPane(info.kind, (x) =>
      x.dialog ? "waiting" : !x.unrecognised && x.draft === "empty" ? { write: { paste: words } } : "wait"), { ms: REDRAW_MS, every: REDRAW_POLL_MS });
    if (!pasted.ok) return pasted;
  }
  return submit(tmux, b, info.kind, words);
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
  const b = bound(windowId, info);
  const words = cleanText(text ?? "");
  const hasText = words.trim() !== "";
  // Before the pane, so the pane is read right before the keys go.
  const multi = info.kind === "claude" && (await pendingQuestionMulti("claude", info.conversation?.transcriptPath ?? "").catch(() => true));
  const chosen: { plan?: KeyPlan } = {};
  const keyed = await guarded(tmux, b, onPane(info.kind, (r) => {
    const card = r.dialog;
    if (!card || card.fingerprint !== fingerprint) return "prompt-changed";
    // The pane shows one question at a time: a multi-select one later in the call would be met half-answered (Decision 4).
    if (card.kind === "question" && multi) return "waiting";
    chosen.plan = adapter.keysFor(card, option, hasText) ?? undefined;
    return chosen.plan ? { write: { keys: chosen.plan.keys } } : "prompt-changed";
  }));
  if (!keyed.ok) return keyed;
  const plan = chosen.plan!;
  if (plan.text) {
    // The words go in only once this dialog's own field has focus, empty, and Enter only while it holds those words and
    // nothing else (as Send's Enter does): anything else on screen (the prompt back, another dialog, a shell) would
    // take them as keys or as a message, and words typed into the field at the desk would go as the phone's.
    const inField = (x: PaneRead) => x.field?.fingerprint === fingerprint;
    const pasted = await guarded(tmux, b, onPane(info.kind, (x) =>
      !inField(x) ? "wait" : x.field!.text === "" ? { write: { paste: words } } : "prompt-changed"), { ms: REDRAW_MS, every: REDRAW_POLL_MS });
    if (!pasted.ok) return pasted;
    // The words are in now: a refusal from here says so. (A long note can scroll a near-full-screen dialog's top away.)
    const entered = await guarded(tmux, b, onPane(info.kind, (x) =>
      inField(x) && adapter.shows(x.field!.text, words) ? { write: { keys: ["Enter"] } } : "wait"), { ms: REDRAW_MS, every: REDRAW_POLL_MS, wordsIn: true });
    if (!entered.ok) return entered;
  }
  if (plan.followUp) {
    // Codex's decline ends the turn: the words go as the next message once its composer is back, idle and empty.
    // A draft back in the composer is the desk's: the words are not added to it.
    const pasted = await guarded(tmux, b, onPane(info.kind, (x) =>
      x.dialog || x.unrecognised || x.working ? "wait" : x.draft === "empty" ? { write: { paste: words } } : "prompt-changed"),
      { ms: FOLLOW_UP_MS, every: FOLLOW_UP_POLL_MS });
    if (!pasted.ok) return pasted;
    return submit(tmux, b, info.kind, words);
  }
  return { ok: true };
}

/**
 * The agent's state as the conversation view believes it, given the stamp's
 * as `believedState` believes it (`state`) and the pane read just now: a
 * `running` stamp set before a Stop the server sent to this pane, in this
 * conversation, counts as done while the pane shows the agent idle (its
 * prompt, no dialog, not working). An Esc before the agent wrote anything
 * leaves no row in its conversation file and fires no hook, so nothing else
 * would ever say the turn ended; the next stamp (a new turn) is newer than
 * the Stop and stands. The hub, Replace and Stop all go by this.
 */
export function afterStop(windowId: string, info: WindowAgentInfo, state: AgentState | undefined, read: PaneRead | null): AgentState | undefined {
  if (state !== "running" || !read || !stoppedSince(windowId, info)) return state;
  return !read.dialog && !read.unrecognised && !read.working ? "done" : state;
}

/**
 * Whether Stop's Escape went to this tab's agent pane, in its conversation,
 * during the turn its stamp is for: the stamp the Escape was sent over, matched
 * exactly, whatever second the Stop came in. The next prompt's stamp is set anew,
 * so it is another turn.
 */
export function stoppedSince(windowId: string, info: WindowAgentInfo): boolean {
  const stop = stopSent.get(windowId);
  return !!stop && info.since !== undefined && stop.pane === info.paneId && stop.conversation === conversationOf(info) && stop.since === info.since;
}

/**
 * Interrupts the agent (Escape) while it works and no dialog is up, if the
 * tab still holds `conversation`. The pane can't always tell (Claude
 * streaming text under a draft shows nothing), so a `running` stamp counts
 * too, unless a Stop already ended that turn (`afterStop`). Nothing to stop,
 * or a stop just sent, is ok.
 */
export async function stop(
  tmux: Pick<Tmux, "agentOfWindow" | "snapshot" | "pasteInto" | "sendKeys">, windowId: string, conversation: string | null,
): Promise<{ ok: true } | Refusal> {
  const info = await tmux.agentOfWindow(windowId);
  if (!info) return refuse("no-agent");
  // A tap meant for the conversation before a /clear, a resume or a new agent would stop the one there now. None
  // (`null`) is a fresh Codex's, before its first thread: a Claude tab always names its session, and a daemon Codex's
  // conversation is unknown rather than none.
  if (conversationOf(info) !== conversation || (conversation === null && !(info.kind === "codex" && info.fresh))) return refuse("another-conversation");
  // A stamp left `running` by an interrupt (no hook fires for Esc) has nothing to stop: Escape would reach an idle prompt.
  const stamp = await believedState(info);
  const again = Date.now() - (stopSent.get(windowId)?.at ?? 0) < STOP_AGAIN_MS;
  const sent = await guarded(tmux, bound(windowId, info), onPane(info.kind, (r, now) => {
    // Escape answers a dialog: the card or Screen does that.
    if (r.dialog || r.unrecognised) return "waiting";
    // The turn as the snapshot finds it: a stamp moved since the transcript was read is taken as it stands (a turn
    // ended has nothing to stop, one begun is the one to stop).
    const turn = sameTurn(info, now) ? stamp : now?.state;
    return (r.working || afterStop(windowId, now ?? info, turn, r) === "running") && !again ? { write: { keys: ["Escape"] } } : "skip";
  }));
  if (!sent.ok) return sent;
  const to = sent.agent ?? info;
  if (sent.wrote) stopSent.set(windowId, { pane: to.paneId, conversation: conversationOf(to), since: to.since, at: Date.now() });
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
 * none) and the screen's text and how it is drawn, with what the agent
 * redraws on its own made steady. Shell tabs too: a key is refused while
 * their screen keeps changing.
 */
export function screenToken(windowId: string, pane: string, info: WindowAgentInfo | null, ansi: string): string {
  const lines = paneLines(ansi);
  const rows = info ? adapterFor(info.kind).steady(lines) : lines.map(rowKey);
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
  tmux: ScreenTmux & Pick<Tmux, "snapshot" | "pasteInto" | "sendKeys">, windowId: string, token: string, key: GenericKey,
): Promise<{ screen: ScreenShot; error?: ConvError }> {
  if (!GENERIC_KEYS.includes(key)) throw new Error(`not a generic key: ${JSON.stringify(key)}`);
  const { info, pane } = await screenTarget(tmux, windowId);
  const b: Bound = info ? bound(windowId, info) : { windowId, pane, agent: false, conversation: null };
  const pressed = await guarded(tmux, b, (ansi) => (screenToken(windowId, pane, info, ansi) === token ? { write: { keys: [key] } } : "prompt-changed"));
  return pressed.ok ? { screen: await settled(tmux, windowId) } : { screen: await settled(tmux, windowId), error: "prompt-changed" };
}

/**
 * Whether the newest unanswered AskUserQuestion in the transcript's last page
 * has a multi-select question: such a call is answered on Screen, card by
 * card being only for single-select. An input that can't be read counts as one, and so does none found: this
 * is asked only while the pane shows a question, so a transcript not naming it proves nothing.
 */
export async function pendingQuestionMulti(kind: AgentKind, transcriptPath: string): Promise<boolean> {
  if (kind !== "claude") return false;
  const { items } = await readPage(kind, transcriptPath, {});
  const answered = new Set(items.flatMap((i) => (i.kind === "step-result" || (i.kind === "step" && i.result) ? [i.id] : [])));
  const step = items.findLast((i) => i.kind === "step" && i.tool === "AskUserQuestion" && !answered.has(i.id));
  if (!step || step.kind !== "step") return true;
  try {
    const questions: unknown = JSON.parse(step.input)?.questions;
    return !Array.isArray(questions) || questions.some((q) => q?.multiSelect === true);
  } catch {
    return true;
  }
}
