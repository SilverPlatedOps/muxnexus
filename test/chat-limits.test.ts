import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLimitIn, limitIn, untilMs } from "../src/server/chat/limits";
import { createChatService } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";
import { tabOf } from "../src/client/chat/model";

const ev = (type: string, extra: object = {}) => JSON.stringify({ timestamp: "2026-10-28T10:00:00.000Z", type: "event_msg", payload: { type, ...extra } });
const limited = ev("task_complete", { error: { message: "You’ve hit your usage limit. Upgrade to Pro, or try again at 6:42 PM.", codex_error_info: "usage_limit_exceeded" } });

describe("usage limit in a Codex rollout", () => {
  test("a last turn that ended on the limit is read, with when to try again", () => {
    expect(limitIn([ev("task_started"), limited, ev("token_count")].join("\n"))).toMatchObject({ until: "6:42 PM", at: "2026-10-28T10:00:00.000Z" });
  });
  test("a turn started after it means the limit no longer stops it", () => {
    expect(limitIn([limited, ev("task_started")].join("\n"))).toBeNull();
    expect(limitIn([ev("task_started"), ev("task_complete")].join("\n"))).toBeNull();
  });
  test("a clock time is the next such moment after the error", () => {
    const at = new Date(2026, 9, 28, 17, 0).toISOString();
    expect(untilMs("6:42 PM", at)).toBe(new Date(2026, 9, 28, 18, 42).getTime());
    expect(untilMs("3:23 PM", at)).toBe(new Date(2026, 9, 29, 15, 23).getTime());
    expect(untilMs("whenever", at)).toBeUndefined();
  });
});

// The shape of a real Claude Code entry (2.1.287), trimmed to what is read.
const RESETS_AT = 1790939400;
const claudeLimited = (extra: object = {}) => JSON.stringify({
  type: "assistant", timestamp: "2026-10-02T09:48:06.254Z",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 6:10pm (Asia/Jakarta)" }] },
  quotaLimits: { status: "rejected", resetsAt: RESETS_AT, rateLimitType: "five_hour" },
  error: "rate_limit", isApiErrorMessage: true, apiErrorStatus: 429, ...extra,
});
const prompt = (text: string) => JSON.stringify({ type: "user", promptId: "p1", message: { role: "user", content: text } });
const toolResult = JSON.stringify({ type: "user", promptId: "p1", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

describe("usage limit in a Claude transcript", () => {
  test("the API-error entry is read, with its reset time and the words for it", () => {
    expect(claudeLimitIn([prompt("go"), claudeLimited(), JSON.stringify({ type: "system", subtype: "turn_duration" })].join("\n")))
      .toEqual({ until: "6:10pm", at: "2026-10-02T09:48:06.254Z", untilMs: RESETS_AT * 1000 });
  });
  test("without the timestamp, the words give the reset", () => {
    const at = new Date(2026, 9, 2, 16, 48).toISOString();
    const l = claudeLimitIn(claudeLimited({ quotaLimits: undefined, timestamp: at }));
    expect(l?.untilMs).toBe(new Date(2026, 9, 2, 18, 10).getTime());
    expect(untilMs("7pm", at)).toBe(new Date(2026, 9, 2, 19, 0).getTime());
  });
  test("a prompt typed after it ends it; a tool result doesn't", () => {
    expect(claudeLimitIn([claudeLimited(), prompt("again")].join("\n"))).toBeNull();
    expect(claudeLimitIn([claudeLimited(), toolResult].join("\n"))).not.toBeNull();
  });
  test("the words quoted in a prompt or an ordinary answer aren't the limit", () => {
    expect(claudeLimitIn(prompt('why did I get "error":"rate_limit"?'))).toBeNull();
    expect(claudeLimitIn(claudeLimited({ isApiErrorMessage: false }))).toBeNull();
  });
});

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxn-limit-")); });

test("a Claude out of credits is said once in the chat and its messages wait", async () => {
  const transcript = join(dir, "c.jsonl");
  writeFileSync(transcript, [prompt("go"), claudeLimited()].join("\n") + "\n");
  const sends: string[] = [];
  const svc = createChatService({
    store: createChatStore(join(dir, "chats")),
    tmux: {
      windowOfPane: async () => ({ windowId: "@1", session: "s" }),
      agentOfWindow: async () => ({ paneId: "%1", kind: "claude", pid: 11, state: "done", since: 1, fresh: true, conversation: { sessionId: "s", transcriptPath: transcript } }) as never,
    },
    states: async () => new Map(),
    adapters: {
      claude: { kind: "claude", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
      codex: { kind: "codex", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
    },
    socketOf: async () => null, receipt: async () => false, alive: () => true,
    // Before the reset.
    now: () => new Date((RESETS_AT - 3600) * 1000).toISOString(),
    home: "/Users/me",
  });
  const id = ((await svc.handle({ t: "chat-create", name: "t", members: [{ windowId: "@1" }] })) as { chatId: string }).chatId;
  await svc.handle({ t: "chat-post", id, text: "@claude1 hello" });
  await svc.tick();
  await svc.tick();
  const { chat, agents } = (await svc.view(id))!;
  expect(chat.messages.filter((m) => m.text.includes("out of usage credits until 6:10pm"))).toHaveLength(1);
  expect(sends).toHaveLength(0);
  expect(chat.messages.find((m) => m.text === "@claude1 hello")!.deliveries.claude1).toMatchObject({ state: "queued", reason: "out of credits until 6:10pm" });
  expect(agents.claude1).toMatchObject({ state: "done", limit: { until: "6:10pm" } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a Codex out of credits is said once in the chat and its messages wait", async () => {
  const rollout = join(dir, "r.jsonl");
  writeFileSync(rollout, limited + "\n");
  const sends: string[] = [];
  const info = (kind: "claude" | "codex", pane: string) => ({ paneId: pane, kind, pid: kind === "claude" ? 11 : 22, state: "running" as const, since: 1, fresh: true, ...(kind === "codex" ? { thread: { id: "th", path: rollout } } : { conversation: { sessionId: "s", transcriptPath: "/tmp/c.jsonl" } }) });
  const svc = createChatService({
    store: createChatStore(join(dir, "chats")),
    tmux: { windowOfPane: async () => ({ windowId: "@2", session: "s" }), agentOfWindow: async (w) => (w === "@1" ? info("claude", "%1") : info("codex", "%2")) as never },
    states: async () => new Map(),
    adapters: {
      claude: { kind: "claude", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
      codex: { kind: "codex", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
    },
    socketOf: async () => null, receipt: async () => false, alive: () => true,
    // Before 6:42 PM local on the day of the error.
    now: () => new Date(2026, 9, 28, 17, 0).toISOString(),
    home: "/Users/me",
  });
  const id = ((await svc.handle({ t: "chat-create", name: "t", members: [{ windowId: "@2" }] })) as { chatId: string }).chatId;
  await svc.handle({ t: "chat-post", id, text: "@codex1 hello" });
  await svc.tick();
  await svc.tick();
  const { chat, agents } = (await svc.view(id))!;
  expect(chat.messages.filter((m) => m.text.includes("out of usage credits until 6:42 PM"))).toHaveLength(1);
  expect(sends).toHaveLength(0);
  expect(chat.messages.find((m) => m.text === "@codex1 hello")!.deliveries.codex1).toMatchObject({ state: "queued", reason: "out of credits until 6:42 PM" });
  expect(agents.codex1).toMatchObject({ state: "done", limit: { until: "6:42 PM" } });
});

describe("tab text under a post", () => {
  test("always reachable; one that looks like a restatement is only marked similar", () => {
    const post = "Pushed the branch: bare link fix, image paste, gateway work and notes.";
    expect(tabOf("Pushed the branch with the bare link fix, image paste, gateway work and notes.", post)).toMatchObject({ similar: true });
    expect(tabOf("Ran the whole suite first; two flaky tmux tests needed a rerun before pushing.", post)?.similar).toBeUndefined();
    // codex1's case: the same words, the opposite meaning, still there to open.
    expect(tabOf("Validation incomplete: not all tests passed and the deployment is unsafe to proceed", "Validation complete: all tests passed and the deployment is safe to proceed")).not.toBeNull();
  });
});
