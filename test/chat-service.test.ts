import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, AgentTarget } from "../src/server/chat/adapters";
import { createChatService, isLoopback, type WindowLive } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";
import { Tmux } from "../src/server/tmux";
import type { AgentState } from "../src/shared/protocol";

const tmux = new Tmux("mxn-chat-svc-test");
let dir = "";
let panes: Record<string, { pane: string; window: string }> = {};
let live: Map<string, WindowLive>;
let sends: { kind: string; target: AgentTarget; text: string }[];
let seen: Set<string>;
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

function service(over: { agentOfWindow?: typeof tmux.agentOfWindow; adapters?: Partial<Record<"claude" | "codex", Adapter>> } = {}) {
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
    alive: () => true,
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
    await svc.tick();
    expect((await svc.view(id))!.chat.messages.find((m) => m.id === 2)!.deliveries.codex1).toMatchObject({ state: "failed", reason: "not confirmed: its agent went away before reading it" });
    gone = false;
    await svc.handle({ t: "chat-post", id, text: "@codex1 two" });
    await svc.tick();
    expect(sends.map((s) => s.text.includes("two"))).toEqual([false, true]);
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
    expect(sends[0]!.text.split("\n")[1]).toBe(`Reply with mux say --chat "shop review"; your tab's answer is invisible to the chat.`);
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

describe("the hook endpoint's guard", () => {
  test("only loopback addresses are let in", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["100.101.102.103", "192.168.1.4", "", undefined]) expect(isLoopback(a)).toBe(false);
  });
});
