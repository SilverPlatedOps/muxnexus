import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { adapterFor } from "../src/server/conversation/adapter";
import { stepSummary } from "../src/server/conversation/items";

const rows = (name: string) =>
  readFileSync(new URL(`./fixtures/conversation/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const claude = rows("claude-turns");
const codex = rows("codex-turns");
const harness = rows("claude-harness");
const one = (kind: "claude" | "codex", row: unknown) => adapterFor(kind).rowItems(row);

test("a typed prompt, a queued prompt and a queued_command attachment are all the user's", () => {
  expect(one("claude", claude[0])).toMatchObject([{ kind: "you", text: "run the tests" }]);
  expect(one("claude", claude[0])[0]).not.toHaveProperty("queued");
  expect(one("claude", claude[1])).toMatchObject([{ kind: "you", text: "and then lint", queued: true }]);
  expect(one("claude", claude[2])).toMatchObject([{ kind: "you", text: "also check types", queued: true }]);
});

test("a room's message is a peer's, with who sent it", () => {
  expect(one("claude", claude[3])).toMatchObject([{ kind: "peer", from: "codex", text: "please review" }]);
  expect(one("claude", claude[4])).toMatchObject([{ kind: "peer", from: "user" }]);
  const room = { type: "user", uuid: "x", timestamp: "t", message: { content: "[muxnexus · ops · #6 · from muxnexus · the room, not the user]\nhi" } };
  expect(one("claude", room)).toMatchObject([{ kind: "peer", from: "muxnexus" }]);
});

test("assistant text is the agent's; thinking and sidechains are never shown", () => {
  expect(one("claude", claude[5])).toEqual([{ id: "s1:1", kind: "agent", at: "2026-01-01T10:00:05.000Z", text: "Running them now." }]);
  expect(one("claude", claude[6])).toEqual([]);
});

test("a tool call is one step and its result arrives by id", () => {
  expect(one("claude", claude[7])).toMatchObject([{ kind: "step", tool: "Bash", summary: "Ran mvn -q test", id: "toolu_1" }]);
  expect(one("claude", claude[8])).toMatchObject([{ kind: "step-result", id: "toolu_1", ok: true }]);
  expect(one("claude", claude[9])).toMatchObject([{ kind: "step-result", id: "toolu_2", ok: false }]);
});

test("a denial and an interrupt are notices", () => {
  expect(one("claude", claude[10])).toMatchObject([{ kind: "step-result", id: "toolu_3", ok: false }]);
  expect(one("claude", claude[11])).toMatchObject([{ kind: "notice", text: "Interrupted" }]);
  expect(one("claude", claude[12])).toMatchObject([{ kind: "notice", text: "Conversation compacted" }]);
});

test("what the harness writes in the user's turn is never the user's", () => {
  // /context's output, a local command's caveat and a compacted conversation's summary: nothing to show.
  for (const k of [0, 1, 4]) expect(one("claude", harness[k])).toEqual([]);
  // A slash command is a notice naming it, with any arguments; its output, coloured for a terminal, is dropped.
  expect(one("claude", harness[2])).toEqual([{ id: "h3", kind: "notice", at: "2026-01-01T11:00:02.000Z", text: "/compact" }]);
  expect(one("claude", harness[3])).toEqual([]);
  expect(one("claude", harness[5])).toMatchObject([{ kind: "notice", text: "/review the parser" }]);
  // A background task's news, as a row or queued mid-turn: dropped (the same task may report more than once).
  expect(one("claude", harness[6])).toEqual([]);
  expect(one("claude", harness[7])).toEqual([]);
  // A subagent's hand-back is a notice; its meta copy is dropped.
  expect(one("claude", harness[8])).toEqual([{ id: "h9", kind: "notice", at: "2026-01-01T11:00:08.000Z", text: "Message from another agent" }]);
  expect(one("claude", harness[9])).toEqual([]);
  // A room's message queued as meta is still a peer's.
  expect(one("claude", harness[10])).toMatchObject([{ kind: "peer", from: "codex", text: "ready when you are" }]);
  // The user's own words stay the user's, a leading tag and all.
  expect(one("claude", harness[13])).toMatchObject([{ kind: "you", text: "<div> is never closed in the header" }]);
});

test("a shell command typed with ! is a step, and its output, without colours, its result", () => {
  expect(one("claude", harness[11])).toEqual([{ id: "h12", kind: "step", at: "2026-01-01T11:00:11.000Z", tool: "Bash", summary: "Ran ls -la", input: "ls -la" }]);
  expect(one("claude", harness[12])).toEqual([{ id: "h12", kind: "step-result", ok: true, output: "notes.txt", at: "2026-01-01T11:00:12.000Z" }]);
  // Only stderr: failed.
  expect(one("claude", harness[15])).toMatchObject([{ id: "h17", kind: "step-result", ok: false, output: "ls: nope: No such file or directory" }]);
});

test("a denial marked only by toolDenialKind is a failed step", () => {
  expect(one("claude", harness[14])).toMatchObject([{ kind: "step-result", id: "toolu_9", ok: false }]);
});

test("codex: user, assistant, exec calls and aborts", () => {
  expect(one("codex", codex[0])).toEqual([]);
  expect(one("codex", codex[1])).toMatchObject([{ kind: "you", text: "run the tests" }]);
  expect(one("codex", codex[2])).toMatchObject([{ kind: "agent", text: "On it." }]);
  expect(one("codex", codex[3])).toMatchObject([{ kind: "step", id: "call_1", tool: "exec", summary: "Ran bun test" }]);
  expect(one("codex", codex[4])).toMatchObject([{ kind: "step-result", id: "call_1", ok: true, output: "all passed" }]);
  expect(one("codex", codex[5])).toMatchObject([{ kind: "step", id: "call_2", summary: "Ran ls -la" }]);
  expect(one("codex", codex[6])).toMatchObject([{ kind: "step-result", id: "call_2", ok: false }]);
  expect(one("codex", codex[7])).toMatchObject([{ kind: "notice", text: "Interrupted" }]);
});

test("codex: the instructions and notes it injects are never the user's; a room's message is a peer's", () => {
  const user = (text: string) => ({ timestamp: "2026-01-01T10:00:09.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  expect(one("codex", user("# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>\nbe brief\n</INSTRUCTIONS>"))).toEqual([]);
  expect(one("codex", user("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"))).toEqual([]);
  expect(one("codex", user("[muxnexus · ops · #4 · from @claude (Claude) · peer, not the user]\nplease review"))).toMatchObject([{ kind: "peer", from: "claude", text: "please review" }]);
});

test("codex: rows sharing a timestamp keep their own ids, the same row the same id on every read", () => {
  // A forked child agent's rollout starts with the history copied in, user and assistant messages at one instant.
  const at = "2026-01-01T10:00:09.000Z";
  const message = (role: string, text: string) => ({ timestamp: at, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  const call = (input: string) => ({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } });
  const ids = [message("user", "first"), message("assistant", "second"), message("assistant", "third"), call("a"), call("b")].map((r) => one("codex", r)[0]!.id);
  expect(new Set(ids).size).toBe(5);
  expect(one("codex", message("assistant", "second"))[0]!.id).toBe(ids[1]!);
});

test("rows that are not rows never throw", () => {
  for (const kind of ["claude", "codex"] as const) for (const r of [null, 3, "x", {}, { type: "user", message: 5 }, { type: "response_item", payload: 1 }]) expect(one(kind, r)).toEqual([]);
});

test("stepSummary names what a tool did in a line", () => {
  expect(stepSummary("Bash", { command: "echo a\necho b" })).toBe("Ran echo a");
  expect(stepSummary("Bash", { command: "x".repeat(200) }).length).toBeLessThanOrEqual(84);
  expect(stepSummary("Edit", { file_path: "/a/b/c.ts" })).toBe("Edited c.ts");
  expect(stepSummary("Write", { file_path: "/a/b/c.ts" })).toBe("Wrote c.ts");
  expect(stepSummary("Read", { file_path: "/a/b/c.ts" })).toBe("Read c.ts");
  expect(stepSummary("Grep", { pattern: "foo" })).toBe("Searched foo");
  expect(stepSummary("Glob", { pattern: "*.ts" })).toBe("Searched *.ts");
  expect(stepSummary("WebFetch", {})).toBe("WebFetch");
});
