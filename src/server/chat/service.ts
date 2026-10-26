import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, Chat, ChatMember, ChatSummary } from "../../shared/chat";
import type { AgentState, ChatMemberLive, ChatSpawn, ClientMessage } from "../../shared/protocol";
import { profileLabel } from "../usage";
import type { WindowAgentInfo } from "../tmux";
import { claudeSocket, hasTag, type Adapter, type AgentTarget } from "./adapters";
import { addMember, discardHeld, leave, missedFor, newChat, post, resolveMentions, stop, summary } from "./model";
import { nextSends, type AgentView } from "./plan";
import type { ChatStore } from "./store";
import { deliveryText, readText, whoText } from "./text";

/**
 * The room on the server: chats in memory, saved on every change, and the
 * delivery loop. Two doors lead in. The browser's socket (`handle`) is the
 * user; the tab hook (`hook`) is an agent, named by the pane its hook proved,
 * never by anything it wrote.
 */

/** What the server's state read says about one window. */
export interface WindowLive {
  /** The agent's state; absent when no agent runs there. */
  state?: AgentState;
  session: string;
}

export interface HookRequest {
  agent: AgentKind;
  pane: string;
  sessionId?: string;
  cwd?: string;
  argv: string[];
}

/** The browser's chat messages that change a chat. */
export type ChatClientMessage = Exclude<Extract<ClientMessage, { t: `chat-${string}` }>, { t: "chat-open" }>;
export type SpawnRequest = ChatSpawn;
export type MemberLive = ChatMemberLive;

export interface ChatView {
  chat: Chat;
  agents: Record<string, MemberLive>;
}

const str = (v: unknown): v is string => typeof v === "string";
const joins = (v: unknown) => Array.isArray(v) && v.every((j) => j && str(j.windowId) && (j.role === undefined || str(j.role)));
const spawns = (v: unknown) =>
  v === undefined ||
  (Array.isArray(v) && v.every((s) => s && (s.kind === "claude" || s.kind === "codex") && str(s.folder) && str(s.session) && (s.role === undefined || str(s.role)) && (s.profile === undefined || str(s.profile))));

/** A browser message with the shape its type says, or null. There is no auth: nothing unchecked goes further. */
export function parseChatMessage(m: { t: string } & Record<string, unknown>): ChatClientMessage | null {
  const ok = (() => {
    switch (m.t) {
      case "chat-create": return (m.name === undefined || str(m.name)) && joins(m.members) && spawns(m.spawn);
      case "chat-add": return str(m.id) && joins(m.members) && spawns(m.spawn);
      case "chat-post": return str(m.id) && str(m.text);
      case "chat-remove": return str(m.id) && str(m.handle);
      case "chat-role": return str(m.id) && str(m.handle) && str(m.role);
      case "chat-settings": return str(m.id) && (m.name === undefined || str(m.name)) && (m.cap === undefined || typeof m.cap === "number");
      case "chat-archive": return str(m.id) && typeof m.archived === "boolean";
      case "chat-discard-held": return str(m.id);
      case "chat-reconnect": return str(m.id) && str(m.handle) && str(m.windowId);
      default: return false;
    }
  })();
  return ok ? (m as unknown as ChatClientMessage) : null;
}

/** A hook's post with the shape it should have, or null. */
export function parseHookRequest(v: unknown): HookRequest | null {
  const r = v as Record<string, unknown> | null;
  if (!r || (r.agent !== "claude" && r.agent !== "codex") || !str(r.pane)) return null;
  if (!Array.isArray(r.argv) || !r.argv.every(str)) return null;
  if ((r.sessionId !== undefined && !str(r.sessionId)) || (r.cwd !== undefined && !str(r.cwd))) return null;
  return r as unknown as HookRequest;
}

export interface ChatServiceDeps {
  store: ChatStore;
  tmux: {
    windowOfPane(paneId: string): Promise<{ windowId: string; session: string } | null>;
    agentOfWindow(windowId: string): Promise<WindowAgentInfo | null>;
  };
  states: () => Promise<Map<string, WindowLive>>;
  adapters: Partial<Record<AgentKind, Adapter>>;
  /** Opens a tab running a new agent; resolves to its window id. */
  spawn?: (req: SpawnRequest) => Promise<string>;
  socketOf?: (configDir: string, pid: number) => Promise<string | null>;
  receipt?: (path: string, tag: string) => Promise<boolean>;
  now?: () => string;
  home?: string;
}

type Result = { ok: true; chatId?: string } | { ok: false; error: string };

/** A spawned agent whose tab never stamped within this long has failed to start. */
const SPAWN_TIMEOUT_MS = 90_000;

export function isLoopback(address: string | undefined | null): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const STATE_WORDS: Record<string, string> = { running: "working", input: "waiting on the user", done: "idle" };

export function createChatService(deps: ChatServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const home = deps.home ?? homedir();
  const socketOf = deps.socketOf ?? ((dir: string, pid: number) => claudeSocket(dir, pid));
  const receipt = deps.receipt ?? hasTag;
  const chats = new Map<string, Chat>();
  let loaded: Promise<void> | null = null;
  const ready = () => (loaded ??= deps.store.list().then((list) => { for (const c of list) chats.set(c.id, c); }));
  const save = (chat: Chat) => deps.store.save(chat);

  const live = (m: ChatMember, states: Map<string, WindowLive>) => (m.windowId ? states.get(m.windowId) : undefined);

  /** The chats a window is an active member of. */
  function chatsOf(windowId: string): { chat: Chat; member: ChatMember }[] {
    const out: { chat: Chat; member: ChatMember }[] = [];
    for (const chat of chats.values()) {
      if (chat.archived) continue;
      const member = chat.members.find((m) => m.windowId === windowId && !m.left && m.kind !== "user");
      if (member) out.push({ chat, member });
    }
    return out;
  }

  /** The newest time a chat delivered to this member: where an unaddressed `mux say` goes. */
  function lastWoke(chat: Chat, handle: string): string {
    let at = "";
    for (const m of chat.messages) {
      const d = m.deliveries[handle];
      if (d && (d.state === "delivered" || d.reason === "sent") && d.at > at) at = d.at;
    }
    return at || chat.createdAt;
  }

  async function addAgents(chat: Chat, members: { windowId: string; role?: string }[]): Promise<string | null> {
    const found: { info: WindowAgentInfo; windowId: string; role?: string; session: string }[] = [];
    for (const want of members) {
      if (chat.members.some((m) => m.windowId === want.windowId && !m.left)) continue;
      const info = await deps.tmux.agentOfWindow(want.windowId);
      if (!info) return "No agent is running in that tab.";
      if (info.daemon) return "That Codex tab runs in the shared daemon: restart it with --no-daemon to join.";
      const session = (await deps.tmux.windowOfPane(info.paneId))?.session ?? "";
      found.push({ info, windowId: want.windowId, ...(want.role ? { role: want.role } : {}), session });
    }
    const t = now();
    for (const f of found) {
      const m = addMember(chat, {
        kind: f.info.kind,
        windowId: f.windowId,
        paneId: f.info.paneId,
        session: f.session,
        ...(f.info.cwd ? { folder: f.info.cwd } : {}),
        ...(f.info.configDir ? { profile: profileLabel(f.info.configDir) } : {}),
        ...(f.info.conversation ? { agentId: f.info.conversation.sessionId } : f.info.thread ? { agentId: f.info.thread.id } : {}),
        ...(f.role ? { role: f.role } : {}),
      }, t);
      post(chat, m.handle, `${m.handle} joined${m.role ? ` as ${m.role}` : ""}`, t, { system: true });
    }
    return null;
  }

  async function spawnAgents(chat: Chat, spawn: SpawnRequest[] | undefined): Promise<string | null> {
    if (!spawn?.length) return null;
    if (!deps.spawn) return "This server can't start agents.";
    for (const req of spawn) {
      const t = now();
      let windowId: string;
      try {
        windowId = await deps.spawn(req);
      } catch (e) {
        const m = addMember(chat, { kind: req.kind, folder: req.folder, session: req.session, spawn: "failed", spawnError: e instanceof Error ? e.message : String(e), ...(req.role ? { role: req.role } : {}) }, t);
        post(chat, m.handle, `${m.handle} didn't start: ${m.spawnError}`, t, { system: true });
        continue;
      }
      addMember(chat, { kind: req.kind, windowId, folder: req.folder, session: req.session, spawn: "pending", ...(req.role ? { role: req.role } : {}) }, t);
    }
    return null;
  }

  function defaultName(chat: Chat): string {
    const agents = chat.members.filter((m) => m.kind !== "user");
    const where = agents.find((m) => m.session)?.session;
    return `${agents.map((m) => m.handle).join(" + ") || "new chat"}${where ? ` · ${where}` : ""}`;
  }

  function cancelPending(chat: Chat, reason: string) {
    const t = now();
    for (const m of chat.messages) {
      for (const d of Object.values(m.deliveries)) {
        if ((d.state === "queued" || d.state === "held") && d.reason !== "sent") {
          d.state = "cancelled";
          d.reason = reason;
          d.at = t;
        }
      }
    }
  }

  async function handle(m: ChatClientMessage): Promise<Result> {
    await ready();
    if (m.t === "chat-create") {
      const chat = newChat(deps.store.newId(), (m.name ?? "").trim(), now());
      const err = (await addAgents(chat, m.members ?? [])) ?? (await spawnAgents(chat, m.spawn));
      if (err) return { ok: false, error: err };
      if (!chat.name) chat.name = defaultName(chat);
      chats.set(chat.id, chat);
      await save(chat);
      return { ok: true, chatId: chat.id };
    }
    const chat = chats.get(m.id);
    if (!chat) return { ok: false, error: "No such chat." };
    switch (m.t) {
      case "chat-post": {
        const text = m.text.trim();
        if (!text) return { ok: false, error: "Nothing to send." };
        post(chat, "user", text, now());
        break;
      }
      case "chat-add": {
        const err = (await addAgents(chat, m.members ?? [])) ?? (await spawnAgents(chat, m.spawn));
        if (err) return { ok: false, error: err };
        break;
      }
      case "chat-remove":
        leave(chat, m.handle, now());
        break;
      case "chat-role": {
        const member = chat.members.find((x) => x.handle === m.handle && x.kind !== "user");
        if (!member) return { ok: false, error: "No such member." };
        const role = m.role.trim();
        if (role) member.role = role;
        else delete member.role;
        post(chat, member.handle, role ? `${member.handle} is now the ${role}` : `${member.handle} has no role now`, now(), { system: true });
        break;
      }
      case "chat-settings":
        if (m.name !== undefined && m.name.trim()) chat.name = m.name.trim();
        if (m.cap !== undefined) {
          if (!Number.isInteger(m.cap) || m.cap < 1 || m.cap > 50) return { ok: false, error: "The cap is a whole number from 1 to 50." };
          chat.cap = m.cap;
        }
        break;
      case "chat-archive":
        chat.archived = m.archived;
        if (m.archived) cancelPending(chat, "archived");
        break;
      case "chat-discard-held":
        discardHeld(chat, now());
        break;
      case "chat-reconnect": {
        const member = chat.members.find((x) => x.handle === m.handle);
        const info = await deps.tmux.agentOfWindow(m.windowId);
        if (!member || !info) return { ok: false, error: "No agent is running in that tab." };
        const id = info.conversation?.sessionId ?? info.thread?.id;
        if (member.agentId && id !== member.agentId) return { ok: false, error: `That tab holds a different conversation from ${member.handle}'s. Use Replace to bring in another agent.` };
        member.windowId = m.windowId;
        member.paneId = info.paneId;
        // What failed while it was away goes again.
        for (const msg of chat.messages) {
          const d = msg.deliveries[member.handle];
          if (d?.state === "failed" && d.reason === "offline") {
            d.state = chat.paused ? "held" : "queued";
            delete d.reason;
            d.at = now();
          }
        }
        post(chat, member.handle, `${member.handle} reconnected`, now(), { system: true });
        break;
      }
    }
    await save(chat);
    return { ok: true, chatId: chat.id };
  }

  async function hook(req: HookRequest): Promise<{ ok: boolean; output: string }> {
    await ready();
    const where = await deps.tmux.windowOfPane(req.pane);
    let argv = [...req.argv];
    let named: string | undefined;
    const at = argv.indexOf("--chat");
    if (at !== -1) {
      named = argv[at + 1];
      argv.splice(at, 2);
    }
    const mine = where ? chatsOf(where.windowId) : [];
    if (mine.length === 0) return { ok: false, output: "NOT POSTED: this tab isn't in a muxnexus chat. The user adds it from the Chats tab." };
    let pick = named ? mine.find((x) => x.chat.name.toLowerCase() === named!.toLowerCase() || x.chat.id === named) : undefined;
    if (named && !pick) return { ok: false, output: `NOT POSTED: this tab isn't in a chat named "${named}". It is in: ${mine.map((x) => `"${x.chat.name}"`).join(", ")}.` };
    pick ??= mine.sort((a, b) => lastWoke(b.chat, b.member.handle).localeCompare(lastWoke(a.chat, a.member.handle)))[0]!;
    const { chat, member } = pick;
    const [cmd, ...rest] = argv;
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    const t = now();
    switch (cmd) {
      case "say": {
        const text = args.join(" ").trim();
        if (!text) return { ok: false, output: `NOT POSTED: nothing to say. Usage: mux say "<text>"` };
        const msg = post(chat, member.handle, text, t);
        delete member.awaiting;
        delete member.sawRunning;
        await save(chat);
        const notes: string[] = [];
        const agents = Object.keys(msg.deliveries);
        if (chat.paused) notes.push("held: the chat is paused until @user writes");
        else if (agents.length === 0) notes.push(msg.to.includes("user") ? "for @user" : "context only: nobody was mentioned");
        const unknown = resolveMentions(chat, text).unknown;
        if (unknown.length) notes.push(`not in this chat: ${unknown.map((u) => `@${u}`).join(" ")}`);
        return { ok: true, output: [`posted as #${msg.id}`, ...notes].join(" · ") };
      }
      case "read": {
        const n = Number(args[0] ?? 20);
        return { ok: true, output: readText(chat, Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 20) };
      }
      case "who": {
        const states = await deps.states();
        return { ok: true, output: whoText(chat, (m) => STATE_WORDS[live(m, states)?.state ?? ""] ?? "offline", { home }) };
      }
      case "stop":
        stop(chat, member.handle, args.join(" ").trim() || "done", t);
        await save(chat);
        return { ok: true, output: "stopped: nobody is woken until @user writes" };
      case "leave":
        leave(chat, member.handle, t);
        await save(chat);
        return { ok: true, output: `left "${chat.name}"` };
      default:
        return { ok: false, output: `NOT POSTED: unknown command "${cmd ?? ""}". Use mux say, read, who, stop or leave.` };
    }
  }

  async function target(m: ChatMember, info: WindowAgentInfo): Promise<AgentTarget> {
    if (info.kind === "claude") {
      const dir = info.configDir ?? join(home, ".claude");
      return {
        kind: "claude",
        pid: info.pid ?? 0,
        configDir: dir,
        ...(info.pid ? { socketPath: (await socketOf(dir, info.pid)) ?? undefined } : {}),
        ...(info.conversation ? { transcript: info.conversation.transcriptPath } : {}),
      };
    }
    return { kind: "codex", pid: info.pid ?? 0, ...(info.thread ? { thread: info.thread.id, ...(info.thread.path ? { transcript: info.thread.path } : {}) } : {}) };
  }

  const tagOf = (chat: Chat, id: number) => `[muxnexus · ${chat.name} · #${id} ·`;

  /** One pass: spawned tabs, receipts, finished turns, then sends. The ids of chats it changed. */
  async function tick(): Promise<string[]> {
    await ready();
    const active = [...chats.values()].filter((c) => !c.archived);
    if (active.length === 0) return [];
    const changed = new Set<string>();
    const states = await deps.states();
    const infos = new Map<string, WindowAgentInfo | null>();
    const infoOf = async (w: string) => {
      if (!infos.has(w)) infos.set(w, await deps.tmux.agentOfWindow(w));
      return infos.get(w) ?? null;
    };

    for (const chat of active) {
      for (const m of chat.members) {
        if (m.kind === "user" || m.left || !m.windowId) continue;
        // A tab started from the chat joins once its agent stamps it.
        if (m.spawn === "pending") {
          const info = await infoOf(m.windowId);
          if (info && !info.daemon && info.pid) {
            delete m.spawn;
            m.paneId = info.paneId;
            if (info.cwd) m.folder = info.cwd;
            const id = info.conversation?.sessionId ?? info.thread?.id;
            if (id) m.agentId = id;
            post(chat, m.handle, `${m.handle} joined${m.role ? ` as ${m.role}` : ""}`, now(), { system: true });
            changed.add(chat.id);
          } else if (Date.parse(now()) - Date.parse(m.joinedAt) > SPAWN_TIMEOUT_MS) {
            m.spawn = "failed";
            m.spawnError = "its agent never started";
            post(chat, m.handle, `${m.handle} didn't start: ${m.spawnError}`, now(), { system: true });
            changed.add(chat.id);
          }
          continue;
        }
        // A turn the chat started that ended with nothing said back.
        if (m.awaiting !== undefined) {
          const state = live(m, states)?.state;
          if (state === "running" || state === "input") m.sawRunning = true;
          else if (state === "done" && m.sawRunning) {
            delete m.awaiting;
            delete m.sawRunning;
            post(chat, m.handle, `${m.handle} finished without replying`, now(), { system: true });
            changed.add(chat.id);
          }
        }
      }
      // Receipts for what is in flight.
      for (const msg of chat.messages) {
        for (const [handle, d] of Object.entries(msg.deliveries)) {
          if (d.state !== "queued" || d.reason !== "sent") continue;
          const m = chat.members.find((x) => x.handle === handle);
          if (!m?.windowId) continue;
          const info = await infoOf(m.windowId);
          const path = info?.kind === "claude" ? info.conversation?.transcriptPath : info?.thread?.path;
          if (path && (await receipt(path, tagOf(chat, msg.id)))) {
            msg.deliveries[handle] = { state: "delivered", at: now() };
            m.awaiting = msg.id;
            m.sawRunning = false;
            changed.add(chat.id);
          }
        }
      }
    }

    const view = (_c: Chat, m: ChatMember): AgentView => {
      const l = live(m, states);
      const info = m.windowId ? infos.get(m.windowId) : undefined;
      return {
        kind: m.kind as AgentKind,
        online: l?.state !== undefined,
        idle: l?.state === undefined || l.state === "done",
        ...(info?.daemon ? { daemon: true } : {}),
      };
    };
    for (const chat of active) for (const m of chat.members) if (m.windowId && !m.left && m.kind !== "user") await infoOf(m.windowId);
    const plan = nextSends(active, view);
    for (const f of plan.fail) {
      const chat = chats.get(f.chatId)!;
      chat.messages.find((x) => x.id === f.msgId)!.deliveries[f.handle] = { state: "failed", reason: f.reason, at: now() };
      changed.add(chat.id);
    }
    for (const s of plan.send) {
      const chat = chats.get(s.chatId)!;
      const msg = chat.messages.find((x) => x.id === s.msgId)!;
      const member = chat.members.find((x) => x.handle === s.handle)!;
      const info = await infoOf(member.windowId!);
      const adapter = deps.adapters[member.kind as AgentKind];
      if (!info || !adapter) {
        msg.deliveries[s.handle] = { state: "failed", reason: adapter ? "offline" : "unavailable", at: now() };
        changed.add(chat.id);
        continue;
      }
      const text = deliveryText(chat, member, msg, missedFor(chat, member.handle, msg.id), { home });
      const res = await adapter.send(await target(member, info), text);
      if (res.ok) {
        msg.deliveries[s.handle] = { state: "queued", reason: "sent", at: now() };
        member.welcomed = true;
        member.lastSeq = Math.max(member.lastSeq ?? 0, msg.id);
      } else {
        msg.deliveries[s.handle] = { state: "failed", reason: res.reason, at: now() };
      }
      changed.add(chat.id);
    }
    await Promise.all([...changed].map((id) => save(chats.get(id)!)));
    return [...changed];
  }

  /** Whether a tick has anything to do: something queued, in flight, starting, or awaiting a reply. */
  function busy(): boolean {
    for (const chat of chats.values()) {
      if (chat.archived) continue;
      if (chat.members.some((m) => m.spawn === "pending" || m.awaiting !== undefined)) return true;
      for (const msg of chat.messages) for (const d of Object.values(msg.deliveries)) if (d.state === "queued") return true;
    }
    return false;
  }

  async function summaries(): Promise<ChatSummary[]> {
    await ready();
    const states = await deps.states();
    return [...chats.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => summary(c, (m) => (live(m, states)?.state === "running" ? "running" : undefined)));
  }

  async function view(id: string): Promise<ChatView | null> {
    await ready();
    const chat = chats.get(id);
    if (!chat) return null;
    const states = await deps.states();
    const agents: Record<string, MemberLive> = {};
    for (const m of chat.members) {
      if (m.kind === "user") continue;
      const l = live(m, states);
      const info = m.windowId && !m.left ? await deps.tmux.agentOfWindow(m.windowId) : null;
      agents[m.handle] = {
        online: l?.state !== undefined,
        ...(l?.state ? { state: l.state } : {}),
        ...(l?.session ? { session: l.session } : {}),
        ...(info?.daemon ? { daemon: true } : {}),
      };
    }
    return { chat, agents };
  }

  return { handle, hook, tick, busy, summaries, view, ready };
}

export type ChatService = ReturnType<typeof createChatService>;
