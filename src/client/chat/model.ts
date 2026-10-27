import { splitCategory } from "../../shared/category";
import { MEMBER_COLOURS, mentionParts, resolveMentions, type Chat, type ChatGlyph, type ChatMember, type ChatSummary } from "../../shared/chat";
import type { ChatMemberLive, SessionInfo } from "../../shared/protocol";

/**
 * What the chat UI draws, worked out from the chat and nothing else: the DOM
 * code turns these into elements. Calm by default -- a delivery state shows
 * only where something went wrong, and goes when it is put right.
 */

export type SideTab = "chats" | "workspaces";

export function sideTab(saved: string | null): SideTab {
  return saved === "chats" ? "chats" : "workspaces";
}

export interface ChatRow {
  id: string;
  name: string;
  glyph: ChatGlyph;
  archived: boolean;
}

export function chatRows(chats: readonly ChatSummary[], query: string): { active: ChatRow[]; archived: ChatRow[] } {
  const q = query.trim().toLowerCase();
  const rows = chats
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => ({ id: c.id, name: c.name, glyph: c.glyph, archived: c.archived }));
  return { active: rows.filter((r) => !r.archived), archived: rows.filter((r) => r.archived) };
}

/** Chats with a question for the user, except the one on screen: what Next waiting counts. */
export function chatsAsking(chats: readonly ChatSummary[], openId: string | null): ChatSummary[] {
  return chats.filter((c) => c.glyph === "input" && !c.archived && c.id !== openId);
}

/** Each tab's chats, for the mark it wears. */
export function tabChats(chats: readonly ChatSummary[]): Map<string, ChatSummary[]> {
  const out = new Map<string, ChatSummary[]>();
  for (const c of chats) {
    if (c.archived) continue;
    for (const w of c.windows) out.set(w, [...(out.get(w) ?? []), c]);
  }
  return out;
}

export function memberColour(m: ChatMember): string | null {
  return m.kind === "user" ? null : MEMBER_COLOURS[m.colour % MEMBER_COLOURS.length]!;
}

export interface Row {
  id: number;
  kind: "msg" | "system";
  from: string;
  shape: string;
  colour: string | null;
  me: boolean;
  text: string;
  parts: { text: string; mention?: true }[];
  /** ✓ every recipient has it; ◷ one still waits; null for a line that woke nobody. */
  tick: "✓" | "◷" | null;
  /** One short line per recipient whose delivery went wrong. */
  exceptions: string[];
  /** The speaker changed: a little room above. */
  turnStart: boolean;
  at: string;
  /** What the agent said in its own tab that turn, folded under the line. */
  tab: { text: string; lines: number } | null;
}

const tabOf = (text: string | undefined) => (text ? { text, lines: text.split("\n").length } : null);

function exception(handle: string, state: string, reason?: string): string | null {
  if (state === "failed" && reason?.startsWith("not confirmed: ")) return `✕ not confirmed for ${handle} · ${reason.slice("not confirmed: ".length)}`;
  if (state === "failed") return `✕ not delivered to ${handle} · ${reason ?? "failed"}`;
  if (state === "queued" && reason === "offline") return `✕ not delivered to ${handle} · offline, it gets it when its tab is back`;
  if (state === "queued" && reason === "no conversation yet") return `◷ queued for ${handle} · it hasn't started a conversation yet`;
  return null;
}

export function messageRows(chat: Chat): Row[] {
  const rows: Row[] = [];
  let last: string | null = null;
  for (const m of chat.messages) {
    const member = chat.members.find((x) => x.handle === m.from);
    if (m.system) {
      rows.push({ id: m.id, kind: "system", from: m.from, shape: "·", colour: null, me: false, text: m.text, parts: [{ text: m.text }], tick: null, exceptions: [], turnStart: false, at: m.at, tab: tabOf(m.tabText) });
      continue;
    }
    const ds = Object.entries(m.deliveries);
    const live = ds.filter(([, d]) => d.state !== "cancelled");
    const tick = live.length === 0 ? null : live.every(([, d]) => d.state === "delivered") ? "✓" : live.some(([, d]) => d.state === "queued" || d.state === "held") ? "◷" : null;
    rows.push({
      id: m.id,
      kind: "msg",
      from: m.from,
      shape: member?.shape ?? "·",
      colour: member ? memberColour(member) : null,
      me: m.from === "user",
      text: m.text,
      parts: mentionParts(m.text),
      tick,
      exceptions: ds.flatMap(([h, d]) => exception(h, d.state, d.reason) ?? []),
      turnStart: m.from !== last,
      at: m.at,
      tab: tabOf(m.tabText),
    });
    last = m.from;
  }
  return rows;
}

export function composerState(chat: Chat, draft: string): { to: string[]; helper: string | null } {
  if (!draft.trim()) return { to: [], helper: null };
  const to = resolveMentions(chat, draft).to.filter((h) => h !== "user");
  return { to, helper: to.length ? null : "No agents notified" };
}

/** The agent the message box starts with: the last one to speak to the user, while still here. */
export function prefill(chat: Chat): string | null {
  const h = chat.lastSpokeToUser;
  return h && chat.members.some((m) => m.handle === h && !m.left) ? h : null;
}

/**
 * The message box's chips after the chat changed. The prefill is offered once
 * per agent that speaks to the user, when the box is empty: a chip the user
 * took off stays off until another agent speaks to them, or they send (which
 * clears `offered`).
 */
export function prefillChips(s: { chips: string[]; draft: string; offered: string | null }, chat: Chat): { chips: string[]; draft: string; offered: string | null } {
  const p = prefill(chat);
  if (p === s.offered || s.draft.trim() || s.chips.length) return s;
  return { ...s, offered: p, chips: p ? [p] : [] };
}

export function heldCount(chat: Chat): number {
  let n = 0;
  for (const m of chat.messages) for (const d of Object.values(m.deliveries)) if (d.state === "held") n++;
  return n;
}

const KIND: Record<string, string> = { claude: "Claude", codex: "Codex" };
const STATE: Record<string, string> = { running: "working", input: "waiting on you", done: "idle" };

export function mentionChoices(chat: Chat, agents: Record<string, ChatMemberLive>, query: string): { handle: string; meta: string }[] {
  const q = query.toLowerCase();
  return chat.members
    .filter((m) => m.kind !== "user" && !m.left && m.handle.toLowerCase().startsWith(q))
    .map((m) => {
      const live = agents[m.handle];
      const state = live?.online === false ? "offline" : STATE[live?.state ?? ""] ?? "idle";
      return { handle: m.handle, meta: [KIND[m.kind], live?.session ?? m.session, m.role, state].filter(Boolean).join(" · ") };
    });
}

export interface MemberStatus {
  text: string;
  fix?: "open" | "reconnect" | "retry";
  alarm?: boolean;
}

/** The cap typed into its field: a whole number from 0 (no cap) to 50, else null. A blank is null, never no cap. */
export function parseCap(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n <= 50 ? n : null;
}

/**
 * Whether a member's terminal can open beside the chat: its agent is online,
 * or it is still starting in the tab the chat opened for it, where whatever
 * holds it up (a trust prompt, say) is waiting to be answered.
 */
export function canOpen(m: ChatMember, live: ChatMemberLive | undefined): boolean {
  return !m.left && !!m.windowId && (live?.online === true || !!m.spawn);
}

/** What a member's row says, and the one action that puts it right. */
export function memberStatus(chat: Chat, m: ChatMember, live: ChatMemberLive | undefined): MemberStatus {
  // With a tab, it is still starting there and its tab shows why; without one, it never opened.
  if (m.spawn === "failed" && m.windowId) return { text: `hasn't started: ${m.spawnError ?? "unknown"}`, fix: "open", alarm: true };
  if (m.spawn === "failed") return { text: `didn't start: ${m.spawnError ?? "unknown"}`, fix: "retry", alarm: true };
  if (m.spawn === "pending") return { text: "starting…", fix: "open" };
  if (!live?.online) {
    let waiting = 0;
    for (const msg of chat.messages) {
      const d = msg.deliveries[m.handle];
      if (d && (d.state === "queued" || d.state === "held") && d.reason !== "sent") waiting++;
    }
    return { text: `${live?.replaced ? "another agent runs in its tab" : "offline"} · ${waiting} waiting`, fix: "reconnect" };
  }
  if (live.state === "input") return { text: "needs attention", fix: "open", alarm: true };
  return { text: STATE[live.state ?? ""] ?? "idle" };
}

export function headerSummary(chat: Chat, agents: Record<string, ChatMemberLive>): { members: number; needsYou: boolean; offline: number } {
  const live = chat.members.filter((m) => m.kind !== "user" && !m.left);
  return {
    members: live.length,
    needsYou: live.some((m) => agents[m.handle]?.state === "input"),
    offline: live.filter((m) => agents[m.handle] && !agents[m.handle]!.online && m.spawn !== "pending").length,
  };
}

export interface PickerAgent {
  windowId: string;
  session: string;
  name: string;
  kind: "claude" | "codex";
  profile?: string;
  folder?: string;
  /** A Codex tab that hasn't stamped yet: no conversation, or the shared daemon. */
  waiting: boolean;
}

/**
 * Where a new agent in `session` starts: beside the agent picked when it is in
 * that workspace, else in ~, belonging to no project. You can type any folder.
 */
export function stagedFolder(session: string, picked?: { session: string; folder?: string }): string {
  return picked?.folder && picked.session === session ? picked.folder : "~";
}

/**
 * The profile a new Claude runs as, which is what its box shows. A workspace
 * named for a profile, `[Work] …`, starts its tabs as that profile, so its
 * name comes first; else the picked agent's when it is in that workspace;
 * else the box's first. With one profile there is no box: unset, and the
 * workspace decides.
 */
export function stagedProfile(session: string, profiles: readonly string[], picked?: { session: string; profile?: string }): string | undefined {
  if (profiles.length < 2) return undefined;
  const named = splitCategory(session)?.category.toLowerCase();
  if (named && profiles.includes(named)) return named;
  if (picked?.profile && picked.session === session && profiles.includes(picked.profile)) return picked.profile;
  return profiles[0];
}

/** Where a new agent goes when nothing is picked: a workspace, a folder, and the profile a new Claude takes. */
export interface Near {
  session: string;
  folder: string;
  profile?: string;
}

/**
 * Where an agent added to a chat starts, unless you pick one to start beside:
 * beside the agent you are talking to (the one the message box offers), else
 * the chat's first agent still in it, in the workspace its tab is in now.
 */
export function nearAgent(chat: Chat, sessions: readonly SessionInfo[]): Near | null {
  const agents = chat.members.filter((m) => m.kind !== "user" && !m.left && m.windowId);
  const p = prefill(chat);
  const m = agents.find((x) => x.handle === p) ?? agents[0];
  if (!m) return null;
  const at = sessions.find((s) => s.windows.some((w) => w.id === m.windowId));
  const session = at?.name ?? m.session;
  if (!session) return null;
  const folder = at?.windows.find((w) => w.id === m.windowId)?.agent?.checkout ?? m.folder ?? "";
  return { session, folder, ...(m.kind === "claude" && m.profile ? { profile: m.profile } : {}) };
}

/** A new agent staged in the picker, to start when you press the button. */
export interface StagedAgent {
  kind: "claude" | "codex";
  session: string;
  /** Empty for the workspace's own folder. */
  folder: string;
  profile?: string;
  role: string;
}

/**
 * What Retry stages again: the same kind, role and profile, in its workspace
 * while that still exists (else `fallback`), and its folder only when what
 * was typed was a path: anything else is why it failed.
 */
export function retryStaged(m: ChatMember, sessions: readonly SessionInfo[], fallback: string): StagedAgent {
  const session = m.session && sessions.some((s) => s.name === m.session) ? m.session : fallback;
  const folder = m.folder && /^(\/|~(\/|$))/.test(m.folder) ? m.folder : stagedFolder(session);
  return { kind: m.kind === "codex" ? "codex" : "claude", session, folder, ...(m.profile ? { profile: m.profile } : {}), role: m.role ?? "" };
}

/** Whom Delete can shut down: whoever's terminal can open (running now, or still starting), less those also in another open chat. */
export function shutdownList(chat: Chat, chats: readonly ChatSummary[], agents: Record<string, ChatMemberLive>): { down: string[]; kept: string[] } {
  const elsewhere = new Set(chats.filter((c) => c.id !== chat.id && !c.archived).flatMap((c) => c.windows));
  const down: string[] = [];
  const kept: string[] = [];
  for (const m of chat.members) {
    if (m.kind === "user" || !canOpen(m, agents[m.handle])) continue;
    (elsewhere.has(m.windowId!) ? kept : down).push(m.handle);
  }
  return { down, kept };
}

/** Every folder an agent works in, once: what the folder field offers. */
export function knownFolders(sessions: readonly SessionInfo[]): string[] {
  return [...new Set(sessions.flatMap((s) => s.windows.flatMap((w) => (w.agent?.checkout ? [w.agent.checkout] : []))))];
}

/**
 * Every agent tab, grouped by workspace, for the New chat picker. A tab
 * running codex with no stamp is listed too: muxnexus decides on Create
 * whether it can join.
 */
export function pickerGroups(sessions: readonly SessionInfo[], inChat: ReadonlySet<string>): { session: string; agents: PickerAgent[] }[] {
  const groups: { session: string; agents: PickerAgent[] }[] = [];
  for (const s of sessions) {
    const agents: PickerAgent[] = [];
    for (const w of s.windows) {
      if (inChat.has(w.id)) continue;
      const codexName = /(^|\/)codex$/i.test(w.name);
      if (!w.agent && !codexName) continue;
      const kind = w.agent?.profile === "codex" || (!w.agent && codexName) ? "codex" : "claude";
      agents.push({
        windowId: w.id,
        session: s.name,
        name: w.customName ?? w.label ?? w.name,
        kind,
        ...(w.agent?.profile ? { profile: w.agent.profile } : {}),
        ...(w.agent?.checkout ? { folder: w.agent.checkout } : {}),
        waiting: !w.agent,
      });
    }
    if (agents.length) groups.push({ session: s.customName ?? s.label ?? s.name, agents });
  }
  return groups;
}
