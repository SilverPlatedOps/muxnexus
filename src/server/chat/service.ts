import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, Chat, ChatMember, ChatSummary } from "../../shared/chat";
import type { AgentState, ChatMemberLive, ChatSpawn, ClientMessage } from "../../shared/protocol";
import { profileLabel } from "../usage";
import { processAlive, type WindowAgentInfo } from "../tmux";
import { claudeSocket, hasTag, type Adapter, type AgentTarget, type SendResult } from "./adapters";
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
      case "chat-reconnect": return str(m.id) && str(m.handle) && (m.windowId === undefined || str(m.windowId));
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
  /** Every window id, for Reconnect to search. */
  windows?: () => Promise<string[]>;
  adapters: Partial<Record<AgentKind, Adapter>>;
  /** Opens a tab running a new agent; resolves to its window id. */
  spawn?: (req: SpawnRequest) => Promise<string>;
  socketOf?: (configDir: string, pid: number) => Promise<string | null>;
  receipt?: (path: string, tag: string, from?: number) => Promise<boolean>;
  /** Whether an agent process still runs; tests stand in for it. */
  alive?: (pid: number) => boolean;
  now?: () => string;
  home?: string;
}

type Result = { ok: true; chatId?: string } | { ok: false; error: string };

/** A spawned agent whose tab never stamped within this long has failed to start. */
const SPAWN_TIMEOUT_MS = 90_000;
/** A message handed to an idle agent with no sign of it after this long was not read. */
const UNCONFIRMED_MS = 5 * 60_000;
/** A tab that can't be read for this long after a message went to it is gone, not between reads. */
const GONE_MS = 30_000;
/** The longest chat line: a delivery is one argument to `codex queue`, and a review fits well inside. */
export const MAX_TEXT = 32_000;
const tooLong = (n: number) => `too long: ${n.toLocaleString("en-US")} characters, and a chat line holds ${MAX_TEXT.toLocaleString("en-US")}. Put it in a file and point to it.`;

export function isLoopback(address: string | undefined | null): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const STATE_WORDS: Record<string, string> = { running: "working", input: "waiting on the user", done: "idle" };

export function createChatService(deps: ChatServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const home = deps.home ?? homedir();
  const socketOf = deps.socketOf ?? ((dir: string, pid: number) => claudeSocket(dir, pid));
  const receipt = deps.receipt ?? hasTag;
  const alive = deps.alive ?? processAlive;
  /**
   * Whether the agent in a member's tab is the one that joined: the same kind,
   * under the same tmux server, in the same process. A Codex that joined before
   * its first turn had no process on record yet; the first one seen is taken.
   */
  const sameAgent = (m: ChatMember, info: WindowAgentInfo | null | undefined): info is WindowAgentInfo =>
    !!info && info.kind === m.kind && (!m.server || !info.server || info.server === m.server) && (m.pid === undefined || info.pid === m.pid);
  /**
   * Whether a member's agent can be reached, from the fresh read of its
   * window: its own stamp, with the process running, or a Codex tab that hasn't
   * started a conversation. The server's cached state can lag a stamp by a second; this can't.
   */
  const reachable = (m: ChatMember, info: WindowAgentInfo | null | undefined) =>
    sameAgent(m, info) && !info.daemon && (info.fresh === true || (info.pid !== undefined && alive(info.pid)));
  const idOf = (info: WindowAgentInfo) => info.conversation?.sessionId ?? info.thread?.id;
  const chats = new Map<string, Chat>();
  let loaded: Promise<void> | null = null;
  const ready = () => (loaded ??= deps.store.list().then((list) => { for (const c of list) chats.set(c.id, c); }));
  const save = (chat: Chat) => deps.store.save(chat);

  const live = (m: ChatMember, states: Map<string, WindowLive>) => (m.windowId ? states.get(m.windowId) : undefined);

  /** A chat name no other chat has, so a receipt tag and `--chat` name one chat. */
  function uniqueName(name: string, self?: string): string {
    const taken = new Set([...chats.values()].filter((c) => c.id !== self).map((c) => c.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
  }

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
        ...(idOf(f.info) ? { agentId: idOf(f.info) } : {}),
        ...(f.info.pid ? { pid: f.info.pid } : {}),
        ...(f.info.server ? { server: f.info.server } : {}),
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
      chat.name = uniqueName(chat.name || defaultName(chat));
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
        if (text.length > MAX_TEXT) return { ok: false, error: `That's ${tooLong(text.length)}` };
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
        if (m.name !== undefined && m.name.trim()) chat.name = uniqueName(m.name.trim(), chat.id);
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
        // Only the member's own conversation, in an agent of its kind, in a tab
        // no other member holds: Reconnect never swaps one agent for another.
        const member = chat.members.find((x) => x.handle === m.handle && x.kind !== "user" && !x.left);
        if (!member) return { ok: false, error: "No such member." };
        if (!member.agentId) return { ok: false, error: `muxnexus never saw ${member.handle}'s conversation, so it can't look for it. Use Replace.` };
        const look = m.windowId ? [m.windowId] : [...new Set([member.windowId, ...((await deps.windows?.()) ?? [])])];
        let found: { windowId: string; info: WindowAgentInfo } | null = null;
        for (const w of look) {
          if (!w || chat.members.some((o) => o !== member && !o.left && o.windowId === w)) continue;
          const info = await deps.tmux.agentOfWindow(w);
          if (info && !info.daemon && info.kind === member.kind && idOf(info) === member.agentId) {
            found = { windowId: w, info };
            break;
          }
        }
        if (!found) return { ok: false, error: `No open tab holds ${member.handle}'s conversation. Resume it in a tab, then Reconnect.` };
        member.windowId = found.windowId;
        member.paneId = found.info.paneId;
        if (found.info.pid) member.pid = found.info.pid;
        else delete member.pid;
        if (found.info.server) member.server = found.info.server;
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
    const listed = where ? chatsOf(where.windowId) : [];
    if (listed.length === 0) return { ok: false, output: "NOT POSTED: this tab isn't in a muxnexus chat. The user adds it from the Chats tab." };
    // The member is the agent that joined, not whatever runs in its tab now.
    const info = await deps.tmux.agentOfWindow(where!.windowId);
    const mine = listed.filter((x) => x.member.kind === req.agent && sameAgent(x.member, info));
    if (mine.length === 0) {
      return { ok: false, output: `NOT POSTED: the agent in this tab isn't the one that joined "${listed[0]!.chat.name}": it was restarted or replaced. Ask @user to Reconnect it from the chat's member list.` };
    }
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
        if (text.length > MAX_TEXT) return { ok: false, output: `NOT POSTED: ${tooLong(text.length)}` };
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
        const where = mine.length > 1 ? `posted to "${chat.name}" as #${msg.id}` : `posted as #${msg.id}`;
        return { ok: true, output: [where, ...notes].join(" · ") };
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
    return {
      kind: "codex",
      pid: info.pid ?? 0,
      ...(info.configDir ? { configDir: info.configDir } : {}),
      ...(info.thread ? { thread: info.thread.id, ...(info.thread.path ? { transcript: info.thread.path } : {}) } : {}),
    };
  }

  const tagOf = (chat: Chat, id: number) => `[muxnexus · ${chat.name} · #${id} ·`;
  const transcriptOf = (info: WindowAgentInfo) => (info.kind === "claude" ? info.conversation?.transcriptPath : info.thread?.path);
  const sizeOf = (path: string | undefined) => (path ? stat(path).then((s) => s.size, () => 0) : Promise.resolve(0));

  /** One pass: spawned tabs, who is in each tab, receipts, finished turns, then sends. The ids of chats it changed. */
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
    const idle = (m: ChatMember, info: WindowAgentInfo | null) => {
      const state = live(m, states)?.state ?? info?.state;
      return state === undefined || state === "done";
    };

    for (const chat of active) {
      for (const m of chat.members) {
        if (m.kind === "user" || m.left || !m.windowId) continue;
        const info = await infoOf(m.windowId);
        // A tab started from the chat joins once its agent stamps it.
        if (m.spawn === "pending") {
          if (info && !info.daemon && info.pid) {
            delete m.spawn;
            m.paneId = info.paneId;
            m.pid = info.pid;
            if (info.server) m.server = info.server;
            if (info.cwd) m.folder = info.cwd;
            const id = idOf(info);
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
        if (sameAgent(m, info)) {
          // A Codex that joined before its first turn: its process and thread, once it has them.
          if (m.pid === undefined && info.pid !== undefined) {
            m.pid = info.pid;
            if (info.server) m.server = info.server;
            changed.add(chat.id);
          }
          // The same agent in a new conversation keeps its place, and the new
          // conversation gets the join message: it knows nothing of the chat.
          const id = idOf(info);
          if (id && id !== m.agentId) {
            if (m.agentId) m.welcomed = false;
            m.agentId = id;
            changed.add(chat.id);
          }
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
      // Receipts for what is in flight; what can no longer arrive is said to be unconfirmed.
      for (const msg of chat.messages) {
        for (const [handle, d] of Object.entries(msg.deliveries)) {
          if (d.state !== "queued" || d.reason !== "sent") continue;
          const m = chat.members.find((x) => x.handle === handle);
          if (!m?.windowId) continue;
          const info = await infoOf(m.windowId);
          const p = d.probe;
          // The transcript it went to holds the proof even while the tab can't be read.
          const path = (sameAgent(m, info) ? transcriptOf(info) : undefined) ?? p?.path;
          const since = Date.parse(now()) - Date.parse(d.at);
          if (path && (await receipt(path, p?.tag ?? tagOf(chat, msg.id), p && p.path === path ? p.offset : undefined))) {
            msg.deliveries[handle] = { state: "delivered", at: now() };
            // An answer that beat the receipt is already in: nothing to wait for.
            if (!chat.messages.some((x) => x.from === handle && x.id > msg.id && !x.system)) {
              m.awaiting = msg.id;
              m.sawRunning = false;
            }
            changed.add(chat.id);
          } else if (!reachable(m, info)) {
            if (since <= GONE_MS) continue;
            msg.deliveries[handle] = { state: "failed", reason: "not confirmed: its agent went away before reading it", at: now() };
            changed.add(chat.id);
          } else if (since > UNCONFIRMED_MS && idle(m, info)) {
            msg.deliveries[handle] = { state: "failed", reason: "not confirmed: no sign it was read in 5 minutes", at: now() };
            changed.add(chat.id);
          }
        }
      }
    }

    const view = (_c: Chat, m: ChatMember): AgentView => {
      const info = m.windowId ? (infos.get(m.windowId) ?? null) : null;
      // A Codex tab with no conversation yet has no thread to queue to: its messages wait.
      const threadless = info?.kind === "codex" && !info.daemon && !info.thread;
      return {
        kind: m.kind as AgentKind,
        online: reachable(m, info),
        idle: !threadless && idle(m, info),
        ...(info?.daemon ? { daemon: true } : {}),
      };
    };
    for (const chat of active) for (const m of chat.members) if (m.windowId && !m.left && m.kind !== "user") await infoOf(m.windowId);
    const plan = nextSends(active, view);
    for (const chat of active) {
      for (const msg of chat.messages) {
        for (const [handle, d] of Object.entries(msg.deliveries)) {
          if (d.state !== "queued" || d.reason === "sent") continue;
          const m = chat.members.find((x) => x.handle === handle);
          if (!m) continue;
          const info = m.windowId ? infos.get(m.windowId) : undefined;
          const why = !view(chat, m).online ? "offline" : info?.kind === "codex" && !info.thread ? "no conversation yet" : undefined;
          if (d.reason !== why) {
            if (why) d.reason = why;
            else delete d.reason;
            changed.add(chat.id);
          }
        }
      }
    }
    for (const f of plan.fail) {
      const chat = chats.get(f.chatId)!;
      chat.messages.find((x) => x.id === f.msgId)!.deliveries[f.handle] = { state: "failed", reason: f.reason, at: now() };
      changed.add(chat.id);
    }
    for (const s of plan.send) {
      const chat = chats.get(s.chatId)!;
      const msg = chat.messages.find((x) => x.id === s.msgId)!;
      const member = chat.members.find((x) => x.handle === s.handle)!;
      // Earlier sends were awaited: a Remove, an archive or a pause may have landed since.
      const d = msg.deliveries[s.handle];
      if (!d || d.state !== "queued" || d.reason === "sent" || member.left || chat.archived) continue;
      const info = await infoOf(member.windowId!);
      const adapter = deps.adapters[member.kind as AgentKind];
      changed.add(chat.id);
      if (!info || !adapter) {
        msg.deliveries[s.handle] = { state: "failed", reason: adapter ? "offline" : "unavailable", at: now() };
        continue;
      }
      const to = await target(member, info);
      const text = deliveryText(chat, member, msg, missedFor(chat, member.handle, msg.id), { home, several: chatsOf(member.windowId!).length > 1 });
      // Marked and saved before it goes: a crash in between leaves a message
      // that is never confirmed, never one that is sent twice. What the member
      // has seen moves only once it has gone.
      msg.deliveries[s.handle] = { state: "queued", reason: "sent", at: now(), probe: { tag: tagOf(chat, msg.id), ...(to.transcript ? { path: to.transcript } : {}), offset: await sizeOf(to.transcript) } };
      await save(chat);
      let res: SendResult;
      try {
        res = await adapter.send(to, text);
      } catch (e) {
        res = { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
      if (res.ok) {
        member.welcomed = true;
        member.lastSeq = Math.max(member.lastSeq ?? 0, msg.id);
        await save(chat);
        continue;
      }
      msg.deliveries[s.handle] = res.reason === "offline"
        ? { state: "queued", reason: "offline", at: now() }
        : { state: "failed", reason: res.detail ? `${res.reason}: ${res.detail}` : res.reason, at: now() };
      await save(chat);
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
      const same = sameAgent(m, info);
      // Another agent's state is not this member's.
      const state = same ? (l?.state ?? info.state) : undefined;
      agents[m.handle] = {
        online: reachable(m, info),
        ...(state ? { state } : {}),
        ...(l?.session ? { session: l.session } : {}),
        ...(info?.daemon ? { daemon: true } : {}),
        ...(info && !same ? { replaced: true } : {}),
      };
    }
    return { chat, agents };
  }

  return { handle, hook, tick, busy, summaries, view, ready };
}

export type ChatService = ReturnType<typeof createChatService>;
