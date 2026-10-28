import { describe, expect, test } from "bun:test";
import { addMember, newChat, post } from "../src/server/chat/model";
import { nextSends, type AgentView } from "../src/server/chat/plan";
import type { Chat, ChatMember } from "../src/shared/chat";

const T = "2026-10-26T12:00:00.000Z";
const T2 = "2026-10-26T12:00:05.000Z";

function chat(id: string, ...members: [kind: "claude" | "codex", windowId: string][]): Chat {
  const c = newChat(id, id, T);
  for (const [kind, windowId] of members) addMember(c, { kind, windowId }, T);
  return c;
}
const view = (over: Partial<Record<string, Partial<AgentView>>> = {}) =>
  (_c: Chat, m: ChatMember): AgentView => ({ online: true, idle: true, kind: m.kind as "claude" | "codex", ...over[m.windowId!] });

describe("nextSends", () => {
  test("claude gets adjacent queued messages as one packet, oldest first", () => {
    const c = chat("a", ["claude", "@1"]);
    const m1 = post(c, "user", "@claude1 one", T);
    const m2 = post(c, "user", "@claude1 two", T);
    const plan = nextSends([c], view({ "@1": { idle: false } }));
    expect(plan.send).toEqual([
      { chatId: "a", msgId: m1.id, handle: "claude1", msgIds: [m1.id, m2.id] },
    ]);
    expect(plan.fail).toEqual([]);
  });

  test("codex gets one at a time, oldest first, across chats", () => {
    const a = chat("a", ["codex", "@7"]);
    const b = chat("b", ["codex", "@7"]);
    const first = post(a, "user", "@codex1 from a", T);
    post(b, "user", "@codex1 from b", T2);
    const plan = nextSends([b, a], view());
    expect(plan.send).toEqual([{ chatId: "a", msgId: first.id, handle: "codex1" }]);
    first.deliveries.codex1 = { state: "queued", reason: "sent", at: T };
    expect(nextSends([a, b], view()).send).toEqual([]);
    first.deliveries.codex1 = { state: "delivered", at: T2 };
    expect(nextSends([a, b], view()).send).toEqual([{ chatId: "b", msgId: 1, handle: "codex1" }]);
  });

  test("codex waits while its turn runs", () => {
    const c = chat("a", ["codex", "@2"]);
    post(c, "user", "@codex1 go", T);
    expect(nextSends([c], view({ "@2": { idle: false } })).send).toEqual([]);
  });

  test("an offline member's queued message waits, marked offline, and is never sent", () => {
    const c = chat("a", ["claude", "@1"], ["codex", "@2"]);
    const m = post(c, "user", "@claude1 @codex1 go", T);
    const plan = nextSends([c], view({ "@1": { online: false }, "@2": { online: false } }));
    expect(plan.send).toEqual([]);
    expect(plan.fail).toEqual([]);
    expect(plan.wait).toEqual([
      { chatId: "a", msgId: m.id, handle: "claude1", reason: "offline" },
      { chatId: "a", msgId: m.id, handle: "codex1", reason: "offline" },
    ]);
  });

  test("a Codex tab running in the daemon fails as unavailable", () => {
    const c = chat("a", ["codex", "@2"]);
    const m = post(c, "user", "@codex1 go", T);
    expect(nextSends([c], view({ "@2": { daemon: true } })).fail).toEqual([
      { chatId: "a", msgId: m.id, handle: "codex1", reason: "daemon" },
    ]);
  });

  test("held, in-flight and archived messages are never sent", () => {
    const c = chat("a", ["claude", "@1"]);
    c.cap = 1;
    post(c, "claude1", "@claude1 talking to myself", T);
    const held = post(c, "claude1", "@user wait", T);
    expect(held.deliveries).toEqual({});
    const m = post(c, "user", "@claude1 hi", T);
    m.deliveries.claude1 = { state: "held", at: T };
    expect(nextSends([c], view()).send).toEqual([]);
    m.deliveries.claude1 = { state: "queued", reason: "sent", at: T };
    expect(nextSends([c], view()).send).toEqual([]);
    m.deliveries.claude1 = { state: "queued", at: T };
    c.archived = true;
    expect(nextSends([c], view()).send).toEqual([]);
  });
});
