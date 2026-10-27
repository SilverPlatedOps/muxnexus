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

/** What a member's row says, and the one action that puts it right. */
export function memberStatus(chat: Chat, m: ChatMember, live: ChatMemberLive | undefined): MemberStatus {
  if (m.spawn === "failed") return { text: `didn't start: ${m.spawnError ?? "unknown"}`, fix: "retry", alarm: true };
  if (m.spawn === "pending") return { text: "starting…" };
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
