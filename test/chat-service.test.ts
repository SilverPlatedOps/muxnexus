import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AgentTarget } from "../src/server/chat/adapters";
import { createChatService, isLoopback, parseChatMessage, type WindowLive } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";
import type { Said, Where } from "../src/server/chat/turns";
import { Tmux } from "../src/server/tmux";
import type { AgentState } from "../src/shared/protocol";

const tmux = new Tmux("mxn-chat-svc-test");
let dir = "";
let panes: Record<string, { pane: string; window: string }> = {};
let live: Map<string, WindowLive>;
let sends: { kind: string; target: AgentTarget; text: string }[];
let seen: Set<string>;
let saidCalls: { kind: string; path: string; where: Where }[];
let dead: Set<number>;
let closed: string[];
let closeFails: Set<string>;
let saidReply: (kind: string, where: Where) => Said | null;
let clock = 0;

const now = () => new Date(Date.UTC(2026, 9, 26, 12, 0, clock)).toISOString();

async function window(name: string, stamp: string, extra: Record<string, string> = {}) {
  await tmux.run(["new-window", "-t", "=shop:", "-n", name, "-c", homedir()]);
  const [pane, win] = (await tmux.run(["display-message", "-p", "-t", `=shop:${name}`, "#{pane_id} #{window_id}"])).trim().split(" ");
  if (stamp) await tmux.run(["set-option", "-p", "-t", pane!, "@muxnexus_agent", stamp]);
  for (const [k, v] of Object.entries(extra)) await tmux.run(["set-option", "-p", "-t", pane!, k, v]);
  panes[name] = { pane: pane!, window: win! };
  live.set(win!, { state: "done", session: "shop" });
}

function service(over: { agentOfWindow?: typeof tmux.agentOfWindow; adapters?: Partial<Record<"claude" | "codex", Adapter>>; spawn?: () => Promise<string> } = {}) {
  return createChatService({
    store: createChatStore(dir),
    tmux: { windowOfPane: (p) => tmux.windowOfPane(p), agentOfWindow: over.agentOfWindow ?? ((w) => tmux.agentOfWindow(w)) },
    states: async () => live,
    windows: async () => Object.values(panes).map((p) => p.window),
    adapters: {
      claude: { kind: "claude", send: async (target, text) => { sends.push({ kind: "claude", target, text }); return { ok: true }; } },
      codex: { kind: "codex", send: async (target, text) => { sends.push({ kind: "codex", target, text }); return { ok: true }; } },
      ...over.adapters,
    },
    socketOf: async (_dir, pid) => `/tmp/cc-socks/${pid}.sock`,
    receipt: async (_path, tag) => [...seen].some((s) => tag.includes(s)),
    said: async (kind, path, where) => { saidCalls.push({ kind, path, where }); return saidReply(kind, where); },
    alive: (pid) => !dead.has(pid),
    closeWindow: async (w) => { if (closeFails.has(w)) throw new Error(`can't find window: ${w}`); closed.push(w); },
    ...(over.spawn ? { spawn: over.spawn } : {}),
    now,
    home: homedir(),
  });
}

const setState = (name: string, state: AgentState | undefined) => live.set(panes[name]!.window, { state, session: "shop" });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mxn-svc-"));
  panes = {};
  live = new Map();
  sends = [];
  seen = new Set();
  saidCalls = [];
  // As a transcript would read: the message was taken in, and nothing said.
  saidReply = () => ({ text: "", ended: true, start: 0 });
  dead = new Set();
  closed = [];
  closeFails = new Set();
  clock = 0;
  await tmux.killServer();
  await tmux.newSession("shop");
  await window("claude", "done 1790000000 4242 /Users/me/.claude", { "@muxnexus_session": "sid-c /tmp/c.jsonl" });
  await window("codex", "done 1790000000 777 /Users/me/.codex", { "@muxnexus_thread": "th-1 /tmp/r.jsonl" });
});
afterEach(async () => {
  await tmux.killServer();
  rmSync(dir, { recursive: true, force: true });
});

async function newChat(svc: ReturnType<typeof service>, ...names: string[]) {
  const r = await svc.handle({ t: "chat-create", name: "shop review", members: names.map((n) => ({ windowId: panes[n]!.window, role: n === "claude" ? "driver" : "reviewer" })) });
  if (!r.ok) throw new Error(r.error);
  return r.chatId!;
}
const say = (svc: ReturnType<typeof service>, who: string, ...argv: string[]) =>
  svc.hook({ agent: who === "codex" ? "codex" : "claude", pane: panes[who]!.pane, argv });

describe("the hook", () => {
  test("a pane in no chat is refused", async () => {
    const r = await say(service(), "claude", "say", "hello");
    expect(r).toEqual({ ok: false, output: "NOT POSTED: this tab isn't in a muxnexus chat. The user adds it from the Chats tab." });
  });

  test("say posts and reports the id, read and who answer", async () => {
    const svc = service();
    await newChat(svc, "claude", "codex");
    expect(await say(svc, "claude", "say", "@codex1 please review")).toEqual({ ok: true, output: "posted as #3" });
    expect(await say(svc, "codex", "say", "thinking")).toEqual({ ok: true, output: "posted as #4 · context only: nobody was mentioned" });
    expect((await say(svc, "codex", "read", "1")).output).toBe("#4 @codex1: thinking");
    expect((await say(svc, "codex", "who")).output).toContain("◆ @claude1   Claude · ~ · driver · idle");
  });
});

describe("the user's example, end to end", () => {
  test("mentions wake, deliveries are honest, the cap and the user's reply behave", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    await svc.handle({ t: "chat-post", id, text: "@claude1 please add the sync endpoint" });
    await svc.tick();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.kind).toBe("claude");
    expect(sends[0]!.target).toMatchObject({ socketPath: "/tmp/cc-socks/4242.sock", transcript: "/tmp/c.jsonl" });
    expect(sends[0]!.text.split("\n")[0]).toBe("[muxnexus · shop review · #3 · from @user · the human, via muxnexus]");
    expect(sends[0]!.text).toContain(`You've joined muxnexus chat "shop review" as @claude1 (role: driver).`);
    let chat = (await svc.view(id))!.chat;
    expect(chat.messages.at(-1)!.deliveries.claude1).toMatchObject({ state: "queued", reason: "sent" });

    seen.add("#3 ·");
    await svc.tick();
    chat = (await svc.view(id))!.chat;
    expect(chat.messages.at(-1)!.deliveries.claude1!.state).toBe("delivered");

    await say(svc, "claude", "say", "done. @codex1 please review my unstaged changes");
    setState("codex", "running");
    await svc.tick();
    expect(sends).toHaveLength(1);
    setState("codex", "done");
    await svc.tick();
    expect(sends).toHaveLength(2);
    expect(sends[1]!).toMatchObject({ kind: "codex", target: { thread: "th-1", transcript: "/tmp/r.jsonl" } });
    expect(sends[1]!.text).toContain("Missed:  @user → @claude1: please add the sync endpoint");

    await say(svc, "codex", "say", "two findings. What do you think? @claude");
    await say(svc, "claude", "say", "agreed, @user we are thinking option 1 or 2");
    expect((await svc.summaries())[0]!.glyph).toBe("input");
    expect((await svc.view(id))!.chat.paused?.reason).toBe("cap");

    await svc.handle({ t: "chat-post", id, text: "I choose option 1" });
    await svc.handle({ t: "chat-post", id, text: "can you implement @codex?" });
    chat = (await svc.view(id))!.chat;
    expect(chat.paused).toBeUndefined();
    expect(chat.messages.at(-1)!.to).toEqual(["codex1"]);
    seen.add("#4 ·");
    await svc.tick();
    await svc.tick();
    const last = sends.at(-1)!;
    expect(last.kind).toBe("codex");
    expect(last.text).toContain("@user: I choose option 1");
  });
});

describe("honest delivery", () => {
  test("a member whose tab closed waits as offline, and gets it once it's back", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    const gone = await tmux.agentOfWindow(panes.codex!.window);
    let back = false;
    const svc2 = service({ agentOfWindow: async (w) => (w === panes.codex!.window ? (back ? gone : null) : tmux.agentOfWindow(w)) });
    await svc2.handle({ t: "chat-post", id, text: "@codex1 review please" });
    await svc2.tick();
    let chat = (await svc2.view(id))!.chat;
    expect(chat.messages.at(-1)!.deliveries.codex1).toMatchObject({ state: "queued", reason: "offline" });
    expect(sends).toHaveLength(0);
    expect((await svc2.view(id))!.agents.codex1!.online).toBe(false);
    back = true;
    await svc2.tick();
    expect(sends.at(-1)).toMatchObject({ kind: "codex" });
    chat = (await svc2.view(id))!.chat;
    expect(chat.messages.at(-1)!.deliveries.codex1).toMatchObject({ state: "queued", reason: "sent" });
    void svc;
  });

  test("a sent message with no receipt stays queued, never delivered", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 hi" });
    for (let i = 0; i < 3; i++) { clock += 30; await svc.tick(); }
    expect((await svc.view(id))!.chat.messages.at(-1)!.deliveries.claude1).toMatchObject({ state: "queued", reason: "sent" });
  });

  test("a turn the chat started that ends with no post says so", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 hi" });
    await svc.tick();
    seen.add("#2 ·");
    await svc.tick();
    setState("claude", "running");
    await svc.tick();
    setState("claude", "done");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)).toMatchObject({ system: true, text: "claude1 finished without replying" });
  });

  test("a reply that beats the receipt is not reported as finished without replying", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 hi" });
    await svc.tick();
    await say(svc, "claude", "say", "done");
    seen.add("#2 ·");
    await svc.tick();
    setState("claude", "running");
    await svc.tick();
    setState("claude", "done");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.some((m) => m.text.includes("finished without replying"))).toBe(false);
  });

  test("archiving cancels what is waiting and leaves the summary archived", async () => {
    const svc = service();
    const id = await newChat(svc, "codex");
    setState("codex", "running");
    await svc.handle({ t: "chat-post", id, text: "@codex1 one" });
    await svc.handle({ t: "chat-archive", id, archived: true });
    const chat = (await svc.view(id))!.chat;
    expect(chat.messages.at(-1)!.deliveries.codex1).toMatchObject({ state: "cancelled", reason: "archived" });
    expect((await svc.summaries())[0]!.archived).toBe(true);
  });
});

describe("membership", () => {
  test("a Codex tab running in the shared daemon can't join", async () => {
    const svc = service({ agentOfWindow: async (w) => (w === "@99" ? { paneId: "%99", kind: "codex", daemon: true } : tmux.agentOfWindow(w)) });
    const r = await svc.handle({ t: "chat-create", members: [{ windowId: "@99" }] });
    expect(r).toEqual({ ok: false, error: "That Codex tab runs in the shared daemon: restart it with --no-daemon to join." });
  });

  test("a Codex tab with no conversation yet joins, and its messages wait for one", async () => {
    const fresh = { paneId: "%98", kind: "codex" as const, fresh: true, cwd: "/w" };
    let info: Awaited<ReturnType<typeof tmux.agentOfWindow>> = fresh;
    const svc = service({ agentOfWindow: async (w) => (w === "@98" ? info : tmux.agentOfWindow(w)) });
    const r = await svc.handle({ t: "chat-create", members: [{ windowId: "@98" }] });
    expect(r.ok).toBe(true);
    const id = r.ok ? r.chatId! : "";
    await svc.handle({ t: "chat-post", id, text: "@codex1 hi" });
    await svc.tick();
    expect(sends).toHaveLength(0);
    expect((await svc.view(id))!.chat.messages.at(-1)!.deliveries.codex1).toMatchObject({ state: "queued", reason: "no conversation yet" });
    expect((await svc.view(id))!.agents.codex1!.online).toBe(true);
    info = { paneId: "%98", kind: "codex", pid: 5, state: "done", thread: { id: "th-9" } };
    live.set("@98", { state: "done", session: "shop" });
    await svc.tick();
    expect(sends.at(-1)).toMatchObject({ kind: "codex", target: { thread: "th-9" } });
  });

  test("a tab with no agent can't join", async () => {
    await window("shell", "");
    const r = await service().handle({ t: "chat-create", members: [{ windowId: panes.shell!.window }] });
    expect(r).toEqual({ ok: false, error: "No agent is running in that tab." });
  });

  test("a chat with no name is named after its members", async () => {
    const svc = service();
    const r = await svc.handle({ t: "chat-create", members: [{ windowId: panes.claude!.window }, { windowId: panes.codex!.window }] });
    expect((await svc.view(r.ok ? r.chatId! : ""))!.chat.name).toBe("claude1 + codex1 · shop");
  });
});

describe("an agent is the one that joined", () => {
  test("a tab now running another agent gets nothing, and can't post as the member", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await tmux.run(["set-option", "-p", "-t", panes.claude!.pane, "@muxnexus_agent", "done 1790000000 5555 /Users/me/.claude"]);
    await svc.handle({ t: "chat-post", id, text: "@claude1 implement option 1" });
    await svc.tick();
    expect(sends).toHaveLength(0);
    const v = (await svc.view(id))!;
    expect(v.chat.messages.at(-1)!.deliveries.claude1).toMatchObject({ state: "queued", reason: "offline" });
    expect(v.agents.claude1).toMatchObject({ online: false, replaced: true });
    const r = await say(svc, "claude", "say", "hello");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("isn't the one that joined");
  });

  test("a tab on a restarted tmux server is not the member's, even with the same window id", async () => {
    const real = (w: string) => tmux.agentOfWindow(w);
    let other = false;
    const svc = service({ agentOfWindow: async (w) => { const i = await real(w); return i && other ? { ...i, server: "1-1" } : i; } });
    const id = await newChat(svc, "claude");
    other = true;
    await svc.handle({ t: "chat-post", id, text: "@claude1 hi" });
    await svc.tick();
    expect(sends).toHaveLength(0);
  });

  test("the same agent in a new conversation keeps its place and gets the join message again", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 one" });
    await svc.tick();
    seen.add("#2 ·");
    await svc.tick();
    await tmux.run(["set-option", "-p", "-t", panes.claude!.pane, "@muxnexus_session", "sid-new /tmp/c2.jsonl"]);
    await svc.handle({ t: "chat-post", id, text: "@claude1 two" });
    await svc.tick();
    const chat = (await svc.view(id))!.chat;
    expect(chat.members.find((m) => m.handle === "claude1")!.agentId).toBe("sid-new");
    expect(sends.at(-1)!.text).toContain("You've joined muxnexus chat");
  });
});

describe("receipts", () => {
  test("a rename while a message is in flight still finds its receipt", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 hi" });
    await svc.tick();
    await svc.handle({ t: "chat-settings", id, name: "renamed" });
    seen.add("shop review · #2 ·");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.claude1!.state).toBe("delivered");
  });

  test("no two chats share a name, so no two share a receipt", async () => {
    const svc = service();
    const a = await newChat(svc, "claude");
    const b = await newChat(svc, "claude");
    expect((await svc.view(b))!.chat.name).toBe("shop review 2");
    await svc.handle({ t: "chat-settings", id: a, name: "Shop Review 2" });
    expect((await svc.view(a))!.chat.name).toBe("Shop Review 2 2");
  });
});

describe("what is in flight never sticks", () => {
  test("a message handed to a tab that then closed is not confirmed, and the agent's queue moves on", async () => {
    let gone = false;
    const svc = service({ agentOfWindow: async (w) => (w === panes.codex!.window && gone ? null : tmux.agentOfWindow(w)) });
    const id = await newChat(svc, "codex");
    await svc.handle({ t: "chat-post", id, text: "@codex1 one" });
    await svc.tick();
    gone = true;
    // A tab that can't be read for a moment is given half a minute.
    clock += 10;
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.codex1).toMatchObject({ state: "queued", reason: "sent" });
    clock += 25;
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.codex1).toMatchObject({ state: "failed", reason: "not confirmed: its agent went away before reading it" });
    gone = false;
    await svc.handle({ t: "chat-post", id, text: "@codex1 two" });
    await svc.tick();
    expect(sends.map((s) => s.text.includes("two"))).toEqual([false, true]);
  });

  test("a receipt is still found in the transcript it went to while the tab can't be read", async () => {
    let gone = false;
    const svc = service({ agentOfWindow: async (w) => (w === panes.claude!.window && gone ? null : tmux.agentOfWindow(w)) });
    const id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 one" });
    await svc.tick();
    gone = true;
    seen.add("#2 ·");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.claude1!.state).toBe("delivered");
  });

  test("a server stopped mid-send leaves the member unwelcomed, so the next delivery still carries the join message", async () => {
    const hang = service({ adapters: { codex: { kind: "codex", send: () => new Promise(() => {}) } } });
    const id = await newChat(hang, "codex");
    await hang.handle({ t: "chat-post", id, text: "@codex1 one" });
    void hang.tick();
    await Bun.sleep(150);
    const after = (await service().view(id))!.chat;
    expect(after.messages.find((m) => m.id === 2)!.deliveries.codex1).toMatchObject({ state: "queued", reason: "sent" });
    expect(after.members.find((m) => m.handle === "codex1")!.welcomed).toBeUndefined();
  });

  test("five idle minutes with no receipt is not confirmed", async () => {
    const svc = service();
    const id = await newChat(svc, "codex");
    await svc.handle({ t: "chat-post", id, text: "@codex1 one" });
    await svc.tick();
    clock += 301;
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.codex1).toMatchObject({ state: "failed", reason: "not confirmed: no sign it was read in 5 minutes" });
  });

  test("a send that throws fails that delivery only; the rest still go", async () => {
    const svc = service({ adapters: { codex: { kind: "codex", send: async () => { throw new Error("E2BIG"); } } } });
    const id = await newChat(svc, "claude", "codex");
    await svc.handle({ t: "chat-post", id, text: "@codex1 @claude1 go" });
    await svc.tick();
    const d = (await svc.view(id))!.chat.messages.at(-1)!.deliveries;
    expect(d.codex1).toMatchObject({ state: "failed", reason: "unavailable: E2BIG" });
    expect(d.claude1).toMatchObject({ state: "queued", reason: "sent" });
  });

  test("a line too long for a chat is refused at both doors", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    const long = "x".repeat(40_000);
    expect((await svc.handle({ t: "chat-post", id, text: long })).ok).toBe(false);
    const r = await say(svc, "claude", "say", long);
    expect(r.ok).toBe(false);
    expect(r.output).toStartWith("NOT POSTED: too long");
  });
});

describe("an agent in two chats", () => {
  test("it is told which chat to answer, and its reply names the chat", async () => {
    const svc = service();
    const a = await newChat(svc, "claude");
    await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id: a, text: "@claude1 hi" });
    await svc.tick();
    expect(sends[0]!.text.split("\n")[1]).toBe(`Reply with mux say --chat "shop review"; your tab's answer is invisible to the chat. Use Markdown with real line breaks (a quoted heredoc for multiline posts).`);
    expect(await say(svc, "claude", "say", "--chat", "shop review", "hello")).toEqual({ ok: true, output: `posted to "shop review" as #3 · context only: nobody was mentioned` });
  });
});

describe("reconnect", () => {
  test("it finds the member's conversation in another tab and moves the member there", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await tmux.run(["kill-window", "-t", panes.claude!.window]);
    delete panes.claude;
    await window("resumed", "done 1790000000 6000 /Users/me/.claude", { "@muxnexus_session": "sid-c /tmp/c.jsonl" });
    expect(await svc.handle({ t: "chat-reconnect", id, handle: "claude1" })).toMatchObject({ ok: true });
    const m = (await svc.view(id))!.chat.members.find((x) => x.handle === "claude1")!;
    expect([m.windowId, m.pid]).toEqual([panes.resumed!.window, 6000]);
  });

  test("it refuses a tab of another kind, and says so when no tab holds the conversation", async () => {
    const svc = service();
    const id = await newChat(svc, "codex");
    expect(await svc.handle({ t: "chat-reconnect", id, handle: "codex1", windowId: panes.claude!.window })).toMatchObject({ ok: false });
    await tmux.run(["set-option", "-p", "-t", panes.codex!.pane, "@muxnexus_thread", "th-other /tmp/r2.jsonl"]);
    expect(await svc.handle({ t: "chat-reconnect", id, handle: "codex1" })).toEqual({ ok: false, error: "No open tab holds codex1's conversation. Resume it in a tab, then Reconnect." });
  });

  test("a Codex that joined before its first turn takes its thread id once it has one", async () => {
    let info: Awaited<ReturnType<typeof tmux.agentOfWindow>> = { paneId: "%98", kind: "codex", fresh: true, cwd: "/w" };
    const svc = service({ agentOfWindow: async (w) => (w === "@98" ? info : tmux.agentOfWindow(w)) });
    const r = await svc.handle({ t: "chat-create", members: [{ windowId: "@98" }] });
    const id = r.ok ? r.chatId! : "";
    info = { paneId: "%98", kind: "codex", pid: 5, state: "done", thread: { id: "th-9" } };
    await svc.tick();
    expect((await svc.view(id))!.chat.members.find((m) => m.handle === "codex1")).toMatchObject({ agentId: "th-9", pid: 5 });
  });
});

describe("agents started from a chat", () => {
  test("one that hasn't started in time is reported with where to look, and joins once it does", async () => {
    await window("fresh", "");
    const svc = service({ spawn: async () => panes.fresh!.window });
    const r = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "/tmp", session: "shop" }] });
    const id = r.ok ? r.chatId! : "";
    await svc.tick();
    expect((await svc.view(id))!.chat.members.find((m) => m.handle === "claude1")!.spawn).toBe("pending");
    clock += 91;
    await svc.tick();
    let chat = (await svc.view(id))!.chat;
    expect(chat.members.find((m) => m.handle === "claude1")).toMatchObject({ spawn: "failed", spawnError: "nothing has started in its tab yet: check it, it may be waiting on a prompt such as trusting a new folder" });
    expect(chat.messages.at(-1)!.text).toBe("claude1 hasn't started: nothing has started in its tab yet: check it, it may be waiting on a prompt such as trusting a new folder");
    expect(svc.busy()).toBe(true);
    await tmux.run(["set-option", "-p", "-t", panes.fresh!.pane, "@muxnexus_agent", "done 1790000000 5151 /Users/me/.claude"]);
    await svc.tick();
    chat = (await svc.view(id))!.chat;
    const m = chat.members.find((x) => x.handle === "claude1")!;
    expect([m.spawn, m.spawnError, m.pid]).toEqual([undefined, undefined, 5151]);
    expect(chat.messages.at(-1)!.text).toBe("claude1 joined");
  });

  test("a slow one is only taken by an agent of its own kind, and is watched for half an hour", async () => {
    await window("fresh", "");
    const svc = service({ spawn: async () => panes.fresh!.window });
    const r = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "/tmp", session: "shop" }] });
    const id = r.ok ? r.chatId! : "";
    clock += 91;
    await svc.tick();
    await tmux.run(["set-option", "-p", "-t", panes.fresh!.pane, "@muxnexus_agent", "done 1790000000 6161 /Users/me/.codex"]);
    await svc.tick();
    expect((await svc.view(id))!.chat.members.find((m) => m.handle === "claude1")!.spawn).toBe("failed");
    expect(svc.busy()).toBe(true);
    clock += 30 * 60;
    expect(svc.busy()).toBe(false);
  });

  test("one that didn't start keeps what it was asked for, so Retry can ask again", async () => {
    const svc = service({ spawn: async () => { throw new Error("not a folder: Shop orders"); } });
    const r = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "Shop orders", session: "shop", profile: "work", role: "driver" }] });
    const m = (await svc.view(r.ok ? r.chatId! : ""))!.chat.members.find((x) => x.handle === "claude1");
    expect(m).toMatchObject({ kind: "claude", folder: "Shop orders", session: "shop", profile: "work", role: "driver", spawn: "failed" });
  });

  test("one whose tab was closed before it started can be retried", async () => {
    await window("fresh", "");
    const svc = service({ spawn: async () => panes.fresh!.window });
    const r = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "/tmp", session: "shop" }] });
    const id = r.ok ? r.chatId! : "";
    clock += 91;
    await svc.tick();
    await tmux.run(["kill-window", "-t", panes.fresh!.window]);
    delete panes.fresh;
    await svc.tick();
    expect((await svc.view(id))!.chat.members.find((m) => m.handle === "claude1")).toMatchObject({ spawn: "failed", spawnError: "its tab was closed before it started" });
    expect((await svc.view(id))!.chat.members.find((m) => m.handle === "claude1")!.windowId).toBeUndefined();
  });
});

describe("what an agent said in its tab", () => {
  const epoch = () => Math.floor(Date.parse(now()) / 1000);
  const stamp = (name: string, state: string, at: number, pid = name === "codex" ? 777 : 4242) =>
    tmux.run(["set-option", "-p", "-t", panes[name]!.pane, "@muxnexus_agent", `${state} ${at} ${pid} /Users/me/.${name === "codex" ? "codex" : "claude"}`]);
  const TURN = "Reviewing the diff. Two problems: sub swaps its arguments, and add() has no tests. The swap matters more.\n\nPosted my review.";
  const msgOf = async (svc: ReturnType<typeof service>, id: string, n: number) => (await svc.view(id))!.chat.messages.find((m) => m.id === n)!;

  test("a post gets its whole turn once the turn has ended, and not before", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    saidReply = () => ({ text: TURN, ended: true, start: 100 });
    await stamp("claude", "running", epoch());
    expect(await say(svc, "claude", "say", "sub looks wrong")).toMatchObject({ ok: true, output: "posted as #3 · context only: nobody was mentioned" });
    expect(svc.busy()).toBe(true);
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBeUndefined();
    clock += 20;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBe(TURN);
    expect(saidCalls.at(-1)).toMatchObject({ kind: "claude", path: "/tmp/c.jsonl" });
    expect("at" in saidCalls.at(-1)!.where).toBe(true);
    expect(svc.busy()).toBe(false);
  });

  test("a stamp older than the post is not the end of its turn", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    saidReply = () => ({ text: TURN, ended: true, start: 100 });
    clock += 10;
    await stamp("claude", "done", epoch() - 5);
    await say(svc, "claude", "say", "sub looks wrong");
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBeUndefined();
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBe(TURN);
  });

  test("it adds nothing when the agent said nothing else, or only what it posted", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await stamp("claude", "running", epoch());
    saidReply = () => ({ text: "  sub looks wrong \n", ended: true, start: 100 });
    await say(svc, "claude", "say", "sub looks wrong");
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBeUndefined();
    await stamp("claude", "running", epoch());
    saidReply = () => ({ text: "", ended: true, start: 100 });
    await say(svc, "claude", "say", "and another thing");
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBeUndefined();
  });

  test("it reaches no agent: not a delivery, a catch-up or mux read", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    saidReply = () => ({ text: "TAB-ONLY: the swap matters more", ended: true, start: 100 });
    await stamp("claude", "running", epoch());
    await say(svc, "claude", "say", "sub looks wrong");
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBe("TAB-ONLY: the swap matters more");
    await svc.handle({ t: "chat-post", id, text: "@codex1 what do you think?" });
    await svc.tick();
    expect(sends.at(-1)!.kind).toBe("codex");
    expect(sends.at(-1)!.text).toContain("sub looks wrong");
    expect(sends.at(-1)!.text).not.toContain("TAB-ONLY");
    expect((await say(svc, "codex", "read")).output).not.toContain("TAB-ONLY");
  });

  test("a turn the chat started that ended without a post shows what the agent said", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    saidReply = (_k, where) => ("tag" in where ? { text: "Nothing wrong in math.js, so I didn't post.", ended: true, start: 100 } : null);
    await svc.handle({ t: "chat-post", id, text: "@claude1 anything wrong in math.js?" });
    await svc.tick();
    seen.add("#2 ·");
    await svc.tick();
    setState("claude", "running");
    await svc.tick();
    setState("claude", "done");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)).toMatchObject({ system: true, text: "claude1 finished without replying", tabText: "Nothing wrong in math.js, so I didn't post." });
    expect(saidCalls.at(-1)).toMatchObject({ kind: "claude", path: "/tmp/c.jsonl", where: { tag: "[muxnexus · shop review · #2 ·" } });
  });

  test("a message still queued behind the turn that ended is waited for, not called unanswered", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    let read = false;
    saidReply = (_k, where) => ("tag" in where && read ? { text: "Read it in my next turn.", ended: true, start: 100 } : null);
    await svc.handle({ t: "chat-post", id, text: "@claude1 anything else?" });
    await svc.tick();
    seen.add("#2 ·");
    await svc.tick();
    setState("claude", "running");
    await svc.tick();
    setState("claude", "done");
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)!.id).toBe(2);
    expect(svc.busy()).toBe(true);
    read = true;
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)).toMatchObject({ system: true, text: "claude1 finished without replying", tabText: "Read it in my next turn." });
  });

  test("a turn too short to be seen running still ends once its stamp says so after the message went", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    saidReply = (_k, where) => ("tag" in where ? { text: "I changed math.js today.", ended: true, start: 100 } : null);
    await svc.handle({ t: "chat-post", id, text: "@claude1 which file did you change? Answer in your tab." });
    await svc.tick();
    seen.add("#2 ·");
    clock += 1;
    await svc.tick();
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)!.id).toBe(2);
    clock += 1;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.at(-1)).toMatchObject({ system: true, text: "claude1 finished without replying", tabText: "I changed math.js today." });
  });

  test("two posts in one turn: the turn goes under the last, and the post itself reads no transcript", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await stamp("claude", "running", epoch());
    await say(svc, "claude", "say", "first");
    await say(svc, "claude", "say", "second");
    expect(saidCalls).toHaveLength(0);
    saidReply = () => ({ text: TURN, ended: true, start: 100 });
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBeUndefined();
    expect((await msgOf(svc, id, 3)).tabText).toBe(TURN);
  });

  test("posts in two turns, settled together, each get their own", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    await stamp("claude", "running", epoch());
    await say(svc, "claude", "say", "first");
    await say(svc, "claude", "say", "second");
    let n = 0;
    saidReply = () => (++n === 1 ? { text: "turn one", ended: true, start: 100 } : { text: "turn two", ended: true, start: 900 });
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBe("turn one");
    expect((await msgOf(svc, id, 3)).tabText).toBe("turn two");
  });

  test("a post, then mux leave in the same turn, still gets the turn", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    saidReply = () => ({ text: TURN, ended: true, start: 100 });
    await stamp("claude", "running", epoch());
    await say(svc, "claude", "say", "sub looks wrong");
    await say(svc, "claude", "leave");
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    expect((await msgOf(svc, id, 2)).tabText).toBe(TURN);
  });

  test("a turn that never ends is read as it stands after half an hour; a replaced agent's once its process is gone", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    saidReply = () => ({ text: "still going", ended: false, start: 100 });
    await stamp("claude", "running", epoch());
    await stamp("codex", "running", epoch());
    await say(svc, "claude", "say", "one");
    await say(svc, "codex", "say", "two");
    await stamp("codex", "running", epoch(), 9999);
    clock += 31;
    await svc.tick();
    expect((await msgOf(svc, id, 4)).tabText).toBeUndefined();
    dead.add(777);
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBeUndefined();
    expect((await msgOf(svc, id, 4)).tabText).toBe("still going");
    clock += 30 * 60;
    await svc.tick();
    expect((await msgOf(svc, id, 3)).tabText).toBe("still going");
  });

  test("a very long turn keeps its end", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    saidReply = () => ({ text: `${"a".repeat(40_000)} THE END`, ended: true, start: 100 });
    await stamp("claude", "running", epoch());
    await say(svc, "claude", "say", "x");
    clock += 5;
    await stamp("claude", "done", epoch());
    await svc.tick();
    const t = (await msgOf(svc, id, 2)).tabText!;
    expect(t.startsWith("…\n")).toBe(true);
    expect(t.endsWith(" THE END")).toBe(true);
    expect(t.length).toBe(32_002);
  });
});

describe("the cap", () => {
  test("is a whole number from 1 to 50, or 0 for none", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    expect(await svc.handle({ t: "chat-settings", id, cap: 0 })).toEqual({ ok: true, chatId: id });
    expect((await svc.view(id))!.chat.cap).toBe(0);
    for (const cap of [-1, 51, 2.5]) expect(await svc.handle({ t: "chat-settings", id, cap })).toEqual({ ok: false, error: "The cap is a whole number from 1 to 50, or 0 for no cap." });
  });
});

describe("deleting a chat", () => {
  test("it goes for good, file and all, and its agents keep running unless asked", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    expect(await svc.handle({ t: "chat-delete", id, closeTabs: false })).toEqual({ ok: true });
    expect(await svc.summaries()).toEqual([]);
    expect(await svc.view(id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect(await createChatStore(dir).list()).toEqual([]);
    expect(closed).toEqual([]);
    expect((await say(svc, "claude", "say", "hello")).output).toBe("NOT POSTED: this tab isn't in a muxnexus chat. The user adds it from the Chats tab.");
  });

  test("asked to, it shuts down the agents that joined it, and leaves the rest running", async () => {
    await window("third", "done 1790000000 888 /Users/me/.claude");
    await window("fourth", "done 1790000000 999 /Users/me/.claude");
    const svc = service();
    const id = await newChat(svc, "claude", "codex", "third", "fourth");
    await newChat(svc, "codex");
    await svc.handle({ t: "chat-remove", id, handle: "claude2" });
    await tmux.run(["set-option", "-p", "-t", panes.fourth!.pane, "@muxnexus_agent", "done 1790000000 5555 /Users/me/.claude"]);
    expect(await svc.handle({ t: "chat-delete", id, closeTabs: true })).toEqual({
      ok: true,
      notice: `Shut down claude1. Left running: codex1, in "shop review 2"; claude3, its tab now runs another agent.`,
    });
    expect(closed).toEqual([panes.claude!.window]);
    expect((await svc.summaries()).map((c) => c.name)).toEqual(["shop review 2"]);
  });

  test("a save already on its way doesn't bring it back", async () => {
    let id = "";
    const svc: ReturnType<typeof service> = service({
      adapters: { claude: { kind: "claude", send: async () => { await svc.handle({ t: "chat-delete", id, closeTabs: false }); return { ok: true }; } } },
    });
    id = await newChat(svc, "claude");
    await svc.handle({ t: "chat-post", id, text: "@claude1 go" });
    await svc.tick();
    expect(readdirSync(dir)).toEqual([]);
    expect(await svc.summaries()).toEqual([]);
  });

  test("a tab that won't close doesn't stop the others, and is reported", async () => {
    const svc = service();
    const id = await newChat(svc, "claude", "codex");
    closeFails.add(panes.claude!.window);
    expect(await svc.handle({ t: "chat-delete", id, closeTabs: true })).toEqual({
      ok: true,
      notice: `Shut down codex1. Couldn't close claude1's tab: can't find window: ${panes.claude!.window}.`,
    });
    expect(closed).toEqual([panes.codex!.window]);
  });

  test("a file that can't be removed leaves the chat as it was, and says so", async () => {
    const svc = service();
    const id = await newChat(svc, "claude");
    chmodSync(dir, 0o555);
    try {
      const r = await svc.handle({ t: "chat-delete", id, closeTabs: true });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toStartWith("Couldn't delete it: ");
    } finally {
      chmodSync(dir, 0o755);
    }
    expect((await svc.summaries()).map((c) => c.id)).toEqual([id]);
    expect(closed).toEqual([]);
  });

  test("an agent still starting in a tab the chat opened is shut down too, within the half hour it's watched", async () => {
    await window("fresh", "");
    await window("later", "");
    let next = "fresh";
    const svc = service({ spawn: async () => panes[next]!.window });
    const r = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "/tmp", session: "shop" }] });
    expect(await svc.handle({ t: "chat-delete", id: r.ok ? r.chatId! : "", closeTabs: true })).toEqual({ ok: true, notice: "Shut down claude1." });
    expect(closed).toEqual([panes.fresh!.window]);
    next = "later";
    const r2 = await svc.handle({ t: "chat-create", members: [], spawn: [{ kind: "claude", folder: "/tmp", session: "shop" }] });
    clock += 31 * 60;
    expect(await svc.handle({ t: "chat-delete", id: r2.ok ? r2.chatId! : "", closeTabs: true })).toEqual({ ok: true, notice: "Left running: claude1, no agent has started in its tab." });
    expect(closed).toEqual([panes.fresh!.window]);
  });

  test("a delivery still to go in the same pass is not sent once the chat is deleted", async () => {
    let id = "";
    const svc: ReturnType<typeof service> = service({
      adapters: { claude: { kind: "claude", send: async () => { await svc.handle({ t: "chat-delete", id, closeTabs: false }); return { ok: true }; } } },
    });
    id = await newChat(svc, "claude", "codex");
    await svc.handle({ t: "chat-post", id, text: "@claude1 @codex1 go" });
    await svc.tick();
    expect(sends).toEqual([]);
  });

  test("the browser's message is checked", () => {
    expect(parseChatMessage({ t: "chat-delete", id: "x", closeTabs: true })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-delete", id: "x" })).toBeNull();
    expect(parseChatMessage({ t: "chat-delete", id: "x", closeTabs: "yes" })).toBeNull();
  });
});

describe("the hook endpoint's guard", () => {
  test("only loopback addresses are let in", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["100.101.102.103", "192.168.1.4", "", undefined]) expect(isLoopback(a)).toBe(false);
  });
});
