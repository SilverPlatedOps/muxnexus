import { describe, expect, test } from "bun:test";
import { addMember, newChat, post, replyTarget, startRound } from "../src/server/chat/model";
import { deliveryText, packetText, readText } from "../src/server/chat/text";
import { chatRules } from "../src/shared/chat-rules";

const T = "2026-10-28T12:00:00.000Z";
function chat() {
  const c = newChat("c1", "shop", T, 0);
  addMember(c, { kind: "claude", windowId: "@1" }, T);
  addMember(c, { kind: "codex", windowId: "@2" }, T);
  return c;
}

describe("reply-to", () => {
  test("a reply carries its parent: in the wake as (re #n) with a quote of the parent, and in mux read", () => {
    const c = chat();
    const q = post(c, "user", "@claude1 is the cache key per user?", T);
    const a = post(c, "claude1", "@codex1 no, it's per shop: check it", T, { replyTo: q.id });
    expect(a.replyTo).toBe(q.id);
    const codex = c.members.find((m) => m.handle === "codex1")!;
    const wake = deliveryText(c, codex, a, { lines: [], older: 0 });
    expect(wake).toContain(`Re:      #${q.id} @user: @claude1 is the cache key per user?`);
    expect(wake).toContain(`@claude1 → @codex1 (re #${q.id}): no, it's per shop`);
    expect(readText(c, 5)).toContain(`#${a.id} @claude1 (re #${q.id}): @codex1 no`);
  });

  test("a reply can't point at a room line, a missing id, or another's blind post in an open round", () => {
    const c = chat();
    expect(replyTarget(c, 99, "user")).not.toBeNull();
    const sys = post(c, "user", "mode is now review", T, { system: true });
    expect(replyTarget(c, sys.id, "user")).not.toBeNull();
    startRound(c, "why", T);
    const blind = post(c, "claude1", "my hypothesis", T);
    expect(blind.blind).toBe(true);
    expect(replyTarget(c, blind.id, "codex1")).not.toBeNull();
    expect(replyTarget(c, blind.id, "claude1")).toBeNull();
    expect(replyTarget(c, blind.id, "user")).toBeNull();
  });

  test("a batched wake quotes each reply's parent too, unless the parent is in the batch or hidden from the reader", () => {
    const c = chat();
    const q = post(c, "user", "is the cache key per user?", T);
    const codex = c.members.find((m) => m.handle === "codex1")!;
    const a = post(c, "user", "@codex1 answer this", T, { replyTo: q.id });
    const b = post(c, "user", "@codex1 and this one", T, { replyTo: a.id });
    const batch = packetText(c, codex, [a, b], { lines: [], older: 0 });
    expect(batch).toContain(`Re:      #${q.id} @user: is the cache key per user?`);
    expect(batch.match(/^Re: /gm)).toHaveLength(1);
    startRound(c, "why", T);
    const blind = post(c, "claude1", "secret hypothesis", T);
    const r1 = post(c, "user", "@codex1 one", T, { replyTo: blind.id });
    const r2 = post(c, "user", "@codex1 two", T);
    expect(packetText(c, codex, [r1, r2], { lines: [], older: 0 })).not.toContain("secret hypothesis");
  });

  test("agents are told how to reply", () => {
    expect(chatRules(0).join("\n")).toContain("mux say --reply <id>");
  });
});

test("the browser's quote of a parent is one plain line, and says when the parent is gone", async () => {
  const { replyQuote } = await import("../src/client/chat/model");
  const c = chat();
  const p = post(c, "codex1", "**Chat details** holds\nthe `mode`", T);
  expect(replyQuote(c, p.id)).toEqual({ id: p.id, from: "codex1", text: "Chat details holds the mode" });
  expect(replyQuote(c, 999).text).toBe("(no longer in the chat)");
});
