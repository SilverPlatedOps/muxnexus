import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMember, leave, missedFor, newChat, post, reveal, setBrief, setMode, startRound, stop, summary } from "../src/server/chat/model";
import { createChatService, parseChatMessage } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";
import { deliveryText, handoffText, header, joinMessage, readText } from "../src/server/chat/text";
import type { Chat } from "../src/shared/chat";
import { CHAT_RULES_VERSION } from "../src/shared/chat-rules";

const T = "2026-10-26T12:00:00.000Z";
const HOME = "/Users/me";

function chatWith(...kinds: ("claude" | "codex")[]): Chat {
  const c = newChat("c1", "shop review", T, 0);
  for (const kind of kinds) addMember(c, { kind, windowId: `@${c.members.length}` }, T);
  return c;
}
const states = (c: Chat, id: number) =>
  Object.fromEntries(Object.entries(c.messages.find((m) => m.id === id)!.deliveries).map(([h, d]) => [h, d.state]));
const member = (c: Chat, h: string) => c.members.find((m) => m.handle === h)!;

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxn-modes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function serviceIn(gate?: Promise<void>) {
  const sends: { handle?: string; text: string }[] = [];
  const info = (kind: "claude" | "codex", pane: string) => ({ paneId: pane, kind, pid: kind === "claude" ? 11 : 22, state: "done" as const, since: 1, fresh: true, ...(kind === "codex" ? { thread: { id: "th", path: "/tmp/r.jsonl" } } : { conversation: { sessionId: "s", transcriptPath: "/tmp/c.jsonl" } }) });
  const svc = createChatService({
    store: createChatStore(dir),
    tmux: {
      windowOfPane: async (p) => ({ windowId: p === "%1" ? "@1" : "@2", session: "shop" }),
      agentOfWindow: async (w) => (w === "@1" ? info("claude", "%1") : info("codex", "%2")) as never,
    },
    states: async () => new Map([["@1", { state: "done" as const, session: "shop" }], ["@2", { state: "done" as const, session: "shop" }]]),
    adapters: {
      claude: { kind: "claude", send: async (_t, text) => { sends.push({ text }); return { ok: true }; } },
      codex: { kind: "codex", send: async (_t, text) => { sends.push({ text }); return { ok: true }; } },
    },
    socketOf: async () => { await gate; return null; },
    receipt: async () => true,
    alive: () => true,
    now: () => T,
    home: HOME,
  });
  const r = await svc.handle({ t: "chat-create", name: "t", members: [{ windowId: "@1" }, { windowId: "@2" }] });
  return { svc, id: (r as { chatId: string }).chatId, sends };
}

const service = serviceIn;

describe("mode", () => {
  test("a chat with no mode keeps the general rules", () => {
    const c = chatWith("claude", "codex");
    const text = joinMessage(c, member(c, "codex1"), { home: HOME });
    expect(text).toContain("- Work within the user's request.");
    expect(text).not.toContain("Brainstorm:");
  });

  test("each mode swaps the driver/reviewer rules in the join message", () => {
    const c = chatWith("claude", "codex");
    setMode(c, "brainstorm", T);
    const text = joinMessage(c, member(c, "codex1"), { home: HOME });
    expect(text).toContain("If you only agree, say nothing.");
    expect(text).not.toContain("- Work within the user's request.");
    expect(text).toContain("- mux stop ends the exchange");
  });

  test("changing the mode is a system line that wakes nobody", () => {
    const c = chatWith("claude", "codex");
    setMode(c, "review", T);
    const msg = c.messages.at(-1)!;
    expect(msg).toMatchObject({ system: true, text: "mode is now review", deliveries: {} });
    setMode(c, "review", T);
    expect(c.messages).toHaveLength(1);
    setMode(c, undefined, T);
    expect(c.mode).toBeUndefined();
  });

  test("a welcomed member is told a changed mode with its next wake, once it has gone", () => {
    const c = chatWith("claude", "codex");
    const codex = member(c, "codex1");
    codex.welcomed = true;
    setMode(c, "investigate", T);
    const msg = post(c, "user", "@codex1 look", T);
    const text = deliveryText(c, codex, msg, missedFor(c, "codex1", msg.id));
    expect(text).toContain("Mode:    now investigate. Rules from here:");
    expect(text).toContain("hypothesis");
    // A delivery records the rules and the mode it carried together.
    Object.assign(codex, { modeSent: "investigate", rulesSent: CHAT_RULES_VERSION });
    expect(deliveryText(c, codex, msg, { lines: [], older: 0 })).not.toContain("Mode:");
  });
});

describe("brief", () => {
  test("a changed brief is a new revision; the same words are not", () => {
    const c = chatWith("claude");
    expect(setBrief(c, "  ship the cap fix  ", T)).toBe(true);
    expect(c.brief).toEqual({ text: "ship the cap fix", rev: 1, at: T });
    expect(setBrief(c, "ship the cap fix", T)).toBe(false);
    expect(setBrief(c, "ship the cap fix, no UI", T)).toBe(true);
    expect(c.brief!.rev).toBe(2);
    expect(c.messages.at(-1)!.text).toBe("brief updated (rev 2)");
  });

  test("clearing keeps the revision count going so an agent is told", () => {
    const c = chatWith("claude");
    setBrief(c, "a", T);
    setBrief(c, "", T);
    expect(c.brief).toEqual({ text: "", rev: 2, at: T });
    const a = member(c, "claude1");
    a.welcomed = true;
    a.briefSent = 1;
    const msg = post(c, "user", "@claude1 hi", T);
    expect(deliveryText(c, a, msg, { lines: [], older: 0 })).toContain("Brief:   cleared by @user");
  });

  test("a brief cleared before a member was ever shown one says nothing to it", () => {
    const c = chatWith("claude");
    setBrief(c, "a", T);
    setBrief(c, "", T);
    const a = member(c, "claude1");
    a.welcomed = true;
    const msg = post(c, "user", "@claude1 hi", T);
    expect(deliveryText(c, a, msg, { lines: [], older: 0 })).not.toContain("Brief:");
  });

  test("a member in a fresh conversation is given the brief again, though it had this revision before", () => {
    const c = chatWith("claude");
    setBrief(c, "goal: X", T);
    const a = member(c, "claude1");
    a.welcomed = false;
    a.briefSent = 1;
    const msg = post(c, "user", "@claude1 hi", T);
    expect(deliveryText(c, a, msg, { lines: [], older: 0 })).toContain("goal: X");
  });

  test("a delivery carries the brief only to a member that hasn't had this revision", () => {
    const c = chatWith("claude", "codex");
    setBrief(c, "goal: fix X\nno UI files", T);
    const a = member(c, "claude1");
    a.welcomed = true;
    const msg = post(c, "user", "@claude1 go", T);
    const text = deliveryText(c, a, msg, { lines: [], older: 0 });
    expect(text).toContain("Brief:   from @user, rev 1; it replaces any earlier brief:\n         goal: fix X\n         no UI files");
    a.briefSent = 1;
    expect(deliveryText(c, a, msg, { lines: [], older: 0 })).not.toContain("Brief:");
  });
});

describe("handoff", () => {
  test("the question comes first and the excerpt is fenced beyond any fence inside it", () => {
    const text = handoffText(["codex1"], "Is this right?", "code:\n```ts\nx\n```\n", { label: "claude1's answer", repo: "muxnexus", revision: "966f75f" });
    expect(text).toBe("@codex1 Is this right?\n\nExcerpt (claude1's answer · muxnexus · @ 966f75f):\n````\ncode:\n```ts\nx\n```\n````");
  });

  test("a handoff reaches the agents it names, with its source on the line", async () => {
    const { svc, id } = await service();
    const r = await svc.handle({ t: "chat-handoff", id, to: ["codex1"], question: "Check it.", excerpt: "diff here", label: "diff", repo: "muxnexus" });
    expect(r).toEqual({ ok: true, chatId: id });
    const chat = (await svc.view(id))!.chat;
    const msg = chat.messages.at(-1)!;
    expect(msg.handoff).toEqual({ label: "diff", repo: "muxnexus" });
    expect(Object.keys(msg.deliveries)).toEqual(["codex1"]);
  });

  test("an @name inside the excerpt wakes nobody, and a participant of an open round can't be handed one", async () => {
    const { svc, id } = await service();
    await svc.handle({ t: "chat-handoff", id, to: ["codex1"], question: "Check it.", excerpt: "@Override // cc @claude", label: "diff" });
    const msg = (await svc.view(id))!.chat.messages.at(-1)!;
    expect(msg.to).toEqual(["codex1"]);
    expect(Object.keys(msg.deliveries)).toEqual(["codex1"]);
    await svc.handle({ t: "chat-round", id, action: "start", topic: "t" });
    expect((await svc.handle({ t: "chat-handoff", id, to: ["codex1"], question: "q", excerpt: "e", label: "x" })).ok).toBe(false);
  });

  test("a handoff to nobody, to someone not in the chat, or with nothing in it is refused", async () => {
    const { svc, id } = await service();
    for (const to of [[], ["codex9"], ["user"]]) {
      expect(await svc.handle({ t: "chat-handoff", id, to, question: "q", excerpt: "e", label: "x" })).toEqual({ ok: false, error: "Pick agents that are still in the chat." });
    }
    expect(await svc.handle({ t: "chat-handoff", id, to: ["codex1"], question: " ", excerpt: "e", label: "x" })).toEqual({ ok: false, error: "A handoff needs a question and an excerpt." });
  });
});

describe("blind round", () => {
  test("starting wakes every agent and asks for independent evidence", () => {
    const c = chatWith("claude", "codex");
    expect(startRound(c, "why does X fail", T)).toBeNull();
    const msg = c.messages.at(-1)!;
    expect(msg.from).toBe("user");
    expect(msg.text).toContain("@claude1 @codex1 Independent round r1: why does X fail");
    expect(states(c, msg.id)).toEqual({ claude1: "queued", codex1: "queued" });
    expect(c.round).toMatchObject({ state: "open", participants: ["claude1", "codex1"], submitted: [] });
  });

  test("an ordinary post from an older turn is withheld but doesn't answer the round", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const stale = post(c, "claude1", "finished the old task", T);
    expect(stale.blind).toBe(true);
    expect(c.round!.submitted).toEqual([]);
    post(c, "codex1", "race", T, { submit: true });
    expect(c.round!.state).toBe("open");
    post(c, "claude1", "cache", T, { submit: true });
    expect(c.round!.state).toBe("revealed");
  });

  test("ending a round before the kickoff went out cancels it", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    reveal(c, T);
    expect(states(c, 1)).toEqual({ claude1: "cancelled", codex1: "cancelled" });
    expect(c.messages.at(-1)!.text).toBe("round revealed; no post from @claude1 @codex1");
    expect(c.messages).toHaveLength(2);
  });

  test("ending a round after one kickoff went out cancels the other and tells the one that has it", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    c.messages[0]!.deliveries.claude1 = { state: "queued", reason: "sent", at: T };
    reveal(c, T);
    expect(states(c, 1)).toEqual({ claude1: "queued", codex1: "cancelled" });
    const note = c.messages.at(-1)!;
    expect(note.text).toContain("The round is over");
    expect(Object.keys(note.deliveries)).toEqual(["claude1"]);
  });

  test("an automatic reveal doesn't lift a stop, and tells only members still in the chat", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    c.messages[0]!.deliveries.claude1 = { state: "delivered", at: T };
    c.messages[0]!.deliveries.codex1 = { state: "delivered", at: T };
    post(c, "claude1", "cache", T, { submit: true });
    stop(c, "claude1", "done", T);
    leave(c, "codex1", T);
    expect(c.round!.state).toBe("revealed");
    expect(c.paused).toMatchObject({ reason: "stop" });
    const last = c.messages.at(-1)!;
    expect(last.text).toContain("round revealed");
    expect(c.messages.some((m) => m.auto)).toBe(false);
  });

  test("a notice to an agent that never answered is the room's, held while paused", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    c.messages[0]!.deliveries.claude1 = { state: "queued", reason: "sent", at: T };
    stop(c, "codex1", "pause", T);
    c.agentRun = 5;
    reveal(c, T);
    const note = c.messages.at(-1)!;
    expect(note.auto).toBe(true);
    expect(note.deliveries.claude1!.state).toBe("held");
    expect(c.paused).toMatchObject({ reason: "stop" });
    expect(c.agentRun).toBe(5);
    expect(header(c, note)).toBe("[muxnexus · shop review · #" + note.id + " · from muxnexus · the room, not the user]");
  });

  test("the room's notice reads as the room's in a delivery and in mux read", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    c.messages[0]!.deliveries.claude1 = { state: "delivered", at: T };
    reveal(c, T);
    const note = c.messages.at(-1)!;
    expect(readText(c, 5)).toContain(`#${note.id} muxnexus (the room, not the user): @claude1 The round is over`);
    const a = member(c, "claude1");
    a.welcomed = true;
    const msg = post(c, "codex1", "@claude1 hi", T);
    expect(deliveryText(c, a, msg, { lines: [note], older: 0 })).toContain(`History (retrieve if relevant): #${note.id} @muxnexus`);
    expect(deliveryText(c, a, note, { lines: [], older: 0 })).toContain("muxnexus (the room, not the user): @claude1 The round is over");
  });

  test("a room notice doesn't count as the human answering a question to them", () => {
    const c = chatWith("claude", "codex");
    post(c, "claude1", "@user which one?", T);
    post(c, "user", "x", T, { system: true });
    post(c, "user", "The round is over", T, { auto: true });
    expect(summary(c, () => undefined).glyph).toBe("input");
    post(c, "user", "the first", T);
    expect(summary(c, () => undefined).glyph).not.toBe("input");
  });

  test("the round prompt names the round and gives the exact command", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    expect(c.round!.id).toBe("r1");
    expect(c.messages[0]!.text).toContain('mux submit --chat c1 r1 "<your hypothesis and evidence>"');
  });

  test("needs two agents, and only one round at a time", () => {
    const solo = chatWith("claude");
    expect(startRound(solo, "x", T)).toBe("A blind round needs at least two agents in the chat.");
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    expect(startRound(c, "y", T)).toBe("A round is already open: end it first.");
  });

  test("a post in the round is held from its peer, even when it mentions them", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const a = post(c, "claude1", "@codex1 it is the cache", T, { submit: true });
    expect(a.blind).toBe(true);
    expect(a.deliveries).toEqual({});
    expect(c.round!.submitted).toEqual(["claude1"]);
    expect(missedFor(c, "codex1", a.id + 1).lines.map((m) => m.id)).not.toContain(a.id);
    expect(readText(c, 10, "codex1")).not.toContain("the cache");
    expect(readText(c, 10, "claude1")).toContain("the cache");
    expect(readText(c, 10)).toContain("the cache");
  });

  test("it reveals itself once everyone has posted, and each hears the other", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const a = post(c, "claude1", "cache", T, { submit: true });
    const b = post(c, "codex1", "race", T, { submit: true });
    expect(c.round!.state).toBe("revealed");
    expect(a.blind).toBeUndefined();
    expect(b.blind).toBeUndefined();
    expect(states(c, a.id)).toEqual({ codex1: "queued" });
    expect(states(c, b.id)).toEqual({ claude1: "queued" });
    expect(c.messages.at(-1)).toMatchObject({ system: true, text: "round revealed" });
    expect(readText(c, 10, "codex1")).toContain("cache");
  });

  test("the user can end it early, naming who never posted", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const a = post(c, "claude1", "cache", T, { submit: true });
    expect(reveal(c, T)).toBe(true);
    expect(states(c, a.id)).toEqual({ codex1: "queued" });
    expect(c.messages.at(-1)!.text).toBe("round revealed; no post from @codex1");
    expect(reveal(c, T)).toBe(false);
  });

  test("an agent that leaves doesn't hold the round open", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    post(c, "claude1", "cache", T, { submit: true });
    leave(c, "codex1", T);
    expect(c.round!.state).toBe("revealed");
  });

  test("a blind post that names an outsider holds that too until the reveal", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const late = addMember(c, { kind: "claude", windowId: "@9" }, T);
    const a = post(c, "claude1", `@${late.handle} fyi`, T, { submit: true });
    expect(a.deliveries).toEqual({});
    post(c, "codex1", "b", T, { submit: true });
    expect(states(c, a.id)).toEqual({ codex1: "queued", [late.handle]: "queued" });
  });

  test("blind posts don't count toward the cap", () => {
    const c = newChat("c1", "x", T, 2);
    for (const k of ["claude", "codex", "claude"] as const) addMember(c, { kind: k, windowId: `@${c.members.length}` }, T);
    startRound(c, "x", T);
    post(c, "claude1", "a", T, { submit: true });
    post(c, "codex1", "b", T, { submit: true });
    expect(c.paused).toBeUndefined();
    expect(c.agentRun).toBe(0);
  });

  test("a post by someone outside the round, or after it, is ordinary", () => {
    const c = chatWith("claude", "codex");
    startRound(c, "x", T);
    const late = addMember(c, { kind: "claude", windowId: "@9" }, T);
    expect(post(c, late.handle, "@claude1 hi", T).blind).toBeUndefined();
    post(c, "claude1", "a", T, { submit: true });
    post(c, "codex1", "b", T, { submit: true });
    expect(post(c, "claude1", "@codex1 now we talk", T).deliveries).toEqual({ codex1: { state: "queued", at: T } });
  });
});

describe("parseChatMessage", () => {
  test("accepts the new messages with their shape and nothing else", () => {
    expect(parseChatMessage({ t: "chat-mode", id: "a", mode: "review" })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-mode", id: "a", mode: null })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-mode", id: "a", mode: "chaos" })).toBeNull();
    expect(parseChatMessage({ t: "chat-brief", id: "a", text: "x" })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-brief", id: "a" })).toBeNull();
    expect(parseChatMessage({ t: "chat-handoff", id: "a", to: ["x"], question: "q", excerpt: "e", label: "l" })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-handoff", id: "a", to: "x", question: "q", excerpt: "e", label: "l" })).toBeNull();
    expect(parseChatMessage({ t: "chat-round", id: "a", action: "start", topic: "t" })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-round", id: "a", action: "pause" })).toBeNull();
  });
});

describe("through the service", () => {
  test("a changed brief reaches a member on its next wake, then not again", async () => {
    const { svc, id, sends } = await serviceIn();
    await svc.handle({ t: "chat-post", id, text: "@claude1 hello" });
    await svc.tick();
    expect(sends.at(-1)!.text).not.toContain("Brief:");
    await svc.handle({ t: "chat-brief", id, text: "goal: X" });
    await svc.handle({ t: "chat-mode", id, mode: "review" });
    await svc.handle({ t: "chat-post", id, text: "@claude1 again" });
    await svc.tick();
    expect(sends.at(-1)!.text).toContain("goal: X");
    expect(sends.at(-1)!.text).toContain("now review");
    await svc.handle({ t: "chat-post", id, text: "@claude1 third" });
    await svc.tick();
    expect(sends.at(-1)!.text).not.toContain("Brief:");
    expect(sends.at(-1)!.text).not.toContain("Mode:");
  });

  test("each delivery is counted in UTF-8 bytes, without keeping the text", async () => {
    const { svc, id, sends } = await serviceIn();
    await svc.handle({ t: "chat-post", id, text: "@claude1 héllo" });
    await svc.tick();
    const m = (await svc.view(id))!.chat.members.find((x) => x.handle === "claude1")!;
    const bytes = new TextEncoder().encode(sends.at(-1)!.text).length;
    expect(m.payload).toEqual({ count: 1, bytes, last: bytes });
    await svc.handle({ t: "chat-post", id, text: "@claude1 again" });
    await svc.tick();
    expect((await svc.view(id))!.chat.members.find((x) => x.handle === "claude1")!.payload!.count).toBe(2);
  });

  test("mux submit answers the round; a say, a wrong id or a stranger doesn't", async () => {
    const { svc, id } = await serviceIn();
    const hook = (pane: string, agent: "claude" | "codex", ...argv: string[]) => svc.hook({ agent, pane, argv });
    expect((await hook("%1", "claude", "submit", "r1", "too early")).output).toContain("no round is open");
    await svc.handle({ t: "chat-round", id, action: "start", topic: "why" });
    const rid = (await svc.view(id))!.chat.round!.id;
    // An old turn's status, said while the round is open: withheld, not an answer.
    await hook("%1", "claude", "say", "finished the old task");
    expect((await svc.view(id))!.chat.round!.submitted).toEqual([]);
    expect((await hook("%1", "claude", "submit", "r999", "evidence")).output).toContain(`the open round is ${rid}`);
    expect((await hook("%1", "claude", "submit", rid)).output).toContain("nothing to submit");
    expect((await hook("%1", "claude", "submit", rid, "it", "is", "the cache")).output).toContain("held until @codex1 submits");
    expect((await hook("%2", "codex", "read", "20")).output).not.toContain("the cache");
    expect((await hook("%2", "codex", "submit", rid, "a race")).output).toContain("the round is revealed");
    expect((await svc.view(id))!.chat.round!.state).toBe("revealed");
  });

  test("a kickoff cancelled while its send is being prepared never reaches the agent", async () => {
    let release!: () => void;
    const { svc, id, sends } = await serviceIn(new Promise<void>((r) => { release = r; }));
    await svc.handle({ t: "chat-round", id, action: "start", topic: "why" });
    const ticking = svc.tick();
    await Bun.sleep(30);
    await svc.handle({ t: "chat-round", id, action: "end" });
    release();
    await ticking;
    expect(sends).toEqual([]);
    const chat = (await svc.view(id))!.chat;
    expect(chat.messages.find((m) => m.id === chat.round!.kickoff)!.deliveries.claude1!.state).toBe("cancelled");
  });

  test("two chats with the same round id: a scoped submit lands in the chat it names", async () => {
    const { svc, id } = await serviceIn();
    const second = (await svc.handle({ t: "chat-create", name: "other", members: [{ windowId: "@1" }, { windowId: "@2" }] })) as { chatId: string };
    await svc.handle({ t: "chat-round", id, action: "start", topic: "a" });
    await svc.handle({ t: "chat-round", id: second.chatId, action: "start", topic: "b" });
    const a = (await svc.view(id))!.chat.round!.id;
    const b = (await svc.view(second.chatId))!.chat.round!.id;
    expect(a).toBe(b);
    const r = await svc.hook({ agent: "claude", pane: "%1", argv: ["submit", "--chat", id, a, "for the first"] });
    expect(r.ok).toBe(true);
    expect((await svc.view(id))!.chat.round!.submitted).toEqual(["claude1"]);
    expect((await svc.view(second.chatId))!.chat.round!.submitted).toEqual([]);
  });

  test("an over-long brief and a missing round are refused", async () => {
    const { svc, id } = await serviceIn();
    expect((await svc.handle({ t: "chat-brief", id, text: "x".repeat(4001) })).ok).toBe(false);
    expect(await svc.handle({ t: "chat-round", id, action: "end" })).toEqual({ ok: false, error: "No round is open." });
  });

  test("chats saved before these fields existed load and work", async () => {
    const { svc, id } = await serviceIn();
    const chat = (await svc.view(id))!.chat;
    expect(chat.mode).toBeUndefined();
    expect(chat.brief).toBeUndefined();
    expect(chat.round).toBeUndefined();
    expect((await svc.handle({ t: "chat-post", id, text: "@claude1 hi" })).ok).toBe(true);
  });
});
