import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "../src/server/conversation/adapter";
import { answer, cleanText, conversationOf, pendingQuestionMulti, pressKey, screenNow, sendText, stop } from "../src/server/conversation/actions";
import type { GenericKey } from "../src/shared/conversation";
import type { WindowAgentInfo } from "../src/server/tmux";

// Captured with `capture-pane -p -e` from real agents on a scratch tmux (Claude Code 2.1.322, Codex 0.167.1).
const raw = (name: string) => readFileSync(new URL(`./fixtures/conversation/pane-${name}.ansi`, import.meta.url), "utf8");

const dir = mkdtempSync(join(tmpdir(), "conv-actions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A Claude transcript holding one AskUserQuestion call, answered or not. */
function transcript(name: string, questions: unknown, answered = false): string {
  const path = join(dir, `${name}.jsonl`);
  const rows: unknown[] = [
    { type: "user", uuid: "u1", timestamp: "2026-11-13T10:00:00.000Z", message: { role: "user", content: "Ask me two things" } },
    {
      type: "assistant", uuid: "a1", timestamp: "2026-11-13T10:00:01.000Z",
      message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions } }] },
    },
  ];
  if (answered) {
    rows.push({ type: "user", uuid: "u2", timestamp: "2026-11-13T10:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", content: "answered" }] } });
  }
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

const q = (question: string, multiSelect: boolean) => ({ question, header: question.split(" ").pop(), multiSelect, options: [{ label: "a" }, { label: "b" }] });
const SINGLE = transcript("single", [q("Pick a colour", false), q("Pick a size", false)]);
const MULTI_LATER = transcript("multi-later", [q("Pick a colour", false), q("Pick fruits", true)]);

/** A conversation file holding `rows`. */
function rowsFile(name: string, rows: object[]): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}
/** When the stamps below were set: before the interrupts in these files. */
const SINCE = Date.parse("2026-11-13T10:00:00Z") / 1000;
// Esc fires no hook: the stamp stays `running` (or `input`), and only the conversation file says the turn ended.
const INTERRUPTED = rowsFile("interrupted", [
  { type: "user", uuid: "u1", timestamp: "2026-11-13T10:00:00.500Z", message: { role: "user", content: "count to fifty" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-11-13T10:00:02.000Z", message: { content: [{ type: "text", text: "1, 2, 3" }] } },
  { type: "user", uuid: "u2", timestamp: "2026-11-13T10:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } },
]);
const ABORTED = rowsFile("aborted", [
  { timestamp: "2026-11-13T10:00:00.500Z", type: "event_msg", payload: { type: "task_started" } },
  { timestamp: "2026-11-13T10:00:03.000Z", type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
]);

const claudeAgent = (over: Partial<WindowAgentInfo> = {}): WindowAgentInfo => ({
  paneId: "%1", kind: "claude", state: "done", conversation: { sessionId: "sess-1", transcriptPath: SINGLE }, ...over,
});
const codexAgent = (over: Partial<WindowAgentInfo> = {}): WindowAgentInfo => ({ paneId: "%2", kind: "codex", state: "done", thread: { id: "thread-1" }, ...over });

/**
 * A tmux that records every call in order. Each capture returns the next screen given, and each lookup the next
 * agent given (one, or a list); the last one repeats.
 */
function fakeTmux(agent: WindowAgentInfo | null | (WindowAgentInfo | null)[], panes: string[]) {
  const calls: unknown[][] = [];
  const agents = Array.isArray(agent) ? agent : [agent];
  let next = 0;
  let lookups = 0;
  return {
    calls,
    writes: () => calls.filter((c) => c[0] === "pasteInto" || c[0] === "sendKeys"),
    async agentOfWindow(windowId: string) { calls.push(["agentOfWindow", windowId]); return agents[Math.min(lookups++, agents.length - 1)] ?? null; },
    async activePane(windowId: string) { calls.push(["activePane", windowId]); return "%9"; },
    async capturePane(paneId: string) { calls.push(["capturePane", paneId]); return panes[Math.min(next++, panes.length - 1)]!; },
    async pasteInto(paneId: string, text: string) { calls.push(["pasteInto", paneId, text]); },
    async sendKeys(paneId: string, keys: string[]) { calls.push(["sendKeys", paneId, keys]); },
    async paneSize(paneId: string) { calls.push(["paneSize", paneId]); return { cols: 120, rows: 40 }; },
  };
}

/** The prompt after a paste: holding text (the words aren't matched, as Claude wraps and folds them). */
const PASTED = { claude: raw("claude-idle-draft"), codex: raw("codex-idle-draft") };

const print = (kind: "claude" | "codex", name: string) => adapterFor(kind).readPane(raw(`${kind}-${name}`)).dialog!.fingerprint;

/** The permission card with the highlight moved from row 1 to row `to`, as a desk keypress would leave it. */
const noCardAt = (to: number) => raw("claude-bash-no-card")
  .replace("\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1.")
  .replace(`   \x1b[38;2;153;153;153m${to}.`, ` \x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m${to}.`);

/**
 * A Write prompt with `note` typed into its No field (a lab capture), and the same dialog as it read before:
 * the card with the highlight on Yes, then the No field focused and empty.
 */
function notePanes(note: "lines" | "blank"): string[] {
  const typed = raw(`claude-write-no-${note}`);
  const rows = typed.split("\n");
  const no = rows.findIndex((r) => r.includes("3.\x1b[39m \x1b[38;5;153mNo, "));
  const footer = rows.findIndex((r, k) => k > no && r.includes("mEsc\x1b[39m"));
  const field = [...rows.slice(0, no), rows[no]!.replace(/No, \x1b\[39m.*$/, "No, \x1b[2m\x1b[39mand tell Claude what to do differently\x1b[0m"), "", ...rows.slice(footer)];
  const card = [...rows.slice(0, no), "   \x1b[38;5;246m3.\x1b[39m No", "", rows[footer] + " \x1b[38;5;246m·\x1b[39m \x1b[38;5;246mTab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mamend\x1b[39m", ...rows.slice(footer + 1)]
    .map((r) => r.replace("   \x1b[38;5;246m1.\x1b[39m Yes", " \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m Yes"));
  return [card.join("\n"), field.join("\n"), typed];
}

// The agents' own panes: Claude's is %1, Codex's %2. Every read and write goes there, whatever the window's active pane.
describe("send", () => {
  test("send pastes then presses Enter", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(tmux, "@1", "sess-1", "line one\nline two", false)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["pasteInto", "%1", "line one\nline two"], ["sendKeys", "%1", ["Enter"]]]);
    // The conversation is checked before the pane is read, and the pane before anything is written; after the
    // paste, both again, the pane last, right before Enter.
    expect(tmux.calls).toEqual([
      ["agentOfWindow", "@1"], ["capturePane", "%1"], ["pasteInto", "%1", "line one\nline two"],
      ["agentOfWindow", "@1"], ["capturePane", "%1"], ["sendKeys", "%1", ["Enter"]],
    ]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@2", "thread-1", "hello", false)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["pasteInto", "%2", "hello"], ["sendKeys", "%2", ["Enter"]]]);

    // Claude mid-turn: its prompt takes the words while it works, and Enter queues them.
    const busy = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-working"), PASTED.claude]);
    expect(await sendText(busy, "@1", "sess-1", "and then this", false)).toEqual({ ok: true });
    expect(busy.writes()).toEqual([["pasteInto", "%1", "and then this"], ["sendKeys", "%1", ["Enter"]]]);
  });

  test("the paste is read back before Enter: a dialog drawn meanwhile, another conversation, or no words shown, and no Enter", async () => {
    // A permission dialog drawn while the words went in: Enter would choose its option 1, usually Yes.
    const dialog = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), raw("claude-bash-permission")]);
    const codexDialog = fakeTmux(codexAgent(), [raw("codex-idle-empty"), raw("codex-approval")]);
    // /clear or a resume at the desk between the paste and Enter: another conversation, or another pane, holds the tab.
    const other = fakeTmux([claudeAgent(), claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } })], [raw("claude-idle-empty"), PASTED.claude]);
    const moved = fakeTmux([claudeAgent(), claudeAgent({ paneId: "%7" })], [raw("claude-idle-empty"), PASTED.claude]);
    const gone = fakeTmux([claudeAgent(), null], [raw("claude-idle-empty"), PASTED.claude]);
    // The words never showed (the prompt still empty, or only Claude's hint for queued messages): waited out, then refused.
    const never = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    const hint = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-working"), raw("claude-queued")]);
    const all = [dialog, codexDialog, other, moved, gone, never, hint];
    const t0 = Date.now();
    const results = await Promise.all(all.map((tmux, k) => sendText(tmux, "@1", k === 1 ? "thread-1" : "sess-1", "words", false)));
    expect(results).toEqual(all.map(() => ({ ok: false, error: "unsent" })));
    for (const tmux of all) expect(tmux.writes()).toEqual([["pasteInto", tmux === codexDialog ? "%2" : "%1", "words"]]);
    // A dialog or another conversation is refused at once; words that never show, after the redraw delay.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    const quick = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), raw("claude-bash-permission")]);
    const q0 = Date.now();
    expect(await sendText(quick, "@1", "sess-1", "words", false)).toEqual({ ok: false, error: "unsent" });
    expect(Date.now() - q0).toBeLessThan(500);
  }, 10_000);

  test("a draft at the desk is never overwritten without asking", async () => {
    const ask = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(ask, "@3", "sess-1", "from the phone", false)).toEqual({ ok: false, draft: "hello draft" });
    expect(ask.writes()).toEqual([]);

    // Replace: one key clears the box, the box is read again and must be empty, then the paste.
    const replace = fakeTmux(claudeAgent(), [raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(replace, "@3", "sess-1", "from the phone", true)).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "%1", ["C-c"]], ["pasteInto", "%1", "from the phone"], ["sendKeys", "%1", ["Enter"]]]);

    const lines = fakeTmux(claudeAgent(), [raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(lines, "@4", "sess-1", "x", true)).toEqual({ ok: true });
    expect(lines.writes()[0]).toEqual(["sendKeys", "%1", ["C-c"]]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-draft"), raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@5", "thread-1", "x", true)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["sendKeys", "%2", ["C-c"]], ["pasteInto", "%2", "x"], ["sendKeys", "%2", ["Enter"]]]);
  });

  test("Claude's draft is cleared by one C-c: C-u leaves a multi-line draft's first line", () => {
    // Scratch check, Claude Code 2.1.322: C-u kills one line only and C-l leaves the draft; one C-c
    // empties a one-line, a multi-line and a `[Pasted text #1 +39 lines]` draft. While a turn runs,
    // C-c interrupts it instead and leaves the draft, so a clear is only ever sent to an idle prompt.
    // Codex 0.167.1: C-c empties the composer and a running turn carries on.
    expect(adapterFor("claude").clearDraft).toEqual(["C-c"]);
    expect(adapterFor("codex").clearDraft).toEqual(["C-c"]);
  });

  test("a draft is not replaced unless the turn is done: the clear would interrupt it", async () => {
    // The pane shows the turn running (queued messages wait on it).
    const busy = fakeTmux(claudeAgent(), [raw("claude-queued")]);
    expect(await sendText(busy, "@6", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    // Text streaming under a draft shows no sign of work on the pane: the stamp says so, and the transcript holds no interrupt since.
    const stamped = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    expect(await sendText(stamped, "@6", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    // After "No, and tell Claude…" no tool runs, so the stamp stays `input` while the reply streams.
    const steered = fakeTmux(claudeAgent({ state: "input" }), [raw("claude-idle-draft")]);
    expect(await sendText(steered, "@6", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    expect([...busy.writes(), ...stamped.writes(), ...steered.writes()]).toEqual([]);
  });

  test("after an interrupt the stamp still says running, but the transcript says done: the draft can be replaced", async () => {
    const claude = fakeTmux(claudeAgent({ state: "running", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(claude, "@20", "sess-1", "from the phone", true)).toEqual({ ok: true });
    expect(claude.writes()).toEqual([["sendKeys", "%1", ["C-c"]], ["pasteInto", "%1", "from the phone"], ["sendKeys", "%1", ["Enter"]]]);
    // Esc on a permission prompt leaves the stamp at `input`, with the same line in the transcript.
    const waiting = fakeTmux(claudeAgent({ state: "input", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(waiting, "@21", "sess-1", "x", true)).toEqual({ ok: true });
    const codex = fakeTmux(codexAgent({ state: "running", since: SINCE, thread: { id: "thread-1", path: ABORTED } }), [raw("codex-idle-draft"), raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@22", "thread-1", "x", true)).toEqual({ ok: true });
    expect(codex.writes()[0]).toEqual(["sendKeys", "%2", ["C-c"]]);
    // An interrupt from before the stamp is an earlier turn's: this one runs.
    const later = fakeTmux(claudeAgent({ state: "running", since: SINCE + 60, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft")]);
    expect(await sendText(later, "@23", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    expect(later.writes()).toEqual([]);
  });

  test("a clear that doesn't take sends nothing more, and a second C-c never follows", async () => {
    const stuck = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(stuck, "@7", "sess-1", "x", true)).toEqual({ ok: false, error: "prompt-changed" });
    expect(stuck.writes()).toEqual([["sendKeys", "%1", ["C-c"]]]);
    // Asked again at once: a second C-c would quit Claude.
    const again = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(again, "@7", "sess-1", "x", true)).toEqual({ ok: false, error: "prompt-changed" });
    expect(again.writes()).toEqual([]);
  });

  test("a message for another conversation is refused", async () => {
    const other = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), [raw("claude-idle-empty")]);
    expect(await sendText(other, "@1", "sess-1", "hi", false)).toEqual({ ok: false, error: "another-conversation" });
    expect(other.calls).toEqual([["agentOfWindow", "@1"]]);
    const thread = fakeTmux(codexAgent({ thread: { id: "thread-2" } }), [raw("codex-idle-empty")]);
    expect(await sendText(thread, "@2", "thread-1", "hi", true)).toEqual({ ok: false, error: "another-conversation" });
    expect(thread.writes()).toEqual([]);
    // A tab whose conversation can't be named can't be checked: refused too.
    const fresh = fakeTmux(codexAgent({ thread: undefined, fresh: true }), [raw("codex-idle-empty")]);
    expect(await sendText(fresh, "@2", "thread-1", "hi", false)).toEqual({ ok: false, error: "another-conversation" });
    const none = fakeTmux(null, [raw("claude-idle-empty")]);
    expect(await sendText(none, "@1", "sess-1", "hi", false)).toEqual({ ok: false, error: "no-agent" });
    expect([...fresh.writes(), ...none.writes()]).toEqual([]);
  });

  test("a desk prompt that can't be read is asked about as if it held text, and Replace clears it before the paste", async () => {
    // A composer row that isn't indented as Codex indents a draft's lines: the draft can't be read.
    const unreadable = raw("codex-idle-multiline-draft").replace("  line two", " line two");
    expect(adapterFor("codex").readPane(unreadable)).toMatchObject({ dialog: null, unrecognised: false, draft: "unknown" });
    const ask = fakeTmux(codexAgent(), [unreadable]);
    expect(await sendText(ask, "@24", "thread-1", "x", false)).toEqual({ ok: false, draft: "" });
    expect(ask.writes()).toEqual([]);
    const replace = fakeTmux(codexAgent(), [unreadable, raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(replace, "@25", "thread-1", "x", true)).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "%2", ["C-c"]], ["pasteInto", "%2", "x"], ["sendKeys", "%2", ["Enter"]]]);
    // Not read as empty after the clear: nothing is pasted.
    const stuck = fakeTmux(codexAgent(), [unreadable]);
    expect(await sendText(stuck, "@26", "thread-1", "x", true)).toEqual({ ok: false, error: "prompt-changed" });
    expect(stuck.writes()).toEqual([["sendKeys", "%2", ["C-c"]]]);
  });

  test("no text goes into a dialog", async () => {
    for (const [agent, pane] of [[claudeAgent(), "claude-bash-permission"], [claudeAgent(), "claude-trust"], [claudeAgent(), "claude-bash-no-field"], [codexAgent(), "codex-approval"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await sendText(tmux, "@1", conversationOf(agent)!, "1", true)).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
  });

  test("control characters never reach the pane", async () => {
    expect(cleanText("a\x1b[201~b\x07\nc")).toBe("a[201~b\nc");
    expect(cleanText("tab\there\r\nnext\x7f\x00")).toBe("tab\there\nnext");
    // C1 controls too: \x9b is CSI on its own.
    expect(cleanText("a\x9b201~b\x85c\x80\x9fd é")).toBe("a201~bcd é");
    const tmux = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(tmux, "@1", "sess-1", "one\x1b[201~\x1b[2Jtwo", false)).toEqual({ ok: true });
    expect(tmux.writes()[0]).toEqual(["pasteInto", "%1", "one[201~[2Jtwo"]);
    // Nothing left to send: nothing is typed, not even Enter.
    const empty = fakeTmux(claudeAgent(), [raw("claude-idle-suggestion")]);
    expect(await sendText(empty, "@1", "sess-1", "\x1b\x07 \n", false)).toEqual({ ok: true });
    expect(empty.writes()).toEqual([]);
  });
});

describe("answer", () => {
  test("an answer for another conversation is refused before the pane is read", async () => {
    const other = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), [raw("claude-bash-permission")]);
    expect(await answer(other, "@1", "sess-1", print("claude", "bash-permission"), 1)).toEqual({ ok: false, error: "another-conversation" });
    expect(other.calls).toEqual([["agentOfWindow", "@1"]]);
    const thread = fakeTmux(codexAgent({ thread: { id: "thread-2" } }), [raw("codex-approval")]);
    expect(await answer(thread, "@2", "thread-1", print("codex", "approval"), 1)).toEqual({ ok: false, error: "another-conversation" });
    expect(thread.calls).toEqual([["agentOfWindow", "@2"]]);
    const none = fakeTmux(null, [raw("claude-bash-permission")]);
    expect(await answer(none, "@1", "sess-1", print("claude", "bash-permission"), 1)).toEqual({ ok: false, error: "no-agent" });
  });

  test("an answer to a changed prompt sends nothing", async () => {
    const changed = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
    expect(await answer(changed, "@1", "sess-1", "0".repeat(40), 1)).toEqual({ ok: false, error: "prompt-changed" });
    // Answered at the desk: the prompt is back.
    const gone = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    expect(await answer(gone, "@1", "sess-1", print("claude", "bash-permission"), 1)).toEqual({ ok: false, error: "prompt-changed" });
    expect([...changed.writes(), ...gone.writes()]).toEqual([]);
  });

  test("an approved Bash prompt is one digit, no Enter", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
    expect(await answer(tmux, "@1", "sess-1", print("claude", "bash-permission"), 1)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "%1", ["1"]]]);
    // A plain No is its digit too, wherever the highlight is.
    const no = fakeTmux(claudeAgent(), [noCardAt(2)]);
    expect(await answer(no, "@1", "sess-1", print("claude", "bash-no-card"), 4)).toEqual({ ok: true });
    expect(no.writes()).toEqual([["sendKeys", "%1", ["4"]]]);
  });

  test("a choice the card doesn't offer, or words for a choice that takes none, sends nothing", async () => {
    for (const [option, text] of [[5, undefined], [0, undefined], [1.5, undefined], [1, "and also this"]] as const) {
      const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
      expect(await answer(tmux, "@1", "sess-1", print("claude", "bash-permission"), option, text)).toEqual({ ok: false, error: "prompt-changed" });
      expect(tmux.writes()).toEqual([]);
    }
    // The plan's feedback row and a question's "Type something." are fields: nothing to choose without words.
    const plan = fakeTmux(claudeAgent(), [raw("claude-plan")]);
    expect(await answer(plan, "@1", "sess-1", print("claude", "plan"), 3)).toEqual({ ok: false, error: "prompt-changed" });
    const question = fakeTmux(claudeAgent(), [raw("claude-question")]);
    expect(await answer(question, "@1", "sess-1", print("claude", "question"), 4, "  ")).toEqual({ ok: false, error: "prompt-changed" });
    expect([...plan.writes(), ...question.writes()]).toEqual([]);
  });

  test("No with words: down from the highlighted row, Tab, then the words once the field has focus", async () => {
    // Card, field focused, field holding the words: one dialog, captured in turn.
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-no-card"), raw("claude-bash-no-field"), raw("claude-bash-no-text")]);
    expect(await answer(tmux, "@1", "sess-1", print("claude", "bash-no-card"), 4, "instead list\x1b the directory")).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([
      ["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]],
      ["pasteInto", "%1", "instead list the directory"],
      ["sendKeys", "%1", ["Enter"]],
    ]);
    // Read before the paste and again before Enter, the tab's agent looked up again first.
    expect(tmux.calls.map((c) => c[0])).toEqual(["agentOfWindow", "capturePane", "sendKeys", "capturePane", "pasteInto", "agentOfWindow", "capturePane", "sendKeys"]);
    // The list wraps (Down on the last row goes to row 1), so the moves start from the highlight the pane shows.
    for (const [at, keys] of [[3, ["Down", "Tab"]], [4, ["Tab"]]] as const) {
      const moved = fakeTmux(claudeAgent(), [noCardAt(at), raw("claude-bash-no-field"), raw("claude-bash-no-text")]);
      expect(await answer(moved, "@1", "sess-1", print("claude", "bash-no-card"), 4, "words")).toEqual({ ok: true });
      expect(moved.writes()[0]).toEqual(["sendKeys", "%1", keys]);
    }
  });

  test("a note with a numbered line or a blank line in it is still the field's: Enter follows", async () => {
    for (const [note, words] of [
      ["lines", "Two things:\n1. do not create the file\nThen reply with just the word skipped2."],
      ["blank", "Do not create the file.\n\nReply with just the word skipped3."],
    ] as const) {
      const panes = notePanes(note);
      const read = adapterFor("claude").readPane(panes[0]!);
      expect(read.dialog).toMatchObject({ kind: "permission", selected: 1 });
      expect(panes.slice(1).map((p) => adapterFor("claude").readPane(p).field?.fingerprint)).toEqual([read.dialog!.fingerprint, read.dialog!.fingerprint]);
      const tmux = fakeTmux(claudeAgent(), panes);
      expect(await answer(tmux, "@1", "sess-1", read.dialog!.fingerprint, 3, words)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([["sendKeys", "%1", ["Down", "Down", "Tab"]], ["pasteInto", "%1", words], ["sendKeys", "%1", ["Enter"]]]);
    }
  });

  test("the words go only into the dialog's own field, and Enter only while it still has focus", async () => {
    const fp = print("claude", "bash-no-card");
    // Before the paste: the dialog as it was (the keys not taken yet), the prompt back (answered at the desk),
    // another dialog, a field of another dialog, a shell where the agent was. No words go in.
    // Each waits out its 2 s for the field: run side by side.
    await Promise.all([raw("claude-bash-no-card"), raw("claude-idle-empty"), raw("claude-trust"), raw("claude-question-typing"), "$ \n"].map(async (after) => {
      const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-no-card"), after]);
      expect(await answer(tmux, "@1", "sess-1", fp, 4, "words")).toEqual({ ok: false, error: "prompt-changed" });
      expect(tmux.writes()).toEqual([["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]]]);
    }));
    // Another conversation in the tab once the words are in: no Enter.
    const other = fakeTmux([claudeAgent(), claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } })],
      [raw("claude-bash-no-card"), raw("claude-bash-no-field"), raw("claude-bash-no-text")]);
    expect(await answer(other, "@1", "sess-1", fp, 4, "words")).toEqual({ ok: false, error: "unsent" });
    expect(other.writes()).toEqual([["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]], ["pasteInto", "%1", "words"]]);
    // After the paste the field is gone: no Enter, and the words, already in, are reported unsent.
    await Promise.all([raw("claude-idle-draft"), raw("claude-trust")].map(async (after) => {
      const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-no-card"), raw("claude-bash-no-field"), after]);
      expect(await answer(tmux, "@1", "sess-1", fp, 4, "words")).toEqual({ ok: false, error: "unsent" });
      expect(tmux.writes()).toEqual([["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]], ["pasteInto", "%1", "words"]]);
    }));
  }, 10_000);

  test("a plan's change request moves onto its field; a question's own answer is its digit, then the words", async () => {
    const plan = fakeTmux(claudeAgent(), [raw("claude-plan-change-card"), raw("claude-plan-change-field"), raw("claude-plan-change-text")]);
    expect(await answer(plan, "@1", "sess-1", print("claude", "plan-change-card"), 3, "use bye instead")).toEqual({ ok: true });
    expect(plan.writes()).toEqual([["sendKeys", "%1", ["Down", "Down"]], ["pasteInto", "%1", "use bye instead"], ["sendKeys", "%1", ["Enter"]]]);

    const approve = fakeTmux(claudeAgent(), [raw("claude-plan")]);
    expect(await answer(approve, "@1", "sess-1", print("claude", "plan"), 2)).toEqual({ ok: true });
    expect(approve.writes()).toEqual([["sendKeys", "%1", ["2"]]]);

    const question = fakeTmux(claudeAgent(), [raw("claude-question"), raw("claude-question-other-field"), raw("claude-question-other-text")]);
    expect(await answer(question, "@1", "sess-1", print("claude", "question"), 4, "purple")).toEqual({ ok: true });
    expect(question.writes()).toEqual([["sendKeys", "%1", ["4"]], ["pasteInto", "%1", "purple"], ["sendKeys", "%1", ["Enter"]]]);

    // A call with one question: the same keys, and Enter submits it at once (no review step).
    const single = fakeTmux(claudeAgent(), [raw("claude-question-single-plan"), raw("claude-question-single-field"), raw("claude-question-single-text")]);
    expect(await answer(single, "@1", "sess-1", print("claude", "question-single-plan"), 3, "kiwi")).toEqual({ ok: true });
    expect(single.writes()).toEqual([["sendKeys", "%1", ["3"]], ["pasteInto", "%1", "kiwi"], ["sendKeys", "%1", ["Enter"]]]);
  });

  test("each question is one digit; the review screen is answered with the user's pick", async () => {
    const first = fakeTmux(claudeAgent(), [raw("claude-question")]);
    expect(await answer(first, "@1", "sess-1", print("claude", "question"), 2)).toEqual({ ok: true });
    expect(first.writes()).toEqual([["sendKeys", "%1", ["2"]]]);
    const single = fakeTmux(claudeAgent(), [raw("claude-question-single")]);
    expect(await answer(single, "@1", "sess-1", print("claude", "question-single"), 2)).toEqual({ ok: true });
    expect(single.writes()).toEqual([["sendKeys", "%1", ["2"]]]);
    for (const option of [1, 2]) {
      const review = fakeTmux(claudeAgent(), [raw("claude-question-review")]);
      expect(await answer(review, "@1", "sess-1", print("claude", "question-review"), option)).toEqual({ ok: true });
      expect(review.writes()).toEqual([["sendKeys", "%1", [String(option)]]]);
    }
  });

  test("a question call with a multi-select question anywhere in it is answered on Screen only", async () => {
    const agent = claudeAgent({ conversation: { sessionId: "sess-1", transcriptPath: MULTI_LATER } });
    for (const pane of ["question", "question-review"]) {
      const tmux = fakeTmux(agent, [raw(`claude-${pane}`)]);
      expect(await answer(tmux, "@1", "sess-1", print("claude", pane), 1)).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
    // No transcript to check: refused. (Without its session the tab's conversation can't be named either.)
    const blind = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-1", transcriptPath: join(dir, "missing.jsonl") } }), [raw("claude-question")]);
    expect(await answer(blind, "@1", "sess-1", print("claude", "question"), 1)).toEqual({ ok: false, error: "waiting" });
    // A permission card doesn't depend on it.
    const permission = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-1", transcriptPath: join(dir, "missing.jsonl") } }), [raw("claude-bash-permission")]);
    expect(await answer(permission, "@1", "sess-1", print("claude", "bash-permission"), 1)).toEqual({ ok: true });
  });

  test("a Codex approval is y, p or Escape", async () => {
    for (const [option, key] of [[1, "y"], [2, "p"], [3, "Escape"]] as const) {
      const tmux = fakeTmux(codexAgent(), [raw("codex-approval")]);
      expect(await answer(tmux, "@2", "thread-1", print("codex", "approval"), option)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([["sendKeys", "%2", [key]]]);
    }
  });

  test("Codex's No with words declines, then sends the words once the composer is back", async () => {
    const tmux = fakeTmux(codexAgent(), [raw("codex-approval"), raw("codex-approval"), raw("codex-idle-empty"), raw("codex-idle-empty"), PASTED.codex]);
    expect(await answer(tmux, "@2", "thread-1", print("codex", "approval"), 3, "use the temp dir instead")).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "%2", ["Escape"]], ["pasteInto", "%2", "use the temp dir instead"], ["sendKeys", "%2", ["Enter"]]]);
    // A draft came back with the composer: it is the desk's, so the words are not added to it.
    const draft = fakeTmux(codexAgent(), [raw("codex-approval"), raw("codex-idle-draft")]);
    expect(await answer(draft, "@2", "thread-1", print("codex", "approval"), 3, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(draft.writes()).toEqual([["sendKeys", "%2", ["Escape"]]]);
    // The words went into the composer and a dialog came up over them: no Enter, reported unsent.
    const over = fakeTmux(codexAgent(), [raw("codex-approval"), raw("codex-approval"), raw("codex-idle-empty"), raw("codex-idle-empty"), raw("codex-approval")]);
    expect(await answer(over, "@2", "thread-1", print("codex", "approval"), 3, "words")).toEqual({ ok: false, error: "unsent" });
    expect(over.writes()).toEqual([["sendKeys", "%2", ["Escape"]], ["pasteInto", "%2", "words"]]);
  });

  test("Codex's follow-up gives up after 5 s without the composer", async () => {
    const tmux = fakeTmux(codexAgent(), [raw("codex-approval")]);
    const t0 = Date.now();
    expect(await answer(tmux, "@2", "thread-1", print("codex", "approval"), 3, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
    expect(tmux.writes()).toEqual([["sendKeys", "%2", ["Escape"]]]);
    // Polled every 250 ms.
    expect(tmux.calls.filter((c) => c[0] === "capturePane").length).toBeLessThanOrEqual(22);
  }, 10_000);
});

describe("pendingQuestionMulti", () => {
  test("true only while the newest unanswered AskUserQuestion has a multi-select question", async () => {
    expect(await pendingQuestionMulti("claude", SINGLE)).toBe(false);
    expect(await pendingQuestionMulti("claude", MULTI_LATER)).toBe(true);
    expect(await pendingQuestionMulti("claude", transcript("multi-answered", [q("Pick fruits", true)], true))).toBe(false);
    // Unreadable input fails closed.
    expect(await pendingQuestionMulti("claude", transcript("odd", "not a list"))).toBe(true);
    // Codex has no AskUserQuestion.
    expect(await pendingQuestionMulti("codex", MULTI_LATER)).toBe(false);
  });
});

describe("stop and keys", () => {
  test("stop does nothing unless the agent is working", async () => {
    // Idle, by pane and stamp: nothing to stop.
    for (const [agent, pane] of [[claudeAgent(), "claude-idle-empty"], [codexAgent(), "codex-idle-empty"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await stop(tmux, "@10")).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([]);
    }
    // A dialog is up, even with the stamp saying running: Escape would answer it.
    for (const pane of ["claude-bash-permission", "claude-trust", "claude-bash-no-field"]) {
      const tmux = fakeTmux(claudeAgent({ state: "running" }), [raw(pane)]);
      expect(await stop(tmux, "@10")).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
    expect(await stop(fakeTmux(null, [raw("claude-working")]), "@10")).toEqual({ ok: false, error: "no-agent" });
    // Working on the pane, or only by the stamp (Claude streaming under a desk draft shows nothing; no interrupt in its transcript since).
    for (const [windowId, agent, pane] of [["@11", claudeAgent(), "claude-working"], ["@12", codexAgent(), "codex-working"], ["@13", claudeAgent({ state: "running", since: SINCE }), "claude-idle-draft"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await stop(tmux, windowId)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([["sendKeys", agent.paneId, ["Escape"]]]);
    }
  });

  test("a double tap on Stop sends one Escape: two would be Esc Esc", async () => {
    const first = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    const second = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    expect(await stop(first, "@14")).toEqual({ ok: true });
    expect(await stop(second, "@14")).toEqual({ ok: true });
    expect([...first.writes(), ...second.writes()]).toEqual([["sendKeys", "%1", ["Escape"]]]);
  });

  test("after an interrupt the stamp still says running: Stop has nothing to stop, and no Escape reaches the idle prompt", async () => {
    for (const [windowId, agent, pane] of [
      ["@15", claudeAgent({ state: "running", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }), "claude-idle-draft"],
      ["@16", codexAgent({ state: "running", since: SINCE, thread: { id: "thread-1", path: ABORTED } }), "codex-idle-draft"],
    ] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await stop(tmux, windowId)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([]);
    }
  });

  test("a Screen key reaches the screen the user saw, and the answer is the screen after it", async () => {
    const keys: GenericKey[] = ["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"];
    for (const key of keys) {
      // A layout no card reads: what Screen is for.
      const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission-tip")]);
      const seen = await screenNow(tmux, "@1");
      expect(seen).toMatchObject({ ansi: raw("claude-bash-permission-tip"), cols: 120, rows: 40 });
      const r = await pressKey(tmux, "@1", seen.token, key);
      expect(r).toEqual({ screen: seen });
      expect(tmux.writes()).toEqual([["sendKeys", "%1", [key]]]);
    }
    const other = fakeTmux(claudeAgent(), [""]);
    const { token } = await screenNow(other, "@1");
    for (const bad of ["C-c", "6", "enter", "Enter Enter", "", "y"]) await expect(pressKey(other, "@1", token, bad as GenericKey)).rejects.toThrow();
    expect(other.writes()).toEqual([]);
    // A tab with no agent (a shell): the window's active pane.
    const shell = fakeTmux(null, ["$ \n"]);
    const prompt = await screenNow(shell, "@3");
    shell.calls.length = 0;
    await pressKey(shell, "@3", prompt.token, "Enter");
    expect(shell.calls.slice(0, 4)).toEqual([["agentOfWindow", "@3"], ["activePane", "@3"], ["capturePane", "%9"], ["sendKeys", "%9", ["Enter"]]]);
  }, 10_000);

  test("a Screen key is refused, with the screen as it is now, once the screen it was pressed on has gone", async () => {
    /** The token for `before`, then a key pressed with it while the tab shows `after`. */
    async function press(before: Parameters<typeof fakeTmux>, after: Parameters<typeof fakeTmux>, key: GenericKey = "1") {
      const seen = await screenNow(fakeTmux(...before), "@1");
      const now = fakeTmux(...after);
      const r = await pressKey(now, "@1", seen.token, key);
      return { r, now };
    }
    // A desk key moved the dialog on: the next question, or the prompt back.
    for (const [from, to] of [["claude-question", "claude-question-2"], ["claude-bash-permission-tip", "claude-idle-empty"], ["codex-approval", "codex-idle-empty"]]) {
      const agent = from.startsWith("codex") ? codexAgent() : claudeAgent();
      const { r, now } = await press([agent, [raw(from)]], [agent, [raw(to)]]);
      expect(r).toEqual({ screen: await screenNow(fakeTmux(agent, [raw(to)]), "@1"), error: "prompt-changed" });
      expect(now.writes()).toEqual([]);
    }
    // The highlight moved at the desk (the same rows otherwise): Enter would choose another row.
    const moved = await press([claudeAgent(), [raw("claude-bash-no-card")]], [claudeAgent(), [noCardAt(3)]], "Enter");
    expect(moved.r.error).toBe("prompt-changed");
    expect(moved.now.writes()).toEqual([]);
    // Another conversation in the tab (`/clear`), the same screen: refused.
    const cleared = await press([claudeAgent(), [raw("claude-idle-empty")]], [claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), [raw("claude-idle-empty")]]);
    expect(cleared.r.error).toBe("prompt-changed");
    expect(cleared.now.writes()).toEqual([]);
    // Another agent's pane in a split window, or for a shell tab another active pane, the same text: refused.
    const split = await press([claudeAgent(), [raw("claude-idle-empty")]], [claudeAgent({ paneId: "%4" }), [raw("claude-idle-empty")]]);
    expect(split.r.error).toBe("prompt-changed");
    const shellSeen = await screenNow(fakeTmux(null, ["$ \n"]), "@3");
    const shell = fakeTmux(null, ["$ \n"]);
    shell.activePane = async (windowId: string) => { shell.calls.push(["activePane", windowId]); return "%8"; };
    expect((await pressKey(shell, "@3", shellSeen.token, "Enter")).error).toBe("prompt-changed");
    // A token for another tab.
    const elsewhere = await screenNow(fakeTmux(claudeAgent(), [raw("claude-idle-empty")]), "@2");
    const here = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    expect((await pressKey(here, "@1", elsewhere.token, "Enter")).error).toBe("prompt-changed");
    expect([...split.now.writes(), ...shell.writes(), ...here.writes()]).toEqual([]);
  }, 10_000);

  test("the statusline redrawn on its timer is no change; any other row under the prompt is", async () => {
    // Measured on Claude Code 2.1.323 with a two-row statusline refreshed every 5 s: over 75 s idle only the meter
    // row's countdowns moved (`2h22` to `2h21`, `19h02` to `19h01`, then `19h` on the hour).
    const idle = raw("claude-idle-statusline");
    const ticked = idle.replace("2h22", "2h21").replace("19h02", "19h").replace("41%", "42%").replace("▸5173 ", "▸51734");
    expect(ticked).not.toBe(idle);
    const keyAfter = async (now: string) => {
      const seen = await screenNow(fakeTmux(claudeAgent(), [idle]), "@1");
      const tmux = fakeTmux(claudeAgent(), [now]);
      return { r: await pressKey(tmux, "@1", seen.token, "Up"), writes: tmux.writes() };
    };
    expect((await keyAfter(ticked)).writes).toEqual([["sendKeys", "%1", ["Up"]]]);
    // The mode switched at the desk, words typed into the prompt, a notice drawn under it: refused.
    for (const now of [
      idle.replace("manual", "accept"),
      idle.replace("\x1b[2mTry\x1b[0m \x1b[2m\"how\x1b[0m", "hi \x1b[2m\"how\x1b[0m"),
      idle.replace(/(agents\x1b\[39m)\n/, "$1\n                  update available\n"),
    ]) {
      expect(now).not.toBe(idle);
      const { r, writes } = await keyAfter(now);
      expect(r.error).toBe("prompt-changed");
      expect(writes).toEqual([]);
    }
  });

  test("the screen after a key is taken once it settles: two reads alike, or at most about a second", async () => {
    // The key's redraw comes in a moment: the reply waits for two reads in a row that agree.
    const settling = fakeTmux(null, ["$ \n", "$ \n", "$ l\n", "$ ls\n", "$ ls\n"]);
    const { token } = await screenNow(settling, "@3");
    const r = await pressKey(settling, "@3", token, "Enter");
    expect(r.screen.ansi).toBe("$ ls\n");
    // A screen that never stops changing (a spinner, a clock) is sent as it is after about a second.
    const spinning = fakeTmux(null, Array.from({ length: 40 }, (_, k) => `$ ${k}\n`));
    spinning.capturePane = (() => { let k = 0; return async () => `$ ${k++}\n`; })();
    const first = await screenNow(spinning, "@3");
    const t0 = Date.now();
    const busy = await pressKey(spinning, "@3", first.token, "Enter");
    expect(busy.error).toBe("prompt-changed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(Date.now() - t0).toBeLessThan(1600);
  });

  test("conversationOf names Claude's session and Codex's thread", () => {
    expect(conversationOf(claudeAgent())).toBe("sess-1");
    expect(conversationOf(codexAgent())).toBe("thread-1");
    expect(conversationOf(codexAgent({ thread: undefined, daemon: true }))).toBeNull();
    expect(conversationOf(claudeAgent({ conversation: undefined }))).toBeNull();
  });
});
