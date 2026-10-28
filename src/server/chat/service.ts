import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAT_RULES_VERSION } from "../../shared/chat-rules";
import { CHAT_MODES, MAX_NOTES, type AgentKind, type Chat, type ChatMember, type ChatMessage, type ChatMode, type ChatNotes, type ChatSummary } from "../../shared/chat";
import type { AgentState, ChatMemberLive, ChatSpawn, ClientMessage } from "../../shared/protocol";
import { profileLabel } from "../usage";
import { processAlive, type WindowAgentInfo } from "../tmux";
import { usageLimit, type UsageLimit } from "./limits";
import { searchChats } from "./search";
import { claudeSocket, hasTag, type Adapter, type AgentTarget, type SendResult } from "./adapters";
import { addMember, discardHeld, leave, newChat, post, reveal, resolveMentions, setBrief, setCap, setMode, startRound, stop, summary } from "./model";
import { nextSends, type AgentView } from "./plan";
import type { ChatStore } from "./store";
import { packetText, packetReceiptTag, joinMessage, handoffText, readText, unescapeNewlines, whoText } from "./text";
import { said as saidIn, type Said, type Where } from "./turns";

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
export type ChatClientMessage = Exclude<Extract<ClientMessage, { t: `chat-${string}` }>, { t: "chat-open" | "chat-search" }>;
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
      case "chat-delete": return str(m.id) && typeof m.closeTabs === "boolean";
      case "chat-discard-held": return str(m.id);
      case "chat-mode": return str(m.id) && (m.mode === null || CHAT_MODES.includes(m.mode as ChatMode));
      case "chat-brief": return str(m.id) && str(m.text) && (m.expectRev === undefined || (Number.isSafeInteger(m.expectRev) && (m.expectRev as number) >= 0));
      case "chat-notes": return str(m.id) && str(m.text) && Number.isSafeInteger(m.rev) && (m.rev as number) >= 0 && str(m.req) && (m.req as string).length <= 64;
      case "chat-handoff": return str(m.id) && Array.isArray(m.to) && m.to.every(str) && str(m.question) && str(m.excerpt) && str(m.label) && (m.repo === undefined || str(m.repo)) && (m.revision === undefined || str(m.revision));
      case "chat-round": return str(m.id) && (m.action === "start" || m.action === "end") && (m.topic === undefined || str(m.topic));
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
  /** What an agent said in its tab in one turn; tests stand in for it. */
  said?: (kind: AgentKind, path: string, where: Where) => Promise<Said | null>;
  /** Whether an agent process still runs; tests stand in for it. */
  alive?: (pid: number) => boolean;
  /** Closes a tab, ending the agent in it. */
  closeWindow?: (windowId: string) => Promise<void>;
  now?: () => string;
  home?: string;
}

type Result = { ok: true; chatId?: string; notice?: string; notes?: ChatNotes } | { ok: false; error: string; notes?: ChatNotes; conflict?: true };

/** A spawned agent whose tab never stamped within this long is reported as not started. */
const SPAWN_TIMEOUT_MS = 90_000;
/** For this long after it was added, one that hasn't started is still watched, and joins once it does. */
const LATE_JOIN_MS = 30 * 60_000;
/** A message handed to an idle agent with no sign of it after this long was not read. */
const UNCONFIRMED_MS = 5 * 60_000;
/** A tab that can't be read for this long after a message went to it is gone, not between reads. */
const GONE_MS = 30_000;
/** A turn still running this long after its post is read as it stands. */
const TURN_MS = 30 * 60_000;
/** The longest chat line: a delivery is one argument to `codex queue`, and a review fits well inside. */
export const MAX_TEXT = 32_000;
/** The longest brief: it rides on a wake whenever it changes, so it stays short. */
export const MAX_BRIEF = 4_000;
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
  const said = deps.said ?? saidIn;
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
  /** A Codex member whose last turn ended on the usage limit, while that limit still holds. */
  const limitOf = async (m: ChatMember, info: WindowAgentInfo | null | undefined): Promise<UsageLimit | null> => {
    if (m.kind !== "codex" || !sameAgent(m, info) || !info.thread?.path) return null;
    const l = await usageLimit(info.thread.path);
    return l && (l.untilMs === undefined || l.untilMs > Date.parse(now())) ? l : null;
  };
  const chats = new Map<string, Chat>();
  let loaded: Promise<void> | null = null;
  const ready = () => (loaded ??= deps.store.list().then((list) => { for (const c of list) chats.set(c.id, c); }));
  // A chat deleted while a tick or hook still held it stays deleted.
  /** A notes write on its way to disk, per chat: the next waits for it, so a revision is never handed out twice. */
  const notesSaving = new Map<string, Promise<unknown>>();
  // Any other save of the chat waits for a notes write, then takes the chat as
  // it stands: with the notes if they were written, without if they weren't.
  // Either way the disk never holds notes the user was told failed.
  const save = (chat: Chat): Promise<void> => {
    const go = () => (chats.get(chat.id) === chat ? deps.store.save(chat) : Promise.resolve());
    const notes = notesSaving.get(chat.id);
    return notes ? notes.then(go) : go();
  };

  const live = (m: ChatMember, states: Map<string, WindowLive>) => (m.windowId ? states.get(m.windowId) : undefined);

  /** What the agent said in its tab, under a line of the chat: unless it adds nothing, and never longer than a chat line, keeping its end. */
  function addTab(msg: ChatMessage, text: string | undefined) {
    const t = text?.trim();
    if (!t || t === msg.text.trim()) return;
    msg.tabText = t.length > MAX_TEXT ? `…\n${t.slice(-MAX_TEXT)}` : t;
  }

  /** A member's posts get the turns they were made in: each turn under its last post. */
  async function settle(chat: Chat, m: ChatMember) {
    const posts = m.turns!;
    delete m.turns;
    const last = new Map<string, { msg: ChatMessage; text: string }>();
    for (const p of posts) {
      const s = await said(m.kind as AgentKind, p.path, { at: p.at });
      const msg = chat.messages.find((x) => x.id === p.msgId);
      if (s && msg) last.set(`${p.path}#${s.start}`, { msg, text: s.text });
    }
    for (const { msg, text } of last.values()) addTab(msg, text);
  }

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
        const m = addMember(chat, { kind: req.kind, folder: req.folder, session: req.session, spawn: "failed", spawnError: e instanceof Error ? e.message : String(e), ...(req.profile ? { profile: req.profile } : {}), ...(req.role ? { role: req.role } : {}) }, t);
        post(chat, m.handle, `${m.handle} didn't start: ${m.spawnError}`, t, { system: true });
        continue;
      }
      addMember(chat, { kind: req.kind, windowId, folder: req.folder, session: req.session, spawn: "pending", ...(req.profile ? { profile: req.profile } : {}), ...(req.role ? { role: req.role } : {}) }, t);
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

  /**
   * Close the tabs of a deleted chat's agents: only an agent that is still the
   * one that joined, or one the chat started that may still join, and in no
   * other open chat. What it did, for the user.
   */
  async function shutDown(chat: Chat): Promise<string> {
    const down: string[] = [];
    const kept: string[] = [];
    const failed: string[] = [];
    for (const m of chat.members) {
      if (m.kind === "user" || m.left || !m.windowId) continue;
      const other = chatsOf(m.windowId)[0];
      if (other) {
        kept.push(`${m.handle}, in "${other.chat.name}"`);
        continue;
      }
      const info = await deps.tmux.agentOfWindow(m.windowId);
      // Its tab, opened by the chat, before its agent has stamped it: at a trust prompt, say.
      const starting = !info && !!m.spawn && Date.parse(now()) - Date.parse(m.joinedAt) <= LATE_JOIN_MS;
      if (info && !sameAgent(m, info)) kept.push(`${m.handle}, its tab now runs another agent`);
      else if (!info && !starting) kept.push(`${m.handle}, no agent has started in its tab`);
      else if (starting || info!.pid === undefined || alive(info!.pid)) {
        try {
          await deps.closeWindow?.(m.windowId);
          down.push(m.handle);
        } catch (e) {
          failed.push(`Couldn't close ${m.handle}'s tab: ${e instanceof Error ? e.message : String(e)}.`);
        }
      }
    }
    const said = [down.length ? `Shut down ${down.join(", ")}.` : "", kept.length ? `Left running: ${kept.join("; ")}.` : "", ...failed].filter(Boolean).join(" ");
    return said || "None of its agents was running.";
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
          if (!Number.isInteger(m.cap) || m.cap < 0 || m.cap > 50) return { ok: false, error: "The cap is a whole number from 1 to 50, or 0 for no cap." };
          setCap(chat, m.cap, now());
        }
        break;
      case "chat-archive":
        chat.archived = m.archived;
        if (m.archived) cancelPending(chat, "archived");
        break;
      case "chat-delete":
        // Out of the room first, so a tick or hook still holding it neither saves nor sends it.
        chats.delete(chat.id);
        try {
          await deps.store.remove(chat.id);
        } catch (e) {
          chats.set(chat.id, chat);
          return { ok: false, error: `Couldn't delete it: ${e instanceof Error ? e.message : String(e)}` };
        }
        return m.closeTabs ? { ok: true, notice: await shutDown(chat) } : { ok: true };
      case "chat-discard-held":
        discardHeld(chat, now());
        break;
      case "chat-mode":
        setMode(chat, m.mode ?? undefined, now());
        break;
      case "chat-notes": {
        while (notesSaving.has(chat.id)) await notesSaving.get(chat.id);
        if (chats.get(chat.id) !== chat) return { ok: false, error: "No such chat." };
        const current = chat.notes ?? { text: "", rev: 0, updatedAt: "" };
        if (m.text.length > MAX_NOTES) return { ok: false, error: `The notes are ${m.text.length.toLocaleString("en-US")} characters; they hold ${MAX_NOTES.toLocaleString("en-US")}.`, notes: current };
        if (m.rev !== current.rev) return { ok: false, conflict: true, error: "These notes changed in another window.", notes: current };
        // The same words again (a retry, a blur) are no new revision.
        if (m.text === current.text) return { ok: true, chatId: chat.id, notes: current };
        // Written as a copy first: the chat, its view and search take the new
        // notes only once they are on disk.
        const next = { text: m.text, rev: current.rev + 1, updatedAt: now() };
        const writing = deps.store.save({ ...chat, notes: next });
        const settled = writing.then(() => { if (chats.get(chat.id) === chat) chat.notes = next; }, () => {});
        notesSaving.set(chat.id, settled);
        try {
          await writing;
          await settled;
          // Deleted while it was written: nothing was kept, so nothing is called saved.
          if (chats.get(chat.id) !== chat) return { ok: false, error: "No such chat." };
        } catch (e) {
          return { ok: false, error: `Couldn't save the notes: ${e instanceof Error ? e.message : String(e)}`, notes: current };
        } finally {
          if (notesSaving.get(chat.id) === settled) notesSaving.delete(chat.id);
        }
        return { ok: true, chatId: chat.id, notes: next };
      }
      case "chat-brief":
        // A brief edited from a stale copy is turned back, not written over the newer one.
        if (m.expectRev !== undefined && m.expectRev !== (chat.brief?.rev ?? 0)) return { ok: false, error: "The brief changed in another window. Reopen it to see the current one." };
        if (m.text.length > MAX_BRIEF) return { ok: false, error: `The brief is ${m.text.length.toLocaleString("en-US")} characters; keep it under ${MAX_BRIEF.toLocaleString("en-US")}, and point to a file for more.` };
        setBrief(chat, m.text, now());
        break;
      case "chat-handoff": {
        const live = new Set(chat.members.filter((x) => x.kind !== "user" && !x.left).map((x) => x.handle));
        const to = [...new Set(m.to)];
        if (to.length === 0 || to.some((h) => !live.has(h))) return { ok: false, error: "Pick agents that are still in the chat." };
        if (!m.question.trim() || !m.excerpt.trim()) return { ok: false, error: "A handoff needs a question and an excerpt." };
        // A participant in an open blind round isn't handed another's answer: it would anchor it.
        if (chat.round?.state === "open" && to.some((h) => chat.round!.participants.includes(h))) return { ok: false, error: "A blind round is open: end it before handing an excerpt to a participant." };
        const label = m.label.trim() || "excerpt";
        const source = { label, ...(m.repo?.trim() ? { repo: m.repo.trim() } : {}), ...(m.revision?.trim() ? { revision: m.revision.trim() } : {}) };
        const text = handoffText(to, m.question, m.excerpt, source);
        if (text.length > MAX_TEXT) return { ok: false, error: `That's ${tooLong(text.length)}` };
        // Named by the user, not read out of the excerpt: an `@Override` in a diff wakes nobody.
        post(chat, "user", text, now(), { handoff: source, to });
        break;
      }
      case "chat-round":
        if (m.action === "end") {
          if (!reveal(chat, now())) return { ok: false, error: "No round is open." };
        } else {
          const err = startRound(chat, (m.topic ?? "").trim() || "what is going on here", now());
          if (err) return { ok: false, error: err };
        }
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
        const text = unescapeNewlines(args.join(" ").trim());
        if (!text) return { ok: false, output: `NOT POSTED: nothing to say. Usage: mux say "<text>"` };
        if (text.length > MAX_TEXT) return { ok: false, output: `NOT POSTED: ${tooLong(text.length)}` };
        const msg = post(chat, member.handle, text, t);
        delete member.awaiting;
        delete member.sawRunning;
        delete member.wake;
        // What it says in its tab this turn goes under the post once the turn
        // ends: where its transcript stands now places the post in its turn.
        const path = info ? transcriptOf(info) : undefined;
        if (path) (member.turns ??= []).push({ msgId: msg.id, path, at: await sizeOf(path), since: t });
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
      case "submit": {
        const round = chat.round;
        if (round?.state !== "open") return { ok: false, output: "NOT POSTED: no round is open. Use mux say." };
        if (!round.participants.includes(member.handle)) return { ok: false, output: "NOT POSTED: you weren't asked in this round. Use mux say." };
        const usage = `mux submit --chat ${chat.id} ${round.id} "<your hypothesis and evidence>"`;
        if (args[0] !== round.id) return { ok: false, output: `NOT POSTED: the open round is ${round.id}. Usage: ${usage}` };
        const text = unescapeNewlines(args.slice(1).join(" ").trim());
        if (!text) return { ok: false, output: `NOT POSTED: nothing to submit. Usage: ${usage}` };
        if (text.length > MAX_TEXT) return { ok: false, output: `NOT POSTED: ${tooLong(text.length)}` };
        const msg = post(chat, member.handle, text, t, { submit: true });
        delete member.awaiting;
        delete member.sawRunning;
        delete member.wake;
        const path = info ? transcriptOf(info) : undefined;
        if (path) (member.turns ??= []).push({ msgId: msg.id, path, at: await sizeOf(path), since: t });
        await save(chat);
        const left = round.state === "open" ? round.participants.filter((h) => !round.submitted.includes(h)) : [];
        return { ok: true, output: left.length ? `submitted as #${msg.id}; held until ${left.map((h) => `@${h}`).join(" ")} submit${left.length === 1 ? "s" : ""} or @user ends the round` : `submitted as #${msg.id}; the round is revealed` };
      }
      case "read": {
        let n = 20;
        const range: { since?: number; before?: number; human?: boolean } = {};
        let count = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i]!;
          if (arg === "--human") range.human = true;
          else if (arg === "--since" || arg === "--before") {
            const v = args[++i];
            if (v === undefined || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return { ok: false, output: "Usage: mux read [n] [--since ID] [--before ID] [--human]" };
            range[arg === "--since" ? "since" : "before"] = Number(v);
          } else if (!count && /^\d+$/.test(arg) && Number(arg) > 0 && Number.isSafeInteger(Number(arg))) {
            n = Math.min(Number(arg), 200); count = true;
          } else return { ok: false, output: "Usage: mux read [n] [--since ID] [--before ID] [--human]" };
        }
        return { ok: true, output: readText(chat, n, member.handle, range) };
      }
      case "rules": return { ok: true, output: [joinMessage(chat, member, { home }), chat.brief?.text ? `\nBrief from @user (rev ${chat.brief.rev}):\n${chat.brief.text}` : "\nNo pinned brief."].join("\n") };
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
        return { ok: false, output: `NOT POSTED: unknown command "${cmd ?? ""}". Use mux say, submit, read, who, stop or leave.` };
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
    const limits = new Map<string, UsageLimit>();
    const idle = (m: ChatMember, info: WindowAgentInfo | null) => {
      const state = live(m, states)?.state ?? info?.state;
      return state === undefined || state === "done";
    };

    for (const chat of active) {
      for (const m of chat.members) {
        // Its last post's turn is over when its stamp says so after the post,
        // its process has gone, or after half an hour; an unreadable tab is
        // not enough. One that left in that turn still gets it.
        if (m.turns?.length) {
          const info = m.windowId ? await infoOf(m.windowId) : null;
          const posted = Date.parse(m.turns.at(-1)!.since);
          const over = sameAgent(m, info)
            ? info.state !== "running" && info.state !== "input" && (info.since ?? 0) >= Math.floor(posted / 1000)
            : m.pid !== undefined && !alive(m.pid);
          if (over || Date.parse(now()) - posted > TURN_MS) {
            await settle(chat, m);
            changed.add(chat.id);
          }
        }
        if (m.kind === "user" || m.left || !m.windowId) continue;
        const info = await infoOf(m.windowId);
        // A tab started from the chat joins once its agent stamps it.
        // One slow to start -- waiting on a prompt in its tab, say -- still
        // joins once an agent of its kind does; one whose tab has gone can be retried.
        if (m.spawn === "pending" || m.spawn === "failed") {
          if (info && info.kind === m.kind && !info.daemon && info.pid) {
            delete m.spawn;
            delete m.spawnError;
            m.paneId = info.paneId;
            m.pid = info.pid;
            if (info.server) m.server = info.server;
            if (info.cwd) m.folder = info.cwd;
            const id = idOf(info);
            if (id) m.agentId = id;
            post(chat, m.handle, `${m.handle} joined${m.role ? ` as ${m.role}` : ""}`, now(), { system: true });
            changed.add(chat.id);
          } else if (m.spawn === "pending" && Date.parse(now()) - Date.parse(m.joinedAt) > SPAWN_TIMEOUT_MS) {
            m.spawn = "failed";
            m.spawnError = "nothing has started in its tab yet: check it, it may be waiting on a prompt such as trusting a new folder";
            post(chat, m.handle, `${m.handle} hasn't started: ${m.spawnError}`, now(), { system: true });
            changed.add(chat.id);
          } else if (m.spawn === "failed" && !info && deps.windows && !(await deps.windows()).includes(m.windowId)) {
            delete m.windowId;
            m.spawnError = "its tab was closed before it started";
            changed.add(chat.id);
          }
          continue;
        }
        // Out of credits: said once in the chat, and its messages wait until the limit lifts.
        const limit = await limitOf(m, info);
        if (limit) {
          limits.set(`${chat.id} ${m.handle}`, limit);
          const key = `${limit.at} ${limit.until}`;
          if (m.limited !== key) {
            m.limited = key;
            post(chat, m.handle, `${m.handle} is out of usage credits${limit.until ? ` until ${limit.until}` : ""}; messages to it wait until then`, now(), { system: true });
            changed.add(chat.id);
          }
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
        // A turn the chat started that ended with nothing said back: seen
        // running and then done, or -- a turn too short to be seen -- stamped
        // done after the message went.
        if (m.awaiting !== undefined) {
          const state = live(m, states)?.state;
          const doneSince = sameAgent(m, info) && info.state === "done" && !!m.wake && (info.since ?? 0) >= Math.floor(Date.parse(m.wake.sent) / 1000);
          if (state === "running" || state === "input") m.sawRunning = true;
          else if ((state === "done" && m.sawRunning) || doneSince) {
            // Claude Code can queue a message behind the turn it is in and
            // read it as the next: until it has been read, that turn is not
            // its answer. Half an hour on, it is called unanswered regardless.
            const s = m.wake ? await said(m.kind as AgentKind, m.wake.path, { ...(m.wake.from !== undefined ? { from: m.wake.from } : {}), tag: m.wake.tag }) : null;
            if (s || !m.wake || Date.parse(now()) - Date.parse(m.wake.sent) > TURN_MS) {
              delete m.awaiting;
              delete m.sawRunning;
              const line = post(chat, m.handle, `${m.handle} finished without replying`, now(), { system: true });
              addTab(line, s?.text);
              delete m.wake;
              changed.add(chat.id);
            }
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
              m.wake = { path, tag: p?.tag ?? tagOf(chat, msg.id), sent: d.at, ...(p && p.path === path ? { from: p.offset } : {}) };
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

    const view = (c: Chat, m: ChatMember): AgentView => {
      const info = m.windowId ? (infos.get(m.windowId) ?? null) : null;
      // A Codex tab with no conversation yet has no thread to queue to: its messages wait. So do one out of credits.
      const threadless = info?.kind === "codex" && !info.daemon && !info.thread;
      return {
        kind: m.kind as AgentKind,
        online: reachable(m, info),
        idle: !threadless && !limits.has(`${c.id} ${m.handle}`) && idle(m, info),
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
          const limit = limits.get(`${chat.id} ${m.handle}`);
          const why = !view(chat, m).online ? "offline" : info?.kind === "codex" && !info.thread ? "no conversation yet" : limit ? `out of credits${limit.until ? ` until ${limit.until}` : ""}` : undefined;
          if (d.reason !== why) {
            if (why) d.reason = why;
            else delete d.reason;
            changed.add(chat.id);
          }
        }
      }
    }
    for (const f of plan.fail) {
      const chat = chats.get(f.chatId);
      if (!chat) continue;
      chat.messages.find((x) => x.id === f.msgId)!.deliveries[f.handle] = { state: "failed", reason: f.reason, at: now() };
      changed.add(chat.id);
    }
    for (const s of plan.send) {
      // Earlier sends were awaited: a delete, a Remove, an archive or a pause may have landed since.
      const chat = chats.get(s.chatId);
      if (!chat) continue;
      let messages = (s.msgIds ?? [s.msgId]).map((id) => chat.messages.find((x) => x.id === id)).filter((m): m is ChatMessage => !!m);
      if (!messages.length) continue;
      const msg = messages[0]!;
      const member = chat.members.find((x) => x.handle === s.handle)!;
      const d = msg.deliveries[s.handle];
      if (!d || d.state !== "queued" || d.reason === "sent" || member.left || chat.archived) continue;
      const info = await infoOf(member.windowId!);
      const adapter = deps.adapters[member.kind as AgentKind];
      changed.add(chat.id);
      if (!info || !adapter) {
        for (const message of messages) message.deliveries[s.handle] = { state: "failed", reason: adapter ? "offline" : "unavailable", at: now() };
        continue;
      }
      const to = await target(member, info);
      const offset = await sizeOf(to.transcript);
      // Those awaits let a reveal, a delete, an archive, a Remove or a pause land: look again before anything is stamped sent.
      const now1 = msg.deliveries[s.handle];
      if (chats.get(chat.id) !== chat || chat.archived || member.left || !now1 || now1.state !== "queued" || now1.reason === "sent") continue;
      messages = messages.filter((m) => { const d = m.deliveries[s.handle]; return d?.state === "queued" && d.reason !== "sent" && !m.blind; });
      if (!messages.length) continue;
      const last = messages.at(-1)!;
      const packetIds = new Set(messages.map((m) => m.id));
      const unseen = chat.messages.filter((m) => m.id > (member.lastSeq ?? 0) && m.id < last.id && !packetIds.has(m.id) && m.from !== member.handle && !m.system && !m.blind);
      const peerTail = new Set(unseen.filter((m) => m.from !== "user" || m.auto).slice(-5).map((m) => m.id));
      // Human steering between addressed messages is part of this wake too, never lost behind its cursor.
      const lines = unseen.filter((m) => (m.from === "user" && !m.auto) || peerTail.has(m.id));
      const text = packetText(chat, member, messages, { lines, older: unseen.length - lines.length }, { home, several: chatsOf(member.windowId!).length > 1 });
      // What this wake carries of the mode and brief: noted once it has gone.
      const told = { mode: chat.mode ?? "", brief: chat.brief?.rev ?? 0 };
      // Marked and saved before it goes: a crash in between leaves a message
      // that is never confirmed, never one that is sent twice. What the member
      // has seen moves only once it has gone.
      const probe = { tag: packetReceiptTag(text, last.id), ...(to.transcript ? { path: to.transcript } : {}), offset };
      for (const message of messages) message.deliveries[s.handle] = { state: "queued", reason: "sent", at: now(), probe };
      await save(chat);
      let res: SendResult;
      try {
        res = await adapter.send(to, text);
      } catch (e) {
        res = { ok: false, reason: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
      if (res.ok) {
        member.welcomed = true;
        const bytes = new TextEncoder().encode(text).length;
        member.payload = { count: (member.payload?.count ?? 0) + 1, bytes: (member.payload?.bytes ?? 0) + bytes, last: bytes };
        member.rulesSent = CHAT_RULES_VERSION;
        member.modeSent = told.mode;
        member.briefSent = told.brief;
        member.lastSeq = Math.max(member.lastSeq ?? 0, last.id);
        await save(chat);
        continue;
      }
      for (const message of messages) message.deliveries[s.handle] = res.reason === "offline"
        ? { state: "queued", reason: "offline", at: now() }
        : { state: "failed", reason: res.detail ? `${res.reason}: ${res.detail}` : res.reason, at: now() };
      await save(chat);
    }
    await Promise.all([...changed].flatMap((id) => (chats.has(id) ? [save(chats.get(id)!)] : [])));
    return [...changed];
  }

  /** Whether a tick has anything to do: something queued, in flight, starting, or awaiting a reply. */
  function busy(): boolean {
    for (const chat of chats.values()) {
      if (chat.archived) continue;
      const late = (m: ChatMember) => m.spawn === "failed" && !!m.windowId && Date.parse(now()) - Date.parse(m.joinedAt) <= LATE_JOIN_MS;
      if (chat.members.some((m) => m.spawn === "pending" || late(m) || m.awaiting !== undefined || m.turns !== undefined)) return true;
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
      const limit = await limitOf(m, info);
      // Another agent's state is not this member's; one stopped by its usage limit isn't working, whatever its tab says.
      const state = limit ? "done" : same ? (l?.state ?? info.state) : undefined;
      agents[m.handle] = {
        online: reachable(m, info),
        ...(state ? { state } : {}),
        ...(limit ? { limit: { until: limit.until } } : {}),
        ...(l?.session ? { session: l.session } : {}),
        ...(info?.daemon ? { daemon: true } : {}),
        ...(info && !same ? { replaced: true } : {}),
      };
    }
    return { chat, agents };
  }

  /** The browser's chat search: over every chat, archived too. */
  async function search(query: string, opts: { chatId?: string; cursor?: number }) {
    await ready();
    return searchChats(chats.values(), query, opts);
  }

  return { handle, hook, tick, busy, summaries, view, ready, search };
}

export type ChatService = ReturnType<typeof createChatService>;
