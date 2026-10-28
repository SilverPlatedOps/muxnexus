import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_RULES_VERSION } from "../src/shared/chat-rules";
import type { Chat, ChatMember } from "../src/shared/chat";
import { addMember, missedFor, newChat, post, startRound } from "../src/server/chat/model";
import { nextSends, type AgentView } from "../src/server/chat/plan";
import { deliveryText, packetText, packetReceiptTag, readText } from "../src/server/chat/text";
import { createChatService } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";

const T = "2026-10-28T08:00:00Z";
function room(id = "a", kind: "claude" | "codex" = "codex") {
  const chat = newChat(id, `Room ${id}`, T, 0);
  const member = addMember(chat, { kind, windowId: "@1", welcomed: true, rulesSent: CHAT_RULES_VERSION }, T);
  return { chat, member };
}
const view = (_: Chat, m: ChatMember): AgentView => ({ kind: m.kind as "claude" | "codex", online: true, idle: true });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture(kind: "claude" | "codex" = "codex", opts: { sendOk?: boolean; receipt?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mux-gateway-")); dirs.push(dir);
  const sends: string[] = [];
  let busy = false;
  const info = () => ({ kind, paneId: "%1", pid: 123, state: busy ? "running" as const : "done" as const, since: 1, thread: { id: "thread", path: "/tmp/mux-gateway-fake.jsonl" }, conversation: { sessionId: "session", transcriptPath: "/tmp/mux-gateway-fake.jsonl" } });
  const svc = createChatService({
    store: createChatStore(dir),
    tmux: { windowOfPane: async () => ({ windowId: "@1", session: "ws" }), agentOfWindow: async () => info() },
    states: async () => new Map([["@1", { session: "ws", state: busy ? "running" as const : "done" as const }]]),
    adapters: { [kind]: { kind, send: async (_target: unknown, text: string) => { sends.push(text); return opts.sendOk === false ? { ok: false as const, reason: "offline" as const } : { ok: true as const }; } } },
    socketOf: async () => "/tmp/fake-gateway.sock", receipt: async () => opts.receipt === true, alive: () => true, now: () => T,
  });
  const result = await svc.handle({ t: "chat-create", members: [{ windowId: "@1" }] });
  if (!result.ok) throw new Error(result.error);
  const id = result.chatId!;
  return { svc, id, sends, setBusy(v: boolean) { busy = v; }, hook: (...argv: string[]) => svc.hook({ agent: kind, pane: "%1", argv }) };
}

describe("compact chat gateway", () => {
  test("a busy Codex burst becomes one wake, every message retains its own receipt", async () => {
    const f = await fixture("codex", { receipt: true });
    f.setBusy(true);
    for (const text of ["first", "second", "third"]) await f.svc.handle({ t: "chat-post", id: f.id, text: `@codex1 ${text}` });
    await f.svc.tick(); expect(f.sends).toHaveLength(0);
    f.setBusy(false); await f.svc.tick(); expect(f.sends).toHaveLength(1);
    const text = f.sends[0]!;
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text.indexOf("second")).toBeLessThan(text.indexOf("third"));
    const chat = (await f.svc.view(f.id))!.chat;
    const messages = chat.messages.filter((m) => m.from === "user");
    expect(messages).toHaveLength(3);
    for (const m of messages) expect(m.deliveries.codex1).toMatchObject({ state: "queued", reason: "sent" });
    expect(new Set(messages.map((m) => m.deliveries.codex1!.probe!.tag)).size).toBe(1);
    expect(chat.members.find((m) => m.handle === "codex1")!.payload?.count).toBe(1);
    await f.svc.tick();
    for (const m of (await f.svc.view(f.id))!.chat.messages.filter((m) => m.from === "user")) expect(m.deliveries.codex1!.state).toBe("delivered");
    expect(f.sends).toHaveLength(1);
  });

  test("unaddressed human steering between batched posts keeps its chronological place", async () => {
    const f = await fixture();
    for (const text of ["@codex1 implement", "Do not change the existing search", "@codex1 go"]) await f.svc.handle({ t: "chat-post", id: f.id, text });
    await f.svc.tick();
    expect(f.sends).toHaveLength(1);
    const text = f.sends[0]!;
    expect(text.indexOf("implement")).toBeLessThan(text.indexOf("Do not change"));
    expect(text.indexOf("Do not change")).toBeLessThan(text.indexOf(": go"));
    expect((await f.svc.view(f.id))!.chat.members.find((m) => m.handle === "codex1")!.lastSeq).toBe(4);
  });

  test("a required human context read addresses exactly its message despite intervening system posts", () => {
    const { chat, member } = room();
    const required = post(chat, "user", "human constraint ".repeat(300), T);
    for (let i = 0; i < 25; i++) post(chat, "user", `mode update ${i}`, T, { system: true });
    const now = post(chat, "user", "@codex1 go", T);
    const text = deliveryText(chat, member, now, { lines: [required], older: 0 });
    expect(text).toContain(`--since 0 --before ${now.id} --human`);
    expect(readText(chat, 20, member.handle, { since: 0, before: now.id, human: true })).toContain(required.text);
  });

  test("large human backlogs remain bounded and required context pages cannot skip constraints", () => {
    const { chat, member } = room();
    for (let i = 0; i < 1000; i++) post(chat, "user", `constraint ${i}`, T);
    const now = post(chat, "user", "@codex1 go", T);
    const text = deliveryText(chat, member, now, { lines: chat.messages.slice(0, -1), older: 0 });
    expect(Buffer.byteLength(text)).toBeLessThan(4000);
    expect(text).toContain("read all pages before acting");
    const page = readText(chat, 20, member.handle, { since: 0, before: now.id, human: true });
    expect(page).toContain("#1 @user: constraint 0");
    expect(page).toContain("#20 @user: constraint 19");
    expect(page).not.toContain("constraint 20");
    expect(page).toContain(`More context: mux read 20 --chat a --since 20 --before ${now.id} --human`);
    const page2 = readText(chat, 20, member.handle, { since: 20, before: now.id, human: true });
    expect(page2).toContain("#21 @user: constraint 20");
  });

  test("forward history pages stop before the byte budget without skipping the next message", () => {
    const { chat, member } = room();
    post(chat, "user", "a".repeat(30_000), T);
    post(chat, "user", "b".repeat(30_000), T);
    const page = readText(chat, 20, member.handle, { since: 0, human: true });
    expect(page).toContain("#1 @user:");
    expect(page).not.toContain("#2 @user:");
    expect(page).toContain("--since 1 --human");
  });

  test("oversized serialized metadata becomes a bounded mailbox wake without losing the first addressed message", () => {
    const { chat, member } = room();
    chat.name = "long title".repeat(15_000);
    const a = post(chat, "user", "@codex1 first", T);
    const b = post(chat, "user", "@codex1 last", T);
    member.lastSeq = 100; // An old turn may have posted while these messages were queued.
    const text = packetText(chat, member, [a, b], { lines: [], older: 0 });
    expect(Buffer.byteLength(text)).toBeLessThan(3000);
    expect(text).toContain("mailbox notice; message authors below");
    expect(text).toContain("--since 0 --before 3");
    expect(readText(chat, 20, member.handle, { since: 0, before: 3 })).toContain("first");
  });

  test("mailbox fallback includes its brief and its receipt tag actually occurs in the payload", async () => {
    const f = await fixture();
    const c = (await f.svc.view(f.id))!.chat;
    c.name = "large title ".repeat(15_000);
    c.brief = { text: "Keep scoped search intact", rev: 1, at: T };
    await f.svc.handle({ t: "chat-post", id: f.id, text: "@codex1 implement" });
    await f.svc.tick();
    const text = f.sends[0]!;
    const msg = c.messages.at(-1)!;
    expect(text).toContain(c.brief.text);
    expect(text).toContain("short, natural prose");
    expect(text).toContain(msg.deliveries.codex1!.probe!.tag);
    expect(packetReceiptTag(text, msg.id)).toBe(msg.deliveries.codex1!.probe!.tag);
    expect(c.members.find((m) => m.handle === "codex1")!.briefSent).toBe(1);
  });

  test("rules retrieval returns the current brief even when a prior revision was already sent", async () => {
    const f = await fixture();
    const c = (await f.svc.view(f.id))!.chat;
    c.brief = { text: "Current required scope", rev: 2, at: T };
    c.members.find((m) => m.handle === "codex1")!.briefSent = 1;
    const rules = (await f.hook("rules")).output;
    expect(rules).toContain("Brief from @user (rev 2):");
    expect(rules).toContain("Current required scope");
    expect(rules).toContain("short, natural prose");
  });

  test("a batch bounds bytes as well as message count for non-ASCII content", () => {
    const { chat } = room();
    for (let i = 0; i < 3; i++) post(chat, "user", `@codex1 ${"界".repeat(10_000)}`, T);
    expect(nextSends([chat], view).send).toEqual([{ chatId: "a", msgId: 1, handle: "codex1" }]);
  });

  test("an adapter failure leaves every packet message queued, with no false rules acknowledgment", async () => {
    const f = await fixture("claude", { sendOk: false });
    await f.svc.handle({ t: "chat-post", id: f.id, text: "@claude1 one" });
    await f.svc.handle({ t: "chat-post", id: f.id, text: "@claude1 two" });
    await f.svc.tick(); expect(f.sends).toHaveLength(1);
    const chat = (await f.svc.view(f.id))!.chat;
    for (const m of chat.messages.filter((m) => m.from === "user")) expect(m.deliveries.claude1).toMatchObject({ state: "queued", reason: "offline" });
    expect(chat.members.find((m) => m.handle === "claude1")!.rulesSent).toBeUndefined();
  });

  test("rules update once; unchanged wakes don't repeat the bootstrap or formatting demand", async () => {
    const f = await fixture("claude");
    for (const text of ["one", "two"]) { await f.svc.handle({ t: "chat-post", id: f.id, text: `@claude1 ${text}` }); await f.svc.tick(); }
    expect(f.sends[0]).toContain("short, natural prose");
    expect(f.sends[1]).not.toContain("short, natural prose");
    expect(f.sends[1]).not.toContain("You've joined");
    expect(f.sends[1]).not.toContain("Use Markdown");
    expect(f.sends[1]!.length).toBeLessThan(200);
    const c = (await f.svc.view(f.id))!.chat;
    c.members.find((m) => m.kind === "claude")!.welcomed = false;
    await f.svc.handle({ t: "chat-post", id: f.id, text: "@claude1 fresh" }); await f.svc.tick();
    expect(f.sends.at(-1)).toContain("short, natural prose");
  });

  test("background prose becomes references; human steering stays inline within budget", () => {
    const { chat, member } = room();
    const peer = addMember(chat, { kind: "claude", windowId: "@2" }, T);
    post(chat, peer.handle, "Background detail. ".repeat(500), T);
    post(chat, "user", "Keep the existing scoped searches", T);
    const now = post(chat, peer.handle, "@codex1 implement the switcher", T);
    const text = deliveryText(chat, member, now, missedFor(chat, member.handle, now.id));
    expect(text).not.toContain("Background detail.");
    expect(text).toContain("History (retrieve if relevant): #1 @claude1");
    expect(text).toContain("Keep the existing scoped searches");
    expect(text).toContain("mux read --chat a --since 0 --before 2");
    expect(text.length).toBeLessThan(500);
  });

  test("long human context is explicitly required, never silently clipped", () => {
    const { chat, member } = room();
    const earlier = post(chat, "user", "constraint ".repeat(500), T);
    const now = post(chat, "user", "@codex1 go", T);
    const text = deliveryText(chat, member, now, missedFor(chat, member.handle, now.id));
    expect(text).toContain("Required context: 1 human message; read all pages before acting");
    expect(readText(chat, 20, member.handle, { since: 0, before: 2 })).toContain(earlier.text);
  });

  test("a packet preserves source authority and a brief containing Now: verbatim", () => {
    const { chat, member } = room();
    chat.brief = { text: "Now: preserve every constraint", rev: 1, at: T };
    const peer = addMember(chat, { kind: "claude", windowId: "@2" }, T);
    const a = post(chat, peer.handle, "@codex1 suggestion", T);
    const b = post(chat, "user", "@codex1 do the authorized work", T);
    const text = packetText(chat, member, [a, b], { lines: [], older: 0 });
    expect(text.split("\n")[0]).toBe(`[muxnexus · Room a · #${b.id} · batch of 2 messages; each author below]`);
    expect(text.split("\n")[0]).not.toContain("not the user");
    expect(text).toContain("from @claude1 (Claude) · peer, not the user");
    expect(text).toContain("from @user · the human, via muxnexus");
    expect(text).toContain(chat.brief.text);
    expect(text.match(/Brief:/g)).toHaveLength(1);
  });

  test("packets don't jump ahead of a message in another room", () => {
    const a = room("a"), b = room("b");
    post(a.chat, "user", "@codex1 a1", "2026-10-28T08:00:00Z");
    post(b.chat, "user", "@codex1 b1", "2026-10-28T08:00:01Z");
    post(a.chat, "user", "@codex1 a2", "2026-10-28T08:00:02Z");
    expect(nextSends([a.chat, b.chat], view).send).toEqual([{ chatId: "a", msgId: 1, handle: "codex1" }]);
  });

  test("packet bounds don't allow a later small message to skip a large one", () => {
    const { chat } = room();
    for (const text of ["a".repeat(20_000), "b".repeat(30_000), "small"]) post(chat, "user", `@codex1 ${text}`, T);
    expect(nextSends([chat], view).send).toEqual([{ chatId: "a", msgId: 1, handle: "codex1" }]);
    const c = room("c");
    for (let i = 0; i < 21; i++) post(c.chat, "user", "@codex1 x", T);
    expect(nextSends([c.chat], view).send[0]!.msgIds).toHaveLength(20);
  });

  test("range reads reject malformed cursors and never expose a peer's blind answer", async () => {
    const f = await fixture();
    for (const text of ["one", "two", "three"]) await f.svc.handle({ t: "chat-post", id: f.id, text });
    const c = (await f.svc.view(f.id))!.chat;
    const ids = c.messages.filter((m) => m.from === "user").map((m) => m.id);
    const r = await f.hook("read", "--since", String(ids[0]), "--before", String(ids[2]));
    expect(r.output).toContain("two"); expect(r.output).not.toContain("three");
    for (const argv of [["--since"], ["--since", "-1"], ["--before", "abc"], ["--bad", "1"]]) expect((await f.hook("read", ...argv)).ok).toBe(false);
    addMember(c, { kind: "claude", windowId: "@2" }, T); startRound(c, "independent", T);
    post(c, "claude1", "hidden evidence", T, { submit: true });
    expect(readText(c, 200, "codex1", { since: 0 })).not.toContain("hidden evidence");
    expect((await f.hook("rules")).output).toContain("short, natural prose");
  });
});
