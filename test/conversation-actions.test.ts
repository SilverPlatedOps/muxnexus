import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "../src/server/conversation/adapter";
import { answer, cleanText, conversationOf, pendingQuestionMulti, pressKey, sendText, stop } from "../src/server/conversation/actions";
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

const claudeAgent = (over: Partial<WindowAgentInfo> = {}): WindowAgentInfo => ({
  paneId: "%1", kind: "claude", state: "done", conversation: { sessionId: "sess-1", transcriptPath: SINGLE }, ...over,
});
const codexAgent = (over: Partial<WindowAgentInfo> = {}): WindowAgentInfo => ({ paneId: "%2", kind: "codex", state: "done", thread: { id: "thread-1" }, ...over });

/** A tmux that records every call in order. Each capture returns the next pane given; the last one repeats. */
function fakeTmux(agent: WindowAgentInfo | null, panes: string[]) {
  const calls: unknown[][] = [];
  let next = 0;
  return {
    calls,
    writes: () => calls.filter((c) => c[0] === "pasteInto" || c[0] === "sendKeys"),
    async agentOfWindow(windowId: string) { calls.push(["agentOfWindow", windowId]); return agent; },
    async capturePane(windowId: string) { calls.push(["capturePane", windowId]); return panes[Math.min(next++, panes.length - 1)]!; },
    async pasteInto(windowId: string, text: string) { calls.push(["pasteInto", windowId, text]); },
    async sendKeys(windowId: string, keys: string[]) { calls.push(["sendKeys", windowId, keys]); },
  };
}

const print = (kind: "claude" | "codex", name: string) => adapterFor(kind).readPane(raw(`${kind}-${name}`)).dialog!.fingerprint;

/** The permission capture with the highlight moved from row 1 to row `to`, as a desk keypress would leave it. */
const permissionAt = (to: number) => raw("claude-bash-permission")
  .replace("\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1.")
  .replace(`   \x1b[38;2;153;153;153m${to}.`, ` \x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m${to}.`);

describe("send", () => {
  test("send pastes then presses Enter", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    expect(await sendText(tmux, "@1", "sess-1", "line one\nline two", false)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["pasteInto", "@1", "line one\nline two"], ["sendKeys", "@1", ["Enter"]]]);
    // The conversation is checked before the pane is read, and the pane before anything is written.
    expect(tmux.calls.map((c) => c[0])).toEqual(["agentOfWindow", "capturePane", "pasteInto", "sendKeys"]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-empty")]);
    expect(await sendText(codex, "@2", "thread-1", "hello", false)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["pasteInto", "@2", "hello"], ["sendKeys", "@2", ["Enter"]]]);
  });

  test("a draft at the desk is never overwritten without asking", async () => {
    const ask = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(ask, "@3", "sess-1", "from the phone", false)).toEqual({ ok: false, draft: "hello draft" });
    expect(ask.writes()).toEqual([]);

    // Replace: one key clears the box, the box is read again and must be empty, then the paste.
    const replace = fakeTmux(claudeAgent(), [raw("claude-idle-draft"), raw("claude-idle-empty")]);
    expect(await sendText(replace, "@3", "sess-1", "from the phone", true)).toEqual({ ok: true });
    expect(replace.writes()).toEqual([["sendKeys", "@3", ["C-c"]], ["pasteInto", "@3", "from the phone"], ["sendKeys", "@3", ["Enter"]]]);

    const lines = fakeTmux(claudeAgent(), [raw("claude-idle-multiline-draft"), raw("claude-idle-empty")]);
    expect(await sendText(lines, "@4", "sess-1", "x", true)).toEqual({ ok: true });
    expect(lines.writes()[0]).toEqual(["sendKeys", "@4", ["C-c"]]);

    const codex = fakeTmux(codexAgent(), [raw("codex-idle-draft"), raw("codex-idle-empty")]);
    expect(await sendText(codex, "@5", "thread-1", "x", true)).toEqual({ ok: true });
    expect(codex.writes()).toEqual([["sendKeys", "@5", ["C-c"]], ["pasteInto", "@5", "x"], ["sendKeys", "@5", ["Enter"]]]);
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
    // Text streaming under a draft shows no sign of work on the pane: the stamp says so.
    const stamped = fakeTmux(claudeAgent({ state: "running" }), [raw("claude-idle-draft")]);
    expect(await sendText(stamped, "@6", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    // After "No, and tell Claude…" no tool runs, so the stamp stays `input` while the reply streams.
    const steered = fakeTmux(claudeAgent({ state: "input" }), [raw("claude-idle-draft")]);
    expect(await sendText(steered, "@6", "sess-1", "x", true)).toEqual({ ok: false, error: "working" });
    expect([...busy.writes(), ...stamped.writes(), ...steered.writes()]).toEqual([]);
  });

  test("a clear that doesn't take sends nothing more, and a second C-c never follows", async () => {
    const stuck = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(stuck, "@7", "sess-1", "x", true)).toEqual({ ok: false, error: "prompt-changed" });
    expect(stuck.writes()).toEqual([["sendKeys", "@7", ["C-c"]]]);
    // Asked again at once: a second C-c would quit Claude.
    const again = fakeTmux(claudeAgent(), [raw("claude-idle-draft")]);
    expect(await sendText(again, "@7", "sess-1", "x", true)).toEqual({ ok: false, error: "prompt-changed" });
    expect(again.writes()).toEqual([]);
  });

  test("a message for another conversation is refused", async () => {
    const other = fakeTmux(claudeAgent({ conversation: { sessionId: "sess-2", transcriptPath: SINGLE } }), [raw("claude-idle-empty")]);
    expect(await sendText(other, "@1", "sess-1", "hi", false)).toEqual({ ok: false, error: "another-conversation" });
    expect(other.writes()).toEqual([]);
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

  test("no text goes into a dialog", async () => {
    for (const [agent, pane] of [[claudeAgent(), "claude-bash-permission"], [claudeAgent(), "claude-trust"], [codexAgent(), "codex-approval"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      const conv = conversationOf(agent)!;
      expect(await sendText(tmux, "@1", conv, "1", true)).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
  });

  test("control characters never reach the pane", async () => {
    expect(cleanText("a\x1b[201~b\x07\nc")).toBe("a[201~b\nc");
    expect(cleanText("tab\there\r\nnext\x7f\x00")).toBe("tab\there\nnext");
    const tmux = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    expect(await sendText(tmux, "@1", "sess-1", "one\x1b[201~\x1b[2Jtwo", false)).toEqual({ ok: true });
    expect(tmux.writes()[0]).toEqual(["pasteInto", "@1", "one[201~[2Jtwo"]);
    // Nothing left to send: nothing is typed, not even Enter.
    const empty = fakeTmux(claudeAgent(), [raw("claude-idle-suggestion")]);
    expect(await sendText(empty, "@1", "sess-1", "\x1b\x07 \n", false)).toEqual({ ok: true });
    expect(empty.writes()).toEqual([]);
  });
});

describe("answer", () => {
  test("an answer to a changed prompt sends nothing", async () => {
    const changed = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
    expect(await answer(changed, "@1", "0".repeat(40), 1)).toEqual({ ok: false, error: "prompt-changed" });
    // Answered at the desk: the prompt is back.
    const gone = fakeTmux(claudeAgent(), [raw("claude-idle-empty")]);
    expect(await answer(gone, "@1", print("claude", "bash-permission"), 1)).toEqual({ ok: false, error: "prompt-changed" });
    expect([...changed.calls, ...gone.calls].filter((c) => c[0] === "sendKeys" || c[0] === "pasteInto")).toEqual([]);
  });

  test("an approved Bash prompt is one digit, no Enter", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
    expect(await answer(tmux, "@1", print("claude", "bash-permission"), 1)).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "@1", ["1"]]]);
    // A plain No is its digit too, wherever the highlight is.
    const no = fakeTmux(claudeAgent(), [permissionAt(2)]);
    expect(await answer(no, "@1", print("claude", "bash-permission"), 4)).toEqual({ ok: true });
    expect(no.writes()).toEqual([["sendKeys", "@1", ["4"]]]);
  });

  test("a choice the card doesn't offer, or words for a choice that takes none, sends nothing", async () => {
    for (const [option, text] of [[5, undefined], [0, undefined], [1.5, undefined], [1, "and also this"]] as const) {
      const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
      expect(await answer(tmux, "@1", print("claude", "bash-permission"), option, text)).toEqual({ ok: false, error: "prompt-changed" });
      expect(tmux.writes()).toEqual([]);
    }
    // The plan's feedback row and a question's "Type something." are fields: nothing to choose without words.
    const plan = fakeTmux(claudeAgent(), [raw("claude-plan")]);
    expect(await answer(plan, "@1", print("claude", "plan"), 3)).toEqual({ ok: false, error: "prompt-changed" });
    const question = fakeTmux(claudeAgent(), [raw("claude-question")]);
    expect(await answer(question, "@1", print("claude", "question"), 4, "  ")).toEqual({ ok: false, error: "prompt-changed" });
    expect([...plan.writes(), ...question.writes()]).toEqual([]);
  });

  test("No with words: down from the highlighted row, Tab, then the words once the field has focus", async () => {
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission"), raw("claude-bash-permission-amend")]);
    expect(await answer(tmux, "@1", print("claude", "bash-permission"), 4, "instead reply\x1b only ok")).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([
      ["sendKeys", "@1", ["Down", "Down", "Down", "Tab"]],
      ["pasteInto", "@1", "instead reply only ok"],
      ["sendKeys", "@1", ["Enter"]],
    ]);
    // The list wraps (Down on the last row goes to row 1), so the moves start from the highlight the pane shows.
    for (const [at, keys] of [[3, ["Down", "Tab"]], [4, ["Tab"]]] as const) {
      const moved = fakeTmux(claudeAgent(), [permissionAt(at), raw("claude-bash-permission-amend")]);
      expect(await answer(moved, "@1", print("claude", "bash-permission"), 4, "words")).toEqual({ ok: true });
      expect(moved.writes()[0]).toEqual(["sendKeys", "@1", keys]);
    }
  });

  test("the words wait until the field has focus, and never go into the dialog itself", async () => {
    // The pane still shows the dialog as it was: the keys haven't been taken.
    const tmux = fakeTmux(claudeAgent(), [raw("claude-bash-permission")]);
    expect(await answer(tmux, "@1", print("claude", "bash-permission"), 4, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(tmux.writes()).toEqual([["sendKeys", "@1", ["Down", "Down", "Down", "Tab"]]]);
    // The prompt came back instead (answered at the desk meanwhile): the words are not sent as a message.
    const back = fakeTmux(claudeAgent(), [raw("claude-bash-permission"), raw("claude-idle-empty")]);
    expect(await answer(back, "@1", print("claude", "bash-permission"), 4, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(back.writes().filter((c) => c[0] === "pasteInto")).toEqual([]);
  });

  test("a plan's change request moves onto its field; a question's own answer is its digit, then the words", async () => {
    const plan = fakeTmux(claudeAgent(), [raw("claude-plan"), raw("claude-plan-feedback")]);
    expect(await answer(plan, "@1", print("claude", "plan"), 3, "use bye instead")).toEqual({ ok: true });
    expect(plan.writes()).toEqual([["sendKeys", "@1", ["Down", "Down"]], ["pasteInto", "@1", "use bye instead"], ["sendKeys", "@1", ["Enter"]]]);

    const approve = fakeTmux(claudeAgent(), [raw("claude-plan")]);
    expect(await answer(approve, "@1", print("claude", "plan"), 2)).toEqual({ ok: true });
    expect(approve.writes()).toEqual([["sendKeys", "@1", ["2"]]]);

    const question = fakeTmux(claudeAgent(), [raw("claude-question"), raw("claude-question-typing")]);
    expect(await answer(question, "@1", print("claude", "question"), 4, "purple")).toEqual({ ok: true });
    expect(question.writes()).toEqual([["sendKeys", "@1", ["4"]], ["pasteInto", "@1", "purple"], ["sendKeys", "@1", ["Enter"]]]);
  });

  test("each question is one digit; the review screen is answered with the user's pick", async () => {
    const first = fakeTmux(claudeAgent(), [raw("claude-question")]);
    expect(await answer(first, "@1", print("claude", "question"), 2)).toEqual({ ok: true });
    expect(first.writes()).toEqual([["sendKeys", "@1", ["2"]]]);
    for (const option of [1, 2]) {
      const review = fakeTmux(claudeAgent(), [raw("claude-question-review")]);
      expect(await answer(review, "@1", print("claude", "question-review"), option)).toEqual({ ok: true });
      expect(review.writes()).toEqual([["sendKeys", "@1", [String(option)]]]);
    }
  });

  test("a question call with a multi-select question anywhere in it is answered on Screen only", async () => {
    const agent = claudeAgent({ conversation: { sessionId: "sess-1", transcriptPath: MULTI_LATER } });
    for (const pane of ["question", "question-review"]) {
      const tmux = fakeTmux(agent, [raw(`claude-${pane}`)]);
      expect(await answer(tmux, "@1", print("claude", pane), 1)).toEqual({ ok: false, error: "waiting" });
      expect(tmux.writes()).toEqual([]);
    }
    // No transcript to check: refused.
    const blind = fakeTmux(claudeAgent({ conversation: undefined }), [raw("claude-question")]);
    expect(await answer(blind, "@1", print("claude", "question"), 1)).toEqual({ ok: false, error: "waiting" });
    // A permission card doesn't depend on it.
    const permission = fakeTmux(claudeAgent({ conversation: undefined }), [raw("claude-bash-permission")]);
    expect(await answer(permission, "@1", print("claude", "bash-permission"), 1)).toEqual({ ok: true });
  });

  test("a Codex approval is y, p or Escape", async () => {
    for (const [option, key] of [[1, "y"], [2, "p"], [3, "Escape"]] as const) {
      const tmux = fakeTmux(codexAgent(), [raw("codex-approval")]);
      expect(await answer(tmux, "@2", print("codex", "approval"), option)).toEqual({ ok: true });
      expect(tmux.writes()).toEqual([["sendKeys", "@2", [key]]]);
    }
  });

  test("Codex's No with words declines, then sends the words once the composer is back", async () => {
    const tmux = fakeTmux(codexAgent(), [raw("codex-approval"), raw("codex-approval"), raw("codex-idle-empty")]);
    expect(await answer(tmux, "@2", print("codex", "approval"), 3, "use the temp dir instead")).toEqual({ ok: true });
    expect(tmux.writes()).toEqual([["sendKeys", "@2", ["Escape"]], ["pasteInto", "@2", "use the temp dir instead"], ["sendKeys", "@2", ["Enter"]]]);
    // A draft came back with the composer: it is the desk's, so the words are not added to it.
    const draft = fakeTmux(codexAgent(), [raw("codex-approval"), raw("codex-idle-draft")]);
    expect(await answer(draft, "@2", print("codex", "approval"), 3, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(draft.writes()).toEqual([["sendKeys", "@2", ["Escape"]]]);
  });

  test("Codex's follow-up gives up after 5 s without the composer", async () => {
    const tmux = fakeTmux(codexAgent(), [raw("codex-approval")]);
    const t0 = Date.now();
    expect(await answer(tmux, "@2", print("codex", "approval"), 3, "words")).toEqual({ ok: false, error: "prompt-changed" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4900);
    expect(tmux.writes()).toEqual([["sendKeys", "@2", ["Escape"]]]);
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
    for (const [agent, pane] of [[claudeAgent(), "claude-idle-empty"], [claudeAgent(), "claude-bash-permission"], [claudeAgent(), "claude-trust"], [codexAgent(), "codex-idle-empty"], [null, "claude-working"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      await stop(tmux, "@1");
      expect(tmux.writes()).toEqual([]);
    }
    for (const [agent, pane] of [[claudeAgent(), "claude-working"], [codexAgent(), "codex-working"]] as const) {
      const tmux = fakeTmux(agent, [raw(pane)]);
      await stop(tmux, "@1");
      expect(tmux.writes()).toEqual([["sendKeys", "@1", ["Escape"]]]);
    }
  });

  test("pressKey accepts only the generic keys", async () => {
    const keys: GenericKey[] = ["1", "2", "3", "4", "5", "Enter", "Escape", "Up", "Down", "Tab"];
    const tmux = fakeTmux(null, [""]);
    for (const key of keys) await pressKey(tmux, "@1", key);
    expect(tmux.writes()).toEqual(keys.map((k) => ["sendKeys", "@1", [k]]));
    const other = fakeTmux(null, [""]);
    for (const bad of ["C-c", "6", "enter", "Enter Enter", "", "y"]) await expect(pressKey(other, "@1", bad as GenericKey)).rejects.toThrow();
    expect(other.writes()).toEqual([]);
  });

  test("conversationOf names Claude's session and Codex's thread", () => {
    expect(conversationOf(claudeAgent())).toBe("sess-1");
    expect(conversationOf(codexAgent())).toBe("thread-1");
    expect(conversationOf(codexAgent({ thread: undefined, daemon: true }))).toBeNull();
    expect(conversationOf(claudeAgent({ conversation: undefined }))).toBeNull();
  });
});
