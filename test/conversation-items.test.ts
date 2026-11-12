import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { adapterFor } from "../src/server/conversation/adapter";
import { stepSummary } from "../src/server/conversation/items";

const rows = (name: string) =>
  readFileSync(new URL(`./fixtures/conversation/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const claude = rows("claude-turns");
const codex = rows("codex-turns");
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
