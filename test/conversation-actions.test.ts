import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "../src/server/conversation/adapter";
import { answer, cleanText, conversationOf, draftFingerprint, pendingQuestionMulti, pressKey, screenNow, sendText, stop } from "../src/server/conversation/actions";
import { paneLines } from "../src/server/conversation/pane";
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
// "No, and tell Claude what to do differently" on a permission: the refusal, with the user's words, is the last row.
const STEERED = rowsFile("steered", [
  { type: "user", uuid: "u1", timestamp: "2026-11-13T10:00:00.500Z", message: { role: "user", content: "make the file" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-11-13T10:00:02.000Z", message: { content: [{ type: "tool_use", id: "toolu_s", name: "Bash", input: { command: "touch note.txt" } }] } },
  {
    type: "user", uuid: "u2", timestamp: "2026-11-13T10:00:05.000Z", toolDenialKind: "user-rejected",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s", is_error: true, content: "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nuse the other folder" }] },
  },
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
 * agent given (one, or a list); the last one repeats. A snapshot is a lookup and a capture.
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
    /** A look-up and a capture in one: the next agent and the next screen. */
    async snapshot(windowId: string, paneId: string) {
      calls.push(["snapshot", windowId, paneId]);
      return { agent: agents[Math.min(lookups++, agents.length - 1)] ?? null, active: "%9", ansi: panes[Math.min(next++, panes.length - 1)]! };
    },
    async pasteInto(paneId: string, text: string) { calls.push(["pasteInto", paneId, text]); },
    async sendKeys(paneId: string, keys: string[]) { calls.push(["sendKeys", paneId, keys]); },
    async paneSize(paneId: string) { calls.push(["paneSize", paneId]); return { cols: 120, rows: 40 }; },
  };
}

/** The prompt after a paste of "hello draft". */
const PASTED = { claude: raw("claude-idle-draft"), codex: raw("codex-idle-draft") };
/** Claude at work (a message queued) with "hello draft" typed in its box. */
const WORKING_DRAFT = raw("claude-queued").replace(/\x1b\[2m\x1b\[39mPress.*messages\x1b\[0m/u, "\x1b[39mhello draft");
/** The words each captured field holds (`claude-bash-no-text`, `-plan-change-text`, `-question-other-text`). */
const NOTE = "instead of touching the file, list the directory with ls -la and then tell me how many entries it has, and also say why\nsecond line of the note";
const CHANGE = "use the word bye instead of hi everywhere, and also add a third step that prints the file contents afterwards\nsecond line";
const PURPLE = "a deep purple close to violet, like the evening sky just after sunset, not quite blue and not quite red either\nsecond line";
/** `n` characters of `w0 w1 w2 …`: the words pasted in the lab captures. */
function spaced(n: number): string {
  let s = "";
  for (let k = 0; s.length < n; k++) s += (s ? " " : "") + `w${k}`;
  return s.slice(0, n);
}

/** The fingerprint of the desk's draft as `name` shows it: what a Replace carries back. */
const shownDraft = (kind: "claude" | "codex", ansi: string) => draftFingerprint(adapterFor(kind).readPane(ansi));
const DRAFT = { claude: shownDraft("claude", raw("claude-idle-draft")), lines: shownDraft("claude", raw("claude-idle-multiline-draft")), codex: shownDraft("codex", raw("codex-idle-draft")) };

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
    expect(await sendText(tmux, "@1", "sess-1", "hello draft", null)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);
    // The conversation is checked before anything else; each write follows a snapshot of the tab (its agent and
    // the pane, in one tmux call) taken right before it.
    expect(tmux.calls).toEqual([
      ["agentOfWindow", "@1"], ["snapshot", "@1", "%1"], ["pasteInto", "%1", "hello draft"],
      ["snapshot", "@1", "%1"], ["sendKeys", "%1", ["Enter"]],
    ]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@2", "thread-1", "hello draft", null)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["pasteInto", "%2", "hello draft"], ["sendKeys", "%2", ["Enter"]]]);

    // Claude mid-turn: its prompt takes the words while it works, and Enter queues them.
    const busy = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-working"), PASTED.claude]);
    expect(await sendText(busy, "@1", "sess-1", "hello draft", null)).toEqual({ ok: true });
    expect(busy.writes()).toEqual([["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);
  });

  test("the paste is read back before Enter: a dialog drawn meanwhile, another conversation, or no words shown, and no Enter", async () => {
    // A permission dialog drawn while the words went in: Enter would choose its option 1, usually Yes.
    const dialog = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), raw("claude-bash-permission")]);
    const codexDialog = fakeTmux(codexAgent(), [raw("codex-idle-empty"), raw("codex-approval")]);
    // /clear or a resume at the desk between the paste and Enter: another conversation, or another pane, holds the tab.
    // (The look-up, then the paste's snapshot: the third look is the one before Enter.)
    const other = fakeTmux([claudeAgent(), claudeAgent(), claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } })], [raw("claude-idle-empty"), PASTED.claude]);
    const moved = fakeTmux([claudeAgent(), claudeAgent(), claudeAgent({ paneId: "%7" })], [raw("claude-idle-empty"), PASTED.claude]);
    const gone = fakeTmux([claudeAgent(), claudeAgent(), null], [raw("claude-idle-empty"), PASTED.claude]);
    // The words never showed (the prompt still empty, or only Claude's hint for queued messages): waited out, then refused.
    const never = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    const hint = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-working"), raw("claude-queued")]);
    const all = [dialog, codexDialog, other, moved, gone, never, hint];
    const t0 = Date.now();
    const results = await Promise.all(all.map((tmux, k) => sendText(tmux, "@1", k === 1 ? "thread-1" : "sess-1", "words", null)));
    expect(results).toEqual(all.map(() => ({ ok: false, error: "unsent" })));
    for (const tmux of all) expect(tmux.writes()).toEqual([["pasteInto", tmux === codexDialog ? "%2" : "%1", "words"]]);
    // A dialog or another conversation is refused at once; words that never show, after the redraw delay.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    const quick = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), raw("claude-bash-permission")]);
    const q0 = Date.now();
    expect(await sendText(quick, "@1", "sess-1", "words", null)).toEqual({ ok: false, error: "unsent" });
    expect(Date.now() - q0).toBeLessThan(500);
  }, 10_000);

  test("Enter goes only once the prompt shows the words pasted: wrapped, or folded into the agent's own placeholder of their size", async () => {
    // Measured on Claude Code 2.1.323 and Codex 0.167.1 with these very words (lab captures).
    const lines = (n: number) => Array.from({ length: n }, (_, k) => `line ${k + 1}`).join("\n");
    for (const [agent, pane, words] of [
      // A line too long for one row, wrapped and indented.
      [claudeAgent(), "claude-pasted-long-line", spaced(800)],
      [codexAgent(), "codex-pasted-long-line", spaced(800)],
      // Claude folds a paste with three line breaks or more, or of more than 800 characters: `+3 lines` counts the breaks.
      [claudeAgent(), "claude-pasted-fold", lines(4)],
      [claudeAgent(), "claude-pasted-fold-chars", spaced(1000)],
      // Codex folds one of more than 1000 characters, and says how many.
      [codexAgent(), "codex-pasted-fold", spaced(1500)],
      // Paragraphs: Codex draws the blank line between them.
      [codexAgent(), "codex-pasted-paragraphs", "para one\n\npara two"],
    ] as const) {
      const empty = raw(agent.kind === "claude" ? "claude-idle-empty" : "codex-idle-empty");
      const tmux = fakeTmux(agent, [empty, raw(pane)]);
      expect({ pane, r: await sendText(tmux, "@1", conversationOf(agent)!, words, null) }).toEqual({ pane, r: { ok: true } });
      expect(tmux.writes()).toEqual([["pasteInto", agent.paneId, words], ["sendKeys", agent.paneId, ["Enter"]]]);
    }
  });

  test("words in the prompt that aren't the ones pasted are never sent: a desk edit, or a placeholder of another size", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, k) => `line ${k + 1}`).join("\n");
    const results = await Promise.all(([
      // The desk replaced the phone's words with its own.
      [claudeAgent(), "claude-idle-draft", "from the phone"],
      [codexAgent(), "codex-idle-draft", "from the phone"],
      // Some of the words, or more than them.
      [claudeAgent(), "claude-idle-draft", "hello"],
      [claudeAgent(), "claude-idle-multiline-draft", "draft one"],
      // A placeholder for a paste of another size: four line breaks, not three; words too short to fold.
      [claudeAgent(), "claude-pasted-fold", lines(5)],
      [claudeAgent(), "claude-pasted-fold", "line 1\nline 2"],
      [claudeAgent(), "claude-pasted-fold-chars", spaced(500)],
      [codexAgent(), "codex-pasted-fold", spaced(1400)],
    ] as const).map(async ([agent, pane, words]) => {
      const empty = raw(agent.kind === "claude" ? "claude-idle-empty" : "codex-idle-empty");
      const tmux = fakeTmux(agent, [empty, raw(pane)]);
      return { pane, words: words.slice(0, 20), r: await sendText(tmux, "@1", conversationOf(agent)!, words, null), enter: tmux.writes().length > 1 };
    }));
    for (const x of results) expect(x).toEqual({ ...x, r: { ok: false, error: "unsent" }, enter: false });
  }, 10_000);

  test("a draft at the desk is never overwritten without asking", async () => {
    const ask = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(ask, "@3", "sess-1", "from the phone", null)).toEqual({ ok: false, draft: "hello draft", draftFingerprint: DRAFT.claude });
    expect(ask.writes()).toEqual([]);

    // Replace: the draft read again right before one key clears the box, the box read again and empty, then the paste.
    const replace = fakeTmux(claudeAgent(), [raw("claude-idle-draft"), raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(replace, "@3", "sess-1", "hello draft", DRAFT.claude)).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "%1", ["C-c"]], ["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);

    const lines = fakeTmux(claudeAgent(), [raw("claude-idle-multiline-draft"), raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(lines, "@4", "sess-1", "hello draft", DRAFT.lines)).toEqual({ ok: true });
    expect(lines.writes()[0]).toEqual(["sendKeys", "%1", ["C-c"]]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-draft"), raw("codex-idle-draft"), raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@5", "thread-1", "hello draft", DRAFT.codex)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["sendKeys", "%2", ["C-c"]], ["pasteInto", "%2", "hello draft"], ["sendKeys", "%2", ["Enter"]]]);
  });

  test("Replace clears only the draft the user was shown: one changed at the desk since is shown instead", async () => {
    // Shown "hello draft"; by the Replace the desk has typed another line.
    const changed = fakeTmux(claudeAgent(), [raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(changed, "@8", "sess-1", "from the phone", DRAFT.claude)).toEqual({ ok: false, draft: "draft one\ndraft two", draftFingerprint: DRAFT.lines });
    expect(changed.writes()).toEqual([]);
    // A draft read but now unreadable, or the other way round: shown again, nothing cleared.
    const unreadable = raw("codex-idle-multiline-draft").replace("  line two", " line two");
    const toUnknown = fakeTmux(codexAgent(), [unreadable]);
    expect(await sendText(toUnknown, "@9", "thread-1", "x", DRAFT.codex)).toEqual({ ok: false, draft: "", draftFingerprint: shownDraft("codex", unreadable) });
    const toText = fakeTmux(codexAgent(), [raw("codex-idle-draft")]);
    expect(await sendText(toText, "@9", "thread-1", "x", shownDraft("codex", unreadable))).toEqual({ ok: false, draft: "hello draft", draftFingerprint: DRAFT.codex });
    expect([...toUnknown.writes(), ...toText.writes()]).toEqual([]);
    // A draft's fingerprint is its text's: another text, another fingerprint.
    expect(DRAFT.claude).not.toBe(DRAFT.lines);
    expect(DRAFT.claude).toMatch(/^[0-9a-f]{40}$/);
  });

  test("two drafts that can't be read are two drafts: Replace clears only the one shown", async () => {
    // Codex composers whose second row isn't indented as a draft's is: the text can't be read, the rows are there.
    const first = raw("codex-idle-multiline-draft").replace("  line two", " line two");
    const second = raw("codex-idle-multiline-draft").replace("  line two", " line six");
    const ask = fakeTmux(codexAgent(), [first]);
    const shown = await sendText(ask, "@27", "thread-1", "hello draft", null);
    expect(shown).toMatchObject({ ok: false, draft: "" });
    const print = (shown as { draftFingerprint: string }).draftFingerprint;
    // Changed at the desk since it was shown: shown again, nothing cleared.
    const changed = fakeTmux(codexAgent(), [second, second]);
    const again = await sendText(changed, "@28", "thread-1", "hello draft", print);
    expect(changed.writes()).toEqual([]);
    expect(again).toMatchObject({ ok: false, draft: "" });
    expect((again as { draftFingerprint: string }).draftFingerprint).not.toBe(print);
    // The same rows read again: the same draft.
    expect(print).toMatch(/^[0-9a-f]{40}$/);
    expect(draftFingerprint(adapterFor("codex").readPane(first))).toBe(print);
    expect(draftFingerprint(adapterFor("codex").readPane(second))).not.toBe(print);
    // As shown: cleared, then the words.
    const same = fakeTmux(codexAgent(), [first, first, raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(same, "@29", "thread-1", "hello draft", print)).toEqual({ ok: true });
    expect(same.writes()[0]).toEqual(["sendKeys", "%2", ["C-c"]]);
  });

  test("Claude's draft is cleared by one C-c: C-u leaves a multi-line draft's first line", () => {
    // Scratch check, Claude Code 2.1.322: C-u kills one line only and C-l leaves the draft; one C-c
    // empties a one-line, a multi-line and a `[Pasted text #1 +39 lines]` draft. While a turn runs,
    // C-c interrupts it instead and leaves the draft, so a clear is only ever sent to an idle prompt.
    // Codex 0.167.1: C-c empties the composer and a running turn carries on.
    expect(adapterFor("claude").clearDraft).toEqual(["C-c"]);
    expect(adapterFor("codex").clearDraft).toEqual(["C-c"]);
  });

  test("a second message while Claude works goes in like the first: the queued-message hint is no draft", async () => {
    // Claude Code 2.1.322 with a message queued: the empty box reads "Press up to edit queued messages", dim.
    const queued = raw("claude-queued");
    // The words typed over the hint, as Claude draws them in the box.
    const typed = WORKING_DRAFT;
    const tmux = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [queued, typed]);
    expect(await sendText(tmux, "@32", "sess-1", "hello draft", null)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);
    expect(adapterFor("claude").readPane(queued)).toMatchObject({ draft: "empty", queued: true, working: true });
    expect(adapterFor("claude").readPane(typed)).toMatchObject({ draft: "text", draftText: "hello draft" });
    // The hint alone after the paste is not the words: no Enter.
    const hint = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [queued]);
    expect(await sendText(hint, "@33", "sess-1", "hello draft", null)).toEqual({ ok: false, error: "unsent" });
    expect(hint.writes()).toEqual([["pasteInto", "%1", "hello draft"]]);
  });

  test("a draft is not replaced unless the turn is done: the clear would interrupt it", async () => {
    // The pane shows the turn running (queued messages wait on it).
    const busy = fakeTmux(claudeAgent(), [WORKING_DRAFT]);
    expect(await sendText(busy, "@6", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    // Text streaming under a draft shows no sign of work on the pane: the stamp says so, and the transcript holds no interrupt since.
    const stamped = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    expect(await sendText(stamped, "@6", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    // After "No, and tell Claude…" no tool runs, so the stamp stays `input` while the reply streams. The transcript ends
    // in the refusal carrying the user's words, which is no interrupt: the turn goes on.
    const steered = fakeTmux(claudeAgent({ state: "input", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: STEERED } }), [raw("claude-idle-draft")]);
    expect(await sendText(steered, "@6", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    expect([...busy.writes(), ...stamped.writes(), ...steered.writes()]).toEqual([]);
  });

  test("after an interrupt the stamp still says running, but the transcript says done: the draft can be replaced", async () => {
    const claude = fakeTmux(claudeAgent({ state: "running", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft"), raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(claude, "@20", "sess-1", "hello draft", DRAFT.claude)).toEqual({ ok: true });
    expect(claude.writes()).toEqual([["sendKeys", "%1", ["C-c"]], ["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);
    // Esc on a permission prompt leaves the stamp at `input`, with the same line in the transcript.
    const waiting = fakeTmux(claudeAgent({ state: "input", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft"), raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(waiting, "@21", "sess-1", "hello draft", DRAFT.claude)).toEqual({ ok: true });
    const codex = fakeTmux(codexAgent({ state: "running", since: SINCE, thread: { id: "thread-1", path: ABORTED } }), [raw("codex-idle-draft"), raw("codex-idle-draft"), raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(codex, "@22", "thread-1", "hello draft", DRAFT.codex)).toEqual({ ok: true });
    expect(codex.writes()[0]).toEqual(["sendKeys", "%2", ["C-c"]]);
    // An interrupt from before the stamp is an earlier turn's: this one runs.
    const later = fakeTmux(claudeAgent({ state: "running", since: SINCE + 60, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }),
      [raw("claude-idle-draft")]);
    expect(await sendText(later, "@23", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    expect(later.writes()).toEqual([]);
  });

  test("after a Stop before any output the stamp still says running, but the turn is over: the prompt put back can be replaced", async () => {
    // Esc before Claude wrote anything: no transcript row, no hook, and the prompt's words back in the box.
    const agent = claudeAgent({ state: "running", since: Math.floor(Date.now() / 1000) - 60 });
    const stopping = fakeTmux(agent, [raw("claude-working")]);
    expect(await stop(stopping, "@30", "sess-1")).toEqual({ ok: true });
    expect(stopping.writes()).toEqual([["sendKeys", "%1", ["Escape"]]]);
    const replace = fakeTmux(agent, [raw("claude-idle-draft"), raw("claude-idle-draft"), raw("claude-idle-empty"), PASTED.claude]);
    expect(await sendText(replace, "@30", "sess-1", "hello draft", DRAFT.claude)).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "%1", ["C-c"]], ["pasteInto", "%1", "hello draft"], ["sendKeys", "%1", ["Enter"]]]);
    // While the pane still shows it working (the Escape not taken yet), or for a stamp newer than the Stop, it runs.
    const busy = fakeTmux(agent, [WORKING_DRAFT]);
    expect(await sendText(busy, "@30", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    const next = fakeTmux(claudeAgent({ state: "running", since: Math.floor(Date.now() / 1000) + 1 }), [raw("claude-idle-draft")]);
    expect(await sendText(next, "@30", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
    // Another tab's Stop says nothing about this one.
    const other = fakeTmux(agent, [raw("claude-idle-draft")]);
    expect(await sendText(other, "@31", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "working" });
  });

  test("a clear that doesn't take sends nothing more, and a second C-c never follows", async () => {
    const stuck = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(stuck, "@7", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "prompt-changed" });
    expect(stuck.writes()).toEqual([["sendKeys", "%1", ["C-c"]]]);
    // Asked again at once: a second C-c would quit Claude.
    const again = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(again, "@7", "sess-1", "x", DRAFT.claude)).toEqual({ ok: false, error: "prompt-changed" });
    expect(again.writes()).toEqual([]);
  });

  test("a message for another conversation is refused", async () => {
    const other = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), [raw("claude-idle-empty")]);
    expect(await sendText(other, "@1", "sess-1", "hi", null)).toEqual({ ok: false, error: "another-conversation" });
    expect(other.calls).toEqual([["agentOfWindow", "@1"]]);
    const thread = fakeTmux(codexAgent({ thread: { id: "thread-2" } }), [raw("codex-idle-empty")]);
    expect(await sendText(thread, "@2", "thread-1", "hi", "unknown")).toEqual({ ok: false, error: "another-conversation" });
    expect(thread.writes()).toEqual([]);
    // A tab whose conversation can't be named can't be checked: refused too.
    const fresh = fakeTmux(codexAgent({ thread: undefined, fresh: true }), [raw("codex-idle-empty")]);
    expect(await sendText(fresh, "@2", "thread-1", "hi", null)).toEqual({ ok: false, error: "another-conversation" });
    const none = fakeTmux(null, [raw("claude-idle-empty")]);
    expect(await sendText(none, "@1", "sess-1", "hi", null)).toEqual({ ok: false, error: "no-agent" });
    expect([...fresh.writes(), ...none.writes()]).toEqual([]);
  });

  test("a desk prompt that can't be read is asked about as if it held text, and Replace clears it before the paste", async () => {
    // A composer row that isn't indented as Codex indents a draft's lines: the draft can't be read.
    const unreadable = raw("codex-idle-multiline-draft").replace("  line two", " line two");
    expect(adapterFor("codex").readPane(unreadable)).toMatchObject({ dialog: null, unrecognised: false, draft: "unknown" });
    const ask = fakeTmux(codexAgent(), [unreadable]);
    expect(await sendText(ask, "@24", "thread-1", "x", null)).toEqual({ ok: false, draft: "", draftFingerprint: shownDraft("codex", unreadable) });
    expect(ask.writes()).toEqual([]);
    const replace = fakeTmux(codexAgent(), [unreadable, unreadable, raw("codex-idle-empty"), PASTED.codex]);
    expect(await sendText(replace, "@25", "thread-1", "hello draft", shownDraft("codex", unreadable))).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "%2", ["C-c"]], ["pasteInto", "%2", "hello draft"], ["sendKeys", "%2", ["Enter"]]]);
    // Not read as empty after the clear: nothing is pasted.
    const stuck = fakeTmux(codexAgent(), [unreadable]);
    expect(await sendText(stuck, "@26", "thread-1", "x", shownDraft("codex", unreadable))).toEqual({ ok: false, error: "prompt-changed" });
    expect(stuck.writes()).toEqual([["sendKeys", "%2", ["C-c"]]]);
  });

  test("no text goes into a dialog", async () => {
    for (const [agent, pane] of [[claudeAgent(), "claude-bash-permission"], [claudeAgent(), "claude-trust"], [claudeAgent(), "claude-bash-no-field"], [codexAgent(), "codex-approval"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await sendText(tmux, "@1", conversationOf(agent)!, "1", "unknown")).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
  });

  test("control characters never reach the pane", async () => {
    expect(cleanText("a\x1b[201~b\x07\nc")).toBe("a[201~b\nc");
    expect(cleanText("tab\there\r\nnext\x7f\x00")).toBe("tab\there\nnext");
    // C1 controls too: \x9b is CSI on its own.
    expect(cleanText("a\x9b201~b\x85c\x80\x9fd é")).toBe("a201~bcd é");
    const tmux = fakeTmux(claudeAgent(), [raw("claude-idle-empty"), PASTED.claude.replace("hello draft", "one[201~[2Jtwo")]);
    expect(await sendText(tmux, "@1", "sess-1", "one\x1b[201~\x1b[2Jtwo", null)).toEqual({ ok: true });
    expect(tmux.writes()[0]).toEqual(["pasteInto", "%1", "one[201~[2Jtwo"]);
    // Nothing left to send: nothing is typed, not even Enter.
    const empty = fakeTmux(claudeAgent(), [raw("claude-idle-suggestion")]);
    expect(await sendText(empty, "@1", "sess-1", "\x1b\x07 \n", null)).toEqual({ ok: true });
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
    expect(await answer(tmux, "@1", "sess-1", print("claude", "bash-no-card"), 4, NOTE.replace("list the", "list\x1b the"))).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([
      ["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]],
      ["pasteInto", "%1", NOTE],
      ["sendKeys", "%1", ["Enter"]],
    ]);
    // A snapshot of the tab (its agent and the pane) right before each write: the keys, the paste and Enter.
    expect(tmux.calls.map((c) => c[0])).toEqual(["agentOfWindow", "snapshot", "sendKeys", "snapshot", "pasteInto", "snapshot", "sendKeys"]);
    // The list wraps (Down on the last row goes to row 1), so the moves start from the highlight the pane shows.
    for (const [at, keys] of [[3, ["Down", "Tab"]], [4, ["Tab"]]] as const) {
      const moved = fakeTmux(claudeAgent(), [noCardAt(at), raw("claude-bash-no-field"), raw("claude-bash-no-text")]);
      expect(await answer(moved, "@1", "sess-1", print("claude", "bash-no-card"), 4, NOTE)).toEqual({ ok: true });
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

  test("a field's Enter goes only on the words pasted into it: the desk's edit in between is refused unsent", async () => {
    // Each field as the desk left it after the phone's paste: other words in place of the phone's.
    for (const [card, field, typed, option, words, edit] of [
      ["bash-no-card", "bash-no-field", "bash-no-text", 4, NOTE, ["instead of touching", "rather than touching"]],
      ["plan-change-card", "plan-change-field", "plan-change-text", 3, CHANGE, ["second line", "second idea"]],
      ["question", "question-other-field", "question-other-text", 4, PURPLE, ["a deep purple", "a pale purple"]],
      ["question-single-plan", "question-single-field", "question-single-text", 3, "kiwi", ["kiwi", "lime"]],
    ] as const) {
      const desk = raw(`claude-${typed}`).replace(edit[0], edit[1]);
      expect(desk).not.toBe(raw(`claude-${typed}`));
      const tmux = fakeTmux(claudeAgent(), [raw(`claude-${card}`), raw(`claude-${field}`), desk]);
      expect({ card, r: await answer(tmux, "@1", "sess-1", print("claude", card), option, words) }).toEqual({ card, r: { ok: false, error: "unsent" } });
      expect(tmux.writes().map((w) => w[0])).toEqual(["sendKeys", "pasteInto"]);
    }
    // Part of the words, or more than them, is not them either.
    const short = fakeTmux(claudeAgent(), [raw("claude-bash-no-card"), raw("claude-bash-no-field"), raw("claude-bash-no-text")]);
    expect(await answer(short, "@1", "sess-1", print("claude", "bash-no-card"), 4, NOTE.split("\n")[0]!)).toEqual({ ok: false, error: "unsent" });
    expect(short.writes().map((w) => w[0])).toEqual(["sendKeys", "pasteInto"]);
  }, 20_000);

  test("the words go into the field only while it is empty: one holding the desk's words gets nothing", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-no-card"), raw("claude-bash-no-text")]);
    expect(await answer(tmux, "@1", "sess-1", print("claude", "bash-no-card"), 4, NOTE)).toEqual({ ok: false, error: "prompt-changed" });
    expect(tmux.writes()).toEqual([["sendKeys", "%1", ["Down", "Down", "Down", "Tab"]]]);
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
    const other = fakeTmux([claudeAgent(), claudeAgent(), claudeAgent(), claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } })],
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
    expect(await answer(plan, "@1", "sess-1", print("claude", "plan-change-card"), 3, CHANGE)).toEqual({ ok: true });
    expect(plan.writes()).toEqual([["sendKeys", "%1", ["Down", "Down"]], ["pasteInto", "%1", CHANGE], ["sendKeys", "%1", ["Enter"]]]);

    const approve = fakeTmux(claudeAgent(), [raw("claude-plan")]);
    expect(await answer(approve, "@1", "sess-1", print("claude", "plan"), 2)).toEqual({ ok: true });
    expect(approve.writes()).toEqual([["sendKeys", "%1", ["2"]]]);

    const question = fakeTmux(claudeAgent(), [raw("claude-question"), raw("claude-question-other-field"), raw("claude-question-other-text")]);
    expect(await answer(question, "@1", "sess-1", print("claude", "question"), 4, PURPLE)).toEqual({ ok: true });
    expect(question.writes()).toEqual([["sendKeys", "%1", ["4"]], ["pasteInto", "%1", PURPLE], ["sendKeys", "%1", ["Enter"]]]);

    // A call with one question: the same keys, and Enter submits it at once (no review step).
    const single = fakeTmux(claudeAgent(), [raw("claude-question-single-plan"), raw("claude-question-single-field"), raw("claude-question-single-text")]);
    expect(await answer(single, "@1", "sess-1", print("claude", "question-single-plan"), 3, "kiwi")).toEqual({ ok: true });
    expect(single.writes()).toEqual([["sendKeys", "%1", ["3"]], ["pasteInto", "%1", "kiwi"], ["sendKeys", "%1", ["Enter"]]]);
    // An answer of several lines, a blank one and a numbered one among them.
    const lines = fakeTmux(claudeAgent(), [raw("claude-question-single-plan"), raw("claude-question-single-field"), raw("claude-question-single-text-lines")]);
    expect(await answer(lines, "@1", "sess-1", print("claude", "question-single-plan"), 3, "kiwi\n\n1. ripe one\nthanks")).toEqual({ ok: true });
    expect(lines.writes().at(-1)).toEqual(["sendKeys", "%1", ["Enter"]]);
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
    expect(await answer(tmux, "@2", "thread-1", print("codex", "approval"), 3, "hello draft")).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "%2", ["Escape"]], ["pasteInto", "%2", "hello draft"], ["sendKeys", "%2", ["Enter"]]]);
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
      expect(await stop(tmux, "@10", conversationOf(agent)!)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([]);
    }
    // A dialog is up, even with the stamp saying running: Escape would answer it.
    for (const pane of ["claude-bash-permission", "claude-trust", "claude-bash-no-field"]) {
      const tmux = fakeTmux(claudeAgent({ state: "running" }), [raw(pane)]);
      expect(await stop(tmux, "@10", "sess-1")).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
    expect(await stop(fakeTmux(null, [raw("claude-working")]), "@10", "sess-1")).toEqual({ ok: false, error: "no-agent" });
    // Working on the pane, or only by the stamp (Claude streaming under a desk draft shows nothing; no interrupt in its transcript since).
    for (const [windowId, agent, pane] of [["@11", claudeAgent(), "claude-working"], ["@12", codexAgent(), "codex-working"], ["@13", claudeAgent({ state: "running", since: SINCE }), "claude-idle-draft"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await stop(tmux, windowId, conversationOf(agent)!)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([["sendKeys", agent.paneId, ["Escape"]]]);
    }
  });

  test("a Stop for another conversation is refused before any Escape", async () => {
    // A delayed tap meant for the conversation before a /clear, a resume or a new agent in the tab.
    for (const [agent, conversation] of [
      [claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), "sess-1"],
      [codexAgent({ thread: { id: "thread-2" } }), "thread-1"],
      // A tab whose conversation can't be named can't be checked: refused too.
      [codexAgent({ thread: undefined, fresh: true }), "thread-1"],
    ] as const) {
      const tmux = fakeTmux(agent, [raw(agent.kind === "claude" ? "claude-working" : "codex-working")]);
      expect(await stop(tmux, "@17", conversation)).toEqual({ ok: false, error: "another-conversation" });
      expect(tmux.writes()).toEqual([]);
      expect(tmux.calls).toEqual([["agentOfWindow", "@17"]]);
    }
  });

  test("a fresh Codex with no thread yet can be stopped: the view and the tab both name none", async () => {
    const fresh = codexAgent({ thread: undefined, fresh: true, state: undefined });
    const tmux = fakeTmux(fresh, [raw("codex-working")]);
    expect(await stop(tmux, "@34", null)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "%2", ["Escape"]]]);
    // None named while the tab holds one, or a Claude tab (it always names its session): refused, no Escape.
    for (const agent of [codexAgent(), claudeAgent({ conversation: undefined })]) {
      const other = fakeTmux(agent, [raw(agent.kind === "claude" ? "claude-working" : "codex-working")]);
      expect(await stop(other, "@35", null)).toEqual({ ok: false, error: "another-conversation" });
      expect(other.writes()).toEqual([]);
    }
  });

  test("a double tap on Stop sends one Escape: two would be Esc Esc", async () => {
    const first = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    const second = fakeTmux(claudeAgent({ state: "running", since: SINCE }), [raw("claude-idle-draft")]);
    expect(await stop(first, "@14", "sess-1")).toEqual({ ok: true });
    expect(await stop(second, "@14", "sess-1")).toEqual({ ok: true });
    expect([...first.writes(), ...second.writes()]).toEqual([["sendKeys", "%1", ["Escape"]]]);
  });

  test("after an interrupt the stamp still says running: Stop has nothing to stop, and no Escape reaches the idle prompt", async () => {
    for (const [windowId, agent, pane] of [
      ["@15", claudeAgent({ state: "running", since: SINCE, conversation: { sessionId: "sess-1", transcriptPath: INTERRUPTED } }), "claude-idle-draft"],
      ["@16", codexAgent({ state: "running", since: SINCE, thread: { id: "thread-1", path: ABORTED } }), "codex-idle-draft"],
    ] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      expect(await stop(tmux, windowId, conversationOf(agent)!)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([]);
    }
  });

  test("a Screen key reaches the screen the user saw, and the answer is the screen after it", async () => {
    const keys: GenericKey[] = ["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"];
    for (const key of keys) {
      // A permission as Claude Code 2.1.323 draws it with a tip and a description (a card too: Screen works on any screen).
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
    expect(shell.calls.slice(0, 4)).toEqual([["agentOfWindow", "@3"], ["activePane", "@3"], ["snapshot", "@3", "%9"], ["sendKeys", "%9", ["Enter"]]]);
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

  test("a Screen key is refused when only how the screen is drawn changed: a placeholder became words, a highlight moved", async () => {
    /** A key pressed with the token for `before` while the tab shows `now`, which has the same text. */
    const keyAfter = async (agent: WindowAgentInfo | null, before: string, now: string) => {
      expect(now).not.toBe(before);
      expect(paneLines(now).map((l) => l.text)).toEqual(paneLines(before).map((l) => l.text));
      const seen = await screenNow(fakeTmux(agent, [before]), "@1");
      const tmux = fakeTmux(agent, [now]);
      const r = await pressKey(tmux, "@1", seen.token, "Enter");
      return { error: r.error, writes: tmux.writes() };
    };
    const refused = { error: "prompt-changed" as const, writes: [] };
    // Codex's dim placeholder, then the same words typed at the desk: Enter would send them.
    const placeholder = raw("codex-idle-empty");
    expect(await keyAfter(codexAgent(), placeholder, placeholder.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "Ask Codex to do anything"))).toEqual(refused);
    // A question's tab bar with the highlight moved to the next tab: Enter would answer another question.
    const tabs = raw("claude-question");
    const lit = "\x1b[38;2;0;0;0m\x1b[48;2;153;204;255m";
    expect(await keyAfter(claudeAgent(), tabs, tabs.replace(`${lit} ☐ Colour \x1b[39m\x1b[49m ☐ Size  ✔`, ` ☐ Colour ${lit} ☐ Size \x1b[39m\x1b[49m ✔`))).toEqual(refused);
    // A shell's menu whose selection is reverse video, and bold and colour alone.
    expect(await keyAfter(null, "\x1b[7m one \x1b[0m two \n", " one \x1b[7m two \x1b[0m\n")).toEqual(refused);
    expect(await keyAfter(null, "pick one\n", "pick \x1b[1mone\x1b[0m\n")).toEqual(refused);
    expect(await keyAfter(null, "pick \x1b[38;5;2mone\x1b[39m\n", "pick \x1b[38;5;1mone\x1b[39m\n")).toEqual(refused);
  });

  test("a space's colour is not drawn, so it is no change: Claude redraws its footer with and without it", async () => {
    // Claude Code 2.1.323, a working turn a second apart: the same footer, its spaces coloured or not.
    const one = "  \x1b[38;5;246m⏸ manual mode on · esc to interrupt\x1b[39m\n";
    const two = "  \x1b[38;5;246m⏸\x1b[39m \x1b[38;5;246mmanual\x1b[39m \x1b[38;5;246mmode\x1b[39m \x1b[38;5;246mon\x1b[39m \x1b[38;5;246m·\x1b[39m \x1b[38;5;246mesc\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246minterrupt\x1b[39m\n";
    const seen = await screenNow(fakeTmux(null, [one]), "@1");
    const tmux = fakeTmux(null, [two]);
    expect((await pressKey(tmux, "@1", seen.token, "Up")).error).toBeUndefined();
    expect(tmux.writes()).toEqual([["sendKeys", "%9", ["Up"]]]);
  });

  test("the statusline redrawn on its timer is no change; any other row under the prompt is", async () => {
    // Measured on Claude Code 2.1.323 with a two-row statusline refreshed every 5 s: over 75 s idle only the meter
    // row's countdowns moved (`2h22` to `2h21`, `19h02` to `19h01`, then `19h` on the hour).
    const idle = raw("claude-idle-statusline");
    const ticked = idle.replace("2h22", "2h21").replace("19h02", "19h").replace("41%", "42%");
    expect(ticked).not.toBe(idle);
    const keyAfter = async (now: string) => {
      const seen = await screenNow(fakeTmux(claudeAgent(), [idle]), "@1");
      const tmux = fakeTmux(claudeAgent(), [now]);
      return { r: await pressKey(tmux, "@1", seen.token, "Up"), writes: tmux.writes() };
    };
    expect((await keyAfter(ticked)).writes).toEqual([["sendKeys", "%1", ["Up"]]]);
    // The mode switched at the desk, words typed into the prompt, a notice drawn under it: refused. So is a digit
    // that changed in a row under the box holding no meter (never seen to tick): the agents' count, a port, a list.
    for (const now of [
      idle.replace("manual", "accept"),
      idle.replace("\x1b[2mTry\x1b[0m \x1b[2m\"how\x1b[0m", "hi \x1b[2m\"how\x1b[0m"),
      idle.replace(/(agents\x1b\[39m)\n/, "$1\n                  update available\n"),
      idle.replace(/(\x1b\[38;5;246m)2(\x1b\[39m \x1b\[38;5;246magents)/, "$13$2"),
      idle.replace("▸5173 ", "▸5174 "),
    ]) {
      expect(now).not.toBe(idle);
      const { r, writes } = await keyAfter(now);
      expect(r.error).toBe("prompt-changed");
      expect(writes).toEqual([]);
    }
    // A list under the box (a `/` command's choices) whose count moved on.
    const listed = idle.replace(/(agents\x1b\[39m)\n/, "$1\n  /compact   keep a summary (1 of 3)\n");
    const seen = await screenNow(fakeTmux(claudeAgent(), [listed]), "@1");
    const moved = fakeTmux(claudeAgent(), [listed.replace("(1 of 3)", "(2 of 3)")]);
    expect((await pressKey(moved, "@1", seen.token, "Enter")).error).toBe("prompt-changed");
    expect(moved.writes()).toEqual([]);
  });

  test("the agent's own working row ticking is no change: its timer, its glyph, its shimmer; any other change is", async () => {
    /** A key pressed with the token for `before` while the tab shows `now`. */
    const keyAfter = async (agent: WindowAgentInfo, before: string, now: string) => {
      expect(now).not.toBe(before);
      const seen = await screenNow(fakeTmux(agent, [before]), "@1");
      const tmux = fakeTmux(agent, [now]);
      return { error: (await pressKey(tmux, "@1", seen.token, "Escape")).error, writes: tmux.writes().length };
    };
    const pressed = { error: undefined, writes: 1 };
    const refused = { error: "prompt-changed" as const, writes: 0 };
    // Claude Code 2.1.323, a second apart: the glyph cycles (✽ ✳ ✢ · ✶), one letter of the verb shimmers, the elapsed
    // time and the token count move on, the arrow turns.
    const claude = raw("claude-working");
    const spinner = "\x1b[38;2;255;153;51m·\x1b[39m \x1b[38;2;255;161;64mManifesting…\x1b[38;2;255;153;51m \x1b[38;2;153;153;153m(6s · ↓\x1b[39m \x1b[38;2;153;153;153m25 tokens)\x1b[39m";
    expect(claude).toContain(spinner);
    const ticked = "\x1b[38;2;255;153;51m✽\x1b[39m \x1b[38;2;255;161;64mManif\x1b[38;2;255;183;101me\x1b[38;2;255;161;64msting…\x1b[38;2;255;153;51m \x1b[38;2;153;153;153m(1m 7s · ↑\x1b[39m \x1b[38;2;153;153;153m1.2k tokens)\x1b[39m";
    expect(await keyAfter(claudeAgent(), claude, claude.replace(spinner, ticked))).toEqual(pressed);
    // While it thinks (measured over two turns): `(2s · thinking)`, then `(9s · still thinking)`, then the tokens.
    const thinking = spinner.replace("(6s · ↓\x1b[39m \x1b[38;2;153;153;153m25 tokens)", "(2s · thinking)");
    expect(thinking).not.toBe(spinner);
    expect(await keyAfter(claudeAgent(), claude.replace(spinner, thinking), claude.replace(spinner, thinking.replace("(2s · thinking)", "(9s · still thinking)")))).toEqual(pressed);
    expect(await keyAfter(claudeAgent(), claude.replace(spinner, thinking), claude.replace(spinner, ticked))).toEqual(pressed);
    // Codex 0.167.1: the elapsed time, and the bullet's colour pulsing.
    const codex = raw("codex-working");
    const working = "\x1b[1m\x1b[38;2;128;128;128m•\x1b[0m \x1b[2mWorking\x1b[0m \x1b[2m(7s • \x1b[0;1mesc\x1b[0;2m to interrupt)\x1b[0m";
    expect(codex).toContain(working);
    expect(await keyAfter(codexAgent(), codex, codex.replace(working, working.replace("128;128;128", "231;231;231").replace("(7s", "(1m 09s")))).toEqual(pressed);
    // Anything else in those rows, or anywhere else, is a change: another verb, words after the timer, the prompt typed in.
    expect(await keyAfter(claudeAgent(), claude, claude.replace(spinner, spinner.replace("Manifesting", "Compacting")))).toEqual(refused);
    expect(await keyAfter(claudeAgent(), claude, claude.replace(spinner, spinner.replace("tokens)", "tokens · thinking)")))).toEqual(refused);
    expect(await keyAfter(codexAgent(), codex, codex.replace(working, working.replace("Working", "Waiting")))).toEqual(refused);
    expect(await keyAfter(codexAgent(), codex, codex.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "Ask Codex to do anything"))).toEqual(refused);
  });

  test("the screen after a key is taken once it settles: two reads alike, or at most about a second", async () => {
    // The key's redraw comes in a moment: the reply waits for two reads in a row that agree.
    const settling = fakeTmux(null, ["$ \n", "$ \n", "$ l\n", "$ ls\n", "$ ls\n"]);
    const { token } = await screenNow(settling, "@3");
    const r = await pressKey(settling, "@3", token, "Enter");
    expect(r.screen.ansi).toBe("$ ls\n");
    // A screen that never stops changing (a spinner, a clock) is sent as it is after about a second.
    const spinning = fakeTmux(null, Array.from({ length: 40 }, (_, k) => `$ ${k}\n`));
    let k = 0;
    spinning.capturePane = async () => `$ ${k++}\n`;
    spinning.snapshot = async () => ({ agent: null, active: "%9", ansi: `$ ${k++}\n` });
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
