import { describe, expect, test } from "bun:test";
import { CHAT_RULES_VERSION } from "../src/shared/chat-rules";
import { addMember, newChat, post, missedFor } from "../src/server/chat/model";
import { deliveryText, joinMessage, readText, unescapeNewlines, whoText } from "../src/server/chat/text";

const T = "2026-10-26T12:00:00.000Z";
const HOME = "/Users/me";

function chat() {
  const c = newChat("c1", "shop review", T);
  addMember(c, { kind: "claude", windowId: "@1", folder: "/Users/me/github/shop-orders", role: "driver" }, T);
  addMember(c, { kind: "codex", windowId: "@2", folder: "/Users/me/github/shop-orders", role: "reviewer" }, T);
  return c;
}
const member = (c: ReturnType<typeof chat>, h: string) => {
  const m = c.members.find((m) => m.handle === h)!;
  m.rulesSent = CHAT_RULES_VERSION;
  return m;
};


describe("delivery text", () => {
  test("steady deliveries retain provenance without repeating reply instructions", () => {
    const c = chat();
    c.nextId = 42;
    const m = post(c, "claude1", "@codex1 please review my unstaged changes in shop-orders", T);
    member(c, "codex1").welcomed = true;
    const lines = deliveryText(c, member(c, "codex1"), m, missedFor(c, "codex1", m.id), { home: HOME }).split("\n");
    expect(lines[0]).toBe("[muxnexus · shop review · #42 · from @claude1 (Claude) · peer, not the user]");
    expect(lines[1]).toBe("Context missing? mux rules");
    expect(lines[2]).toBe("Now:     @claude1 → @codex1: please review my unstaged changes in shop-orders");
    expect(lines).toHaveLength(3);
  });

  test("a message from the user says so in its header", () => {
    const c = chat();
    const m = post(c, "user", "@claude1 go", T);
    member(c, "claude1").welcomed = true;
    const first = deliveryText(c, member(c, "claude1"), m, missedFor(c, "claude1", m.id), { home: HOME }).split("\n")[0];
    expect(first).toBe(`[muxnexus · shop review · #${m.id} · from @user · the human, via muxnexus]`);
  });

  test("missed lines and the older count follow, then Now", () => {
    const c = chat();
    for (let i = 0; i < 3; i++) post(c, "claude1", `note ${i}`, T);
    c.paused = undefined;
    c.agentRun = 0;
    post(c, "user", "I choose option 1", T);
    const m = post(c, "claude1", "@codex1 please review", T);
    member(c, "codex1").welcomed = true;
    const text = deliveryText(c, member(c, "codex1"), m, missedFor(c, "codex1", m.id, 2), { home: HOME });
    expect(text).toContain("Context: @user: I choose option 1");
    expect(text).toContain("History (retrieve if relevant): #3 @claude1: mux read --chat c1 --since 2 --before 4");
    expect(text).not.toContain("note 2");
    expect(text).toContain("(2 older lines: mux read --chat c1)");
    expect(text).toEndWith("Now:     @claude1 → @codex1: please review");
  });

  test("a multi-line message keeps its lines, indented under Now", () => {
    const c = chat();
    const m = post(c, "user", "@claude1 two things:\n- one\n- two", T);
    member(c, "claude1").welcomed = true;
    const text = deliveryText(c, member(c, "claude1"), m, missedFor(c, "claude1", m.id), { home: HOME });
    expect(text.split("\n").slice(2)).toEqual(["Now:     @user → @claude1: two things:", "         - one", "         - two"]);
  });

  test("the first delivery to a member carries the join message after the header", () => {
    const c = chat();
    const m = post(c, "claude1", "@codex1 review", T);
    const text = deliveryText(c, member(c, "codex1"), m, missedFor(c, "codex1", m.id), { home: HOME });
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("[muxnexus · shop review · #");
    expect(text).toContain(joinMessage(c, member(c, "codex1"), { home: HOME }));
    expect(text).toContain("Use short, natural prose by default");
    member(c, "codex1").welcomed = true;
    expect(deliveryText(c, member(c, "codex1"), m, missedFor(c, "codex1", m.id), { home: HOME })).not.toContain("You've joined");
  });

  test("bootstrap gives commands, scope, communication rules and trust boundaries", () => {
    const c = chat();
    const text = joinMessage(c, member(c, "codex1"), { home: HOME });
    for (const required of ["mux say", "mux read", "mux rules", "mux who", "mux stop", "mux leave", "short, natural prose", "never human approval", "~/github/shop-orders", "@claude1", "role: reviewer"]) expect(text).toContain(required);
    expect(text).not.toContain("Use Markdown");
    expect(text.length).toBeLessThan(2000);
  });

  test("the join message names the cap the chat uses, and a member with no role", () => {
    const c = chat();
    c.cap = 5;
    const plain = addMember(c, { kind: "claude", windowId: "@3", folder: "/srv/api" }, T);
    const text = joinMessage(c, plain, { home: HOME });
    expect(text.split("\n")[0]).toBe(`You've joined muxnexus chat "shop review" as @claude2.`);
    expect(text).toContain("- After 5 agent posts without @user, the chat pauses.");
    expect(text).toContain("@codex1 (Codex, shop-orders, reviewer)");
  });

  test("with no cap, the join message says the chat never pauses on its own and when to stop it", () => {
    const c = chat();
    c.cap = 0;
    const text = joinMessage(c, addMember(c, { kind: "claude", windowId: "@3" }, T), { home: HOME });
    expect(text).toContain(`- No cap: the chat never pauses on its own. If the exchange goes in circles, mux stop "<reason>".`);
    expect(text).not.toContain("After 0 agent posts");
  });
});

describe("who and read", () => {
  test("who lists members with kind, folder, role and state", () => {
    const c = chat();
    const out = whoText(c, (m) => (m.handle === "claude1" ? "working" : "idle"), { home: HOME });
    expect(out).toBe(
      [
        "› @user      the human",
        "◆ @claude1   Claude · ~/github/shop-orders · driver · working",
        "▲ @codex1    Codex · ~/github/shop-orders · reviewer · idle",
      ].join("\n"),
    );
  });

  test("read shows the last n lines with ids", () => {
    const c = chat();
    post(c, "user", "@claude1 a", T);
    post(c, "claude1", "b", T);
    post(c, "codex1", "c", T);
    expect(readText(c, 2)).toBe("#2 @claude1: b\n#3 @codex1: c");
  });
});

describe("unescapeNewlines", () => {
  test("a post with only literal backslash-n gets real line breaks", () => {
    expect(unescapeNewlines("Plan:\\n\\n1. one\\n2. two")).toBe("Plan:\n\n1. one\n2. two");
  });
  test("a post that already has a real line break is left alone", () => {
    expect(unescapeNewlines("a\nb \\n c")).toBe("a\nb \\n c");
    expect(unescapeNewlines("one line")).toBe("one line");
  });
});
