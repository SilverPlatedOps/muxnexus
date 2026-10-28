import { describe, expect, test } from "bun:test";
import { addMember, newChat, post } from "../src/server/chat/model";
import { excerptOf, searchChats } from "../src/server/chat/search";
import { SEARCH_LIMITS, type Chat } from "../src/shared/chat";

const T = "2026-10-28T12:00:00.000Z";
function chat(id: string, name: string, created: string, lines: string[], extra: Partial<Chat> = {}): Chat {
  const c = newChat(id, name, created, 0);
  addMember(c, { kind: "codex", windowId: "@1" }, T);
  for (const l of lines) post(c, "codex1", l, T);
  return Object.assign(c, extra);
}

describe("chat search", () => {
  test("finds a chat by name, a note and a message, newest chat first; system lines aren't searched", () => {
    const old = chat("a", "Cache review", "2026-10-01T00:00:00Z", ["the cache key is wrong"], { archived: true });
    const now = chat("b", "Shop", "2026-10-20T00:00:00Z", ["Cache hits are fine"], { notes: { text: "check cache TTL", rev: 1, updatedAt: T } });
    const r = searchChats([old, now], "cache");
    expect(r.hits.map((h) => [h.chatId, h.kind])).toEqual([["b", "note"], ["b", "message"], ["a", "chat"], ["a", "message"]]);
    expect(r.hits.find((h) => h.chatId === "a")!.archived).toBe(true);
    expect(searchChats([now], "joined").hits).toEqual([]);
  });

  test("one chat's scope never returns another's", () => {
    const a = chat("a", "A", T, ["shared word"]);
    const b = chat("b", "B", T, ["shared word"]);
    expect(searchChats([a, b], "shared", { chatId: "a" }).hits.every((h) => h.chatId === "a")).toBe(true);
  });

  test("literal and case-insensitive: punctuation, Unicode and HTML-looking text match as typed", () => {
    const c = chat("a", "A", T, ["see foo.bar(1) here", "Ünïcödé café", "<b>bold</b> & co"]);
    expect(searchChats([c], "FOO.BAR(1)").hits).toHaveLength(1);
    expect(searchChats([c], "café").hits).toHaveLength(1);
    expect(searchChats([c], "<b>").hits[0]!.excerpt).toBe("<b>bold</b> & co");
    expect(searchChats([c], "f.o").hits).toHaveLength(0);
  });

  test("pages of 50 with a cursor to the next", () => {
    const c = chat("a", "A", T, Array.from({ length: 120 }, (_, i) => `needle ${i}`));
    const p1 = searchChats([c], "needle");
    expect(p1.hits).toHaveLength(SEARCH_LIMITS.page);
    expect(p1.next).toBe(50);
    const p3 = searchChats([c], "needle", { cursor: 100 });
    expect(p3.hits).toHaveLength(20);
    expect(p3.next).toBeUndefined();
    expect(p3.hits.at(-1)!.excerpt).toBe("needle 0");
  });

  test("an excerpt is short and shows the match", () => {
    const text = `${"a ".repeat(300)}needle ${"b ".repeat(300)}`;
    const e = excerptOf(text, ["needle"]);
    expect(e.length).toBeLessThanOrEqual(SEARCH_LIMITS.excerpt);
    expect(e).toContain("needle");
    expect(e.startsWith("…")).toBe(true);
  });
});
