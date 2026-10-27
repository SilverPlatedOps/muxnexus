import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { said } from "../src/server/chat/turns";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxn-turns-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Rows to a transcript file; the byte offset after each row, for `at`. */
function transcript(rows: object[]): { path: string; after: number[] } {
  const lines = rows.map((r) => JSON.stringify(r));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
  const after: number[] = [];
  let n = 0;
  for (const l of lines) after.push((n += Buffer.byteLength(l) + 1));
  return { path, after };
}

const TAG = "[muxnexus · shop review · #3 ·";

const cText = (text: string, extra: object = {}) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const cTool = (command: string) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } });
const cResult = (text: string) => ({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });
const cEnd = { type: "system", subtype: "turn_duration", isSidechain: false, durationMs: 1000 };

const claudeRows = [
  { type: "user", isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "add sub(a, b) next to add" } },
  cText("I'll add sub next to add."),
  cTool("apply the edit"),
  cResult("ok"),
  cText("Done: sub(a, b) is in math.js. add() has no tests yet."),
  cEnd,
  { type: "queue-operation", operation: "enqueue", content: `${TAG} from @user · the human, via muxnexus]\n@claude1 please review` },
  { type: "user", isSidechain: false, isMeta: true, origin: { kind: "peer" }, message: { role: "user", content: `${TAG} from @user · the human, via muxnexus]\n@claude1 please review` } },
  { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
  { type: "user", isSidechain: false, isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /Users/me/skills/x" }] } },
  cText("Reviewing the diff. Two problems: sub swaps its arguments, and add() has no tests. The swap matters more."),
  cText("a subagent's notes", { isSidechain: true }),
  cTool(`mux say "@codex1 sub looks wrong"`),
  cResult("posted as #4"),
  cText("Posted my review."),
  cEnd,
];

describe("Claude: what it said in one turn", () => {
  test("the turn under way at a post, from its prompt to its end, prose only", async () => {
    const { path, after } = transcript(claudeRows);
    expect(await said("claude", path, { at: after[12]! })).toEqual({
      text: "Reviewing the diff. Two problems: sub swaps its arguments, and add() has no tests. The swap matters more.\n\nPosted my review.",
      ended: true,
      start: after[5]!,
    });
  });

  test("the turn a chat message started, found by its tag", async () => {
    const { path, after } = transcript(claudeRows);
    const s = await said("claude", path, { from: after[5]!, tag: TAG });
    expect(s?.text).toStartWith("Reviewing the diff.");
    expect(s?.ended).toBe(true);
  });

  test("a turn still running has not ended, and gives what it has so far", async () => {
    const { path, after } = transcript(claudeRows.slice(0, 13));
    expect(await said("claude", path, { at: after[12]! })).toEqual({
      text: "Reviewing the diff. Two problems: sub swaps its arguments, and add() has no tests. The swap matters more.",
      ended: false,
      start: after[5]!,
    });
  });

  test("an earlier turn stays its own", async () => {
    const { path, after } = transcript(claudeRows);
    expect((await said("claude", path, { at: after[2]! }))?.text).toBe("I'll add sub next to add.\n\nDone: sub(a, b) is in math.js. add() has no tests yet.");
  });

  test("a post whose turn wasn't written yet belongs to the turn after the last one that ended", async () => {
    const { path, after } = transcript(claudeRows);
    expect((await said("claude", path, { at: after[5]! }))?.text).toStartWith("Reviewing the diff.");
  });

  test("a message that arrives mid-turn doesn't end the turn: Claude Code ends it", async () => {
    const rows = [...claudeRows];
    rows.splice(13, 0, { type: "user", isSidechain: false, isMeta: true, origin: { kind: "peer" }, message: { role: "user", content: "[muxnexus · shop review · #5 · from @codex1]\nagreed" } }, cText("Codex agrees; nothing more to do."));
    const { path, after } = transcript(rows);
    const s = await said("claude", path, { at: after[12]! });
    expect(s?.text).toEndWith("Codex agrees; nothing more to do.\n\nPosted my review.");
    expect(s?.start).toBe(after[5]!);
    expect((await said("claude", path, { at: after[15]! }))?.start).toBe(after[5]!);
  });

  test("a message queued behind a running turn belongs to the turn that reads it, not the one it arrived in", async () => {
    const q = (operation: string, extra: object = {}) => ({ type: "queue-operation", operation, ...extra });
    const msg = `${TAG} from @user · the human, via muxnexus]\n@claude1 anything else?`;
    const head = [
      { type: "user", isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "add sub" } },
      cText("Working on sub."),
      q("enqueue", { content: msg }),
      cText("Done with sub."),
      cEnd,
    ];
    let { path } = transcript(head);
    expect(await said("claude", path, { tag: TAG })).toBeNull();
    ({ path } = transcript([...head, q("dequeue"), { type: "user", isSidechain: false, isMeta: true, origin: { kind: "peer" }, message: { role: "user", content: msg } }, cText("Nothing else."), cEnd]));
    expect(await said("claude", path, { tag: TAG })).toMatchObject({ text: "Nothing else.", ended: true });
  });

  test("a message read between tool calls belongs to the turn it was read in", async () => {
    const msg = `${TAG} from @user · the human, via muxnexus]\n@claude1 also check add`;
    const { path } = transcript([
      { type: "user", isSidechain: false, origin: { kind: "human" }, message: { role: "user", content: "fix sub" } },
      cText("Fixing sub."),
      { type: "queue-operation", operation: "enqueue", content: msg },
      { type: "queue-operation", operation: "remove", content: msg },
      { type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: msg } },
      cText("Also checked add: fine."),
      cEnd,
    ]);
    expect(await said("claude", path, { tag: TAG })).toMatchObject({ text: "Fixing sub.\n\nAlso checked add: fine.", ended: true });
  });

  test("no transcript, or no tag in it, gives nothing", async () => {
    expect(await said("claude", join(dir, "missing.jsonl"), { at: 10 })).toBeNull();
    const { path } = transcript(claudeRows);
    expect(await said("claude", path, { tag: "[muxnexus · other · #9 ·" })).toBeNull();
  });
});

const x = (type: string, payload: object) => ({ timestamp: "2026-10-26T12:00:00.000Z", type, payload });
const xSays = (phase: string, text: string) => x("response_item", { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] });

const codexRows = [
  x("session_meta", { id: "th-1", cwd: "/Users/me/shop-orders" }),
  x("event_msg", { type: "task_started", turn_id: "t1" }),
  x("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `${TAG} from @claude1]\nplease review` }] }),
  x("response_item", { type: "reasoning", summary: [] }),
  xSays("commentary", "Checking the diff first."),
  x("response_item", { type: "function_call", name: "exec_command", arguments: `{"cmd":"mux say \\"@claude1 one finding\\""}`, call_id: "c1" }),
  x("response_item", { type: "function_call_output", call_id: "c1", output: "posted as #5" }),
  xSays("final_answer", "One finding: sub swaps its arguments. Also, math.js has no tests at all. Posted the first to the chat."),
  x("event_msg", { type: "agent_message", message: "One finding: sub swaps its arguments." }),
  x("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "One finding…" }),
  x("event_msg", { type: "task_started", turn_id: "t2" }),
  xSays("final_answer", "Something else entirely."),
  x("event_msg", { type: "turn_aborted", turn_id: "t2" }),
];

describe("Codex: what it said in one turn", () => {
  test("commentary and the final answer of the turn under way at a post", async () => {
    const { path, after } = transcript(codexRows);
    expect(await said("codex", path, { at: after[5]! })).toEqual({
      text: "Checking the diff first.\n\nOne finding: sub swaps its arguments. Also, math.js has no tests at all. Posted the first to the chat.",
      ended: true,
      start: after[0]!,
    });
  });

  test("the turn a queued chat message started, found by its tag", async () => {
    const { path, after } = transcript(codexRows);
    expect((await said("codex", path, { from: after[0]!, tag: TAG }))?.text).toStartWith("Checking the diff first.");
  });

  test("an aborted turn ends too", async () => {
    const { path, after } = transcript(codexRows);
    expect(await said("codex", path, { at: after[11]! })).toEqual({ text: "Something else entirely.", ended: true, start: after[9]! });
  });
});
