import { describe, expect, test } from "bun:test";
import { addMember, discardHeld, leave, missedFor, newChat, post, resolveMentions, stop, summary } from "../src/server/chat/model";
import type { Chat } from "../src/shared/chat";

const T = "2026-10-26T12:00:00.000Z";

function chatWith(...kinds: ("claude" | "codex")[]): Chat {
  const c = newChat("c1", "shop review", T);
  for (const kind of kinds) addMember(c, { kind, windowId: `@${c.members.length}` }, T);
  return c;
}

const states = (c: Chat, id: number) =>
  Object.fromEntries(Object.entries(c.messages.find((m) => m.id === id)!.deliveries).map(([h, d]) => [h, d.state]));

describe("members", () => {
  test("handles count per kind and are never reused", () => {
    const c = chatWith("claude", "codex", "claude");
    leave(c, "claude2", T);
    const next = addMember(c, { kind: "claude", windowId: "@9" }, T);
    expect(next.handle).toBe("claude3");
    expect(c.members.filter((m) => m.kind !== "user").map((m) => [m.handle, m.shape, m.colour])).toEqual([
      ["claude1", "◆", 0],
      ["codex1", "▲", 1],
      ["claude2", "■", 2],
      ["claude3", "◇", 3],
    ]);
  });

  test("the user is a member called user", () => {
    const c = newChat("c1", "x", T);
    expect(c.members).toEqual([{ handle: "user", kind: "user", shape: "›", colour: -1, joinedAt: T }]);
  });
});

describe("mentions", () => {
  test("mentions resolve handles, the bare kind when unique, and user", () => {
    const c = chatWith("claude", "codex");
    expect(resolveMentions(c, "@claude1 and @codex hi @user")).toEqual({ to: ["claude1", "codex1", "user"], unknown: [] });
  });

  test("the bare kind is unknown when two members share it", () => {
    const c = chatWith("claude", "claude");
    expect(resolveMentions(c, "@claude look")).toEqual({ to: [], unknown: ["claude"] });
  });

  test("an email address is not a mention", () => {
    expect(resolveMentions(chatWith("claude"), "mail a@b.com").to).toEqual([]);
  });

  test("a handle followed by punctuation resolves", () => {
    expect(resolveMentions(chatWith("codex"), "thanks @codex1, done").to).toEqual(["codex1"]);
  });

  test("a member who left is no longer a mention", () => {
    const c = chatWith("claude");
    leave(c, "claude1", T);
    expect(resolveMentions(c, "@claude1 hi")).toEqual({ to: [], unknown: ["claude1"] });
  });
});

describe("posting", () => {
  test("only mentioned agents get deliveries; no mention means context only", () => {
    const c = chatWith("claude", "codex");
    const quiet = post(c, "user", "nice", T);
    expect(quiet.deliveries).toEqual({});
    const m = post(c, "user", "@claude1 go", T);
    expect(states(c, m.id)).toEqual({ claude1: "queued" });
  });

  test("an agent never delivers to itself or to the user", () => {
    const c = chatWith("claude");
    const m = post(c, "claude1", "@claude1 @user done", T);
    expect(m.deliveries).toEqual({});
  });

  test("the third agent post pauses the chat and its own deliveries are held", () => {
    const c = chatWith("claude", "codex");
    post(c, "user", "@claude1 start", T);
    post(c, "claude1", "@codex1 review", T);
    post(c, "codex1", "@claude1 two findings", T);
    expect(c.paused).toBeUndefined();
    const third = post(c, "claude1", "@codex1 fixed", T);
    expect(c.paused?.reason).toBe("cap");
    expect(states(c, third.id)).toEqual({ codex1: "held" });
  });

  test("with no cap the chat never pauses on its own", () => {
    const c = chatWith("claude", "codex");
    c.cap = 0;
    for (let i = 0; i < 20; i++) post(c, i % 2 ? "codex1" : "claude1", i % 2 ? "@claude1 again" : "@codex1 again", T);
    expect(c.paused).toBeUndefined();
    expect(states(c, c.messages.at(-1)!.id)).toEqual({ claude1: "queued" });
  });

  test("reaching the cap also holds what was still waiting", () => {
    const c = chatWith("claude", "codex");
    c.cap = 2;
    const waiting = post(c, "claude1", "@codex1 look", T);
    post(c, "codex1", "@claude1 ok", T);
    expect(states(c, waiting.id)).toEqual({ codex1: "held" });
  });

  test("a user message resets the count and releases what was held", () => {
    const c = chatWith("claude", "codex");
    c.cap = 1;
    const held = post(c, "claude1", "@codex1 look", T);
    expect(states(c, held.id)).toEqual({ codex1: "held" });
    const go = post(c, "user", "@claude1 carry on", T);
    expect(c.paused).toBeUndefined();
    expect(c.agentRun).toBe(0);
    expect(states(c, held.id)).toEqual({ codex1: "queued" });
    expect(states(c, go.id)).toEqual({ claude1: "queued" });
  });

  test("an agent speaking to the user or to the room is who the composer pre-fills", () => {
    const c = chatWith("claude", "codex");
    post(c, "claude1", "@user option 1 or 2?", T);
    expect(c.lastSpokeToUser).toBe("claude1");
    post(c, "codex1", "@claude1 agreed", T);
    expect(c.lastSpokeToUser).toBe("claude1");
    post(c, "codex1", "all done here", T);
    expect(c.lastSpokeToUser).toBe("codex1");
  });

  test("a system line delivers nothing and does not count toward the cap", () => {
    const c = chatWith("claude");
    const m = post(c, "claude1", "@claude1 joined", T, { system: true });
    expect(m.deliveries).toEqual({});
    expect(c.agentRun).toBe(0);
  });
});

describe("stopping and leaving", () => {
  test("stop pauses with the reason and holds what was queued", () => {
    const c = chatWith("claude", "codex");
    const m = post(c, "claude1", "@codex1 review", T);
    stop(c, "codex1", "approved", T);
    expect(c.paused).toEqual({ reason: "stop", detail: "approved", by: "codex1" });
    expect(states(c, m.id)).toEqual({ codex1: "held" });
    expect(c.messages.at(-1)).toMatchObject({ system: true, text: "codex1 stopped the exchange: approved" });
  });

  test("leave cancels pending deliveries and posts a system line", () => {
    const c = chatWith("claude", "codex");
    const m = post(c, "claude1", "@codex1 review", T);
    leave(c, "codex1", T);
    expect(c.messages.find((x) => x.id === m.id)!.deliveries.codex1).toMatchObject({ state: "cancelled", reason: "left" });
    expect(c.members.find((x) => x.handle === "codex1")!.left).toBe(true);
    expect(c.messages.at(-1)).toMatchObject({ system: true, text: "codex1 left" });
  });

  test("discardHeld cancels held only", () => {
    const c = chatWith("claude", "codex");
    c.cap = 1;
    const held = post(c, "claude1", "@codex1 look", T);
    c.messages.push({ id: 99, from: "user", text: "x", at: T, to: ["claude1"], deliveries: { claude1: { state: "delivered", at: T } } });
    expect(discardHeld(c)).toBe(1);
    expect(c.messages.find((x) => x.id === held.id)!.deliveries.codex1).toMatchObject({ state: "cancelled", reason: "discarded" });
    expect(c.messages.find((x) => x.id === 99)!.deliveries.claude1.state).toBe("delivered");
  });
});

describe("catching up", () => {
  test("missedFor returns the lines after lastSeq, capped, with the older count", () => {
    const c = chatWith("claude", "codex");
    for (let i = 0; i < 7; i++) post(c, "user", `line ${i}`, T);
    const now = post(c, "user", "@codex1 your turn", T);
    const got = missedFor(c, "codex1", now.id, 4);
    expect(got.lines.map((l) => l.text)).toEqual(["line 3", "line 4", "line 5", "line 6"]);
    expect(got.older).toBe(3);
  });

  test("the room's own lines are not missed", () => {
    const c = chatWith("claude", "codex");
    post(c, "claude1", "claude1 joined", T, { system: true });
    const now = post(c, "user", "@codex1 go", T);
    expect(missedFor(c, "codex1", now.id).lines).toEqual([]);
  });

  test("an agent's own posts and lines it already has are not missed", () => {
    const c = chatWith("claude", "codex");
    post(c, "codex1", "mine", T);
    const now = post(c, "user", "@codex1 next", T);
    expect(missedFor(c, "codex1", now.id).lines).toEqual([]);
  });
});

describe("summary", () => {
  test("a chat whose newest question to the user is unanswered asks for input", () => {
    const c = chatWith("claude");
    post(c, "claude1", "@user which one?", T);
    expect(summary(c, () => undefined).glyph).toBe("input");
    post(c, "user", "the first", T);
    expect(summary(c, () => undefined).glyph).toBe("seen");
  });

  test("a stopped chat needs the user; one paused at the cap says paused; a working one running", () => {
    const c = chatWith("claude");
    stop(c, "claude1", "done", T);
    expect(summary(c, () => undefined).glyph).toBe("input");
    const p = chatWith("claude");
    p.cap = 1;
    post(p, "claude1", "one more thing", T);
    expect(summary(p, () => undefined).glyph).toBe("paused");
    const d = chatWith("claude");
    expect(summary(d, () => "running")).toMatchObject({ glyph: "running", members: 1, name: "shop review", archived: false });
  });
});
