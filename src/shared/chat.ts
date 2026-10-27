/**
 * A group chat between agents and the user. The server keeps these; the
 * client renders them. Nothing here depends on an agent kind beyond its name:
 * a new kind is an adapter on the server, not a change to this shape.
 */

export type AgentKind = "claude" | "codex";

/**
 * What became of a message for one recipient. "queued" with reason "sent" is
 * in flight: handed to the agent's runtime, its receipt not yet seen.
 */
export type DeliveryState = "queued" | "held" | "delivered" | "failed" | "cancelled";

export interface Delivery {
  state: DeliveryState;
  reason?: string;
  at: string;
  /**
   * In flight: the header line that proves the agent has it, and where its
   * transcript stood when it went, so a rename or an older line can't stand in.
   */
  probe?: { tag: string; path?: string; offset: number };
}

export interface ChatMember {
  /** `claude1`, `codex2`, or `user`. Never reused within a chat. */
  handle: string;
  kind: AgentKind | "user";
  /** Its mark in the conversation; `›` for the user. */
  shape: string;
  /** Index into the member colours; -1 for the user. */
  colour: number;
  role?: string;
  /** The tmux window the agent runs in, the tmux session it was in when added. */
  windowId?: string;
  session?: string;
  paneId?: string;
  /** The Claude profile (`personal`, `work`) or `codex`. */
  profile?: string;
  folder?: string;
  /** The Claude session id or Codex thread id it holds. */
  agentId?: string;
  /**
   * The agent process and the tmux server it ran under when it joined. A window
   * id is reused after tmux restarts and a tab can start another agent: neither
   * may receive this member's messages or post as it.
   */
  pid?: number;
  server?: string;
  /** The newest message this member has seen: one it sent, or one delivered to it. */
  lastSeq?: number;
  /** The join message has gone out with a delivery. */
  welcomed?: boolean;
  /** A message the chat woke it with, delivered and not yet answered by a post of its own. */
  awaiting?: number;
  /** Its turn was seen running since `awaiting` was delivered. */
  sawRunning?: boolean;
  /** Where and when the message it is `awaiting` went: what it said there shows if it never posts. */
  wake?: { path: string; from?: number; tag: string; sent: string };
  /** Its posts whose turns haven't ended: then what it said in its tab goes under the last post of each turn. */
  turns?: { msgId: number; path: string; at: number; since: string }[];
  left?: boolean;
  /** An agent started from the chat, before its tab came up, or after it failed to. */
  spawn?: "pending" | "failed";
  spawnError?: string;
  joinedAt: string;
}

export interface ChatMessage {
  id: number;
  /** A member's handle. */
  from: string;
  text: string;
  at: string;
  /** Handles it mentions, in order. */
  to: string[];
  /** A line the room writes itself: joins, leaves, stops. Delivers nothing. */
  system?: boolean;
  /**
   * What the agent said in its own tab in the turn that made this line, when
   * that adds to the line: so the user can see whether a post holds all it
   * concluded. For the user's eyes only, never delivered to an agent.
   */
  tabText?: string;
  /** One per agent recipient. */
  deliveries: Record<string, Delivery>;
}

export interface ChatPause {
  reason: "cap" | "stop";
  detail?: string;
  by?: string;
}

export interface Chat {
  id: string;
  name: string;
  createdAt: string;
  /** Agent posts in a row, with no message from the user, before the chat pauses. */
  cap: number;
  archived?: boolean;
  members: ChatMember[];
  messages: ChatMessage[];
  nextId: number;
  /** Agent posts since the user last wrote. */
  agentRun: number;
  paused?: ChatPause;
  /** The agent the user's message box pre-fills. */
  lastSpokeToUser?: string;
}

/** What a sidebar row says about a chat. */
export type ChatGlyph = "input" | "running" | "unread" | "seen" | "paused";

export interface ChatSummary {
  id: string;
  name: string;
  archived: boolean;
  glyph: ChatGlyph;
  /** Agents still in it. */
  members: number;
  /** The tabs of those agents, so a tab can say which chats it is in. */
  windows: string[];
}

/** Handed out in order, so two agents of one kind still look different. */
export const SHAPES = ["◆", "▲", "■", "◇", "△", "□"] as const;

/**
 * One lightness and chroma, hues kept clear of red (needs you), yellow
 * (hazard), blue (links and focus) and the three account hues.
 */
export const MEMBER_COLOURS = [
  "oklch(82% .11 155)",
  "oklch(82% .10 345)",
  "oklch(85% .11 115)",
  "oklch(80% .07 215)",
  "oklch(82% .10 280)",
  "oklch(84% .08 190)",
] as const;

/** `@name` not glued to a word, an address or a path before it. */
const MENTION = /(?<![\w@.\/])@([A-Za-z][A-Za-z0-9_-]*)/g;

/**
 * The handles a line mentions, in order and once each. A bare kind (`@codex`)
 * names the one active member of that kind, and nobody when there are two.
 * Shared: the server decides who is woken, and the message box shows the same.
 */
export function resolveMentions(chat: Pick<Chat, "members">, text: string): { to: string[]; unknown: string[] } {
  const to: string[] = [];
  const unknown: string[] = [];
  const live = chat.members.filter((m) => m.kind !== "user" && !m.left);
  for (const match of text.matchAll(MENTION)) {
    const name = match[1]!.toLowerCase();
    let handle: string | undefined;
    if (name === "user") handle = "user";
    else handle = live.find((m) => m.handle.toLowerCase() === name)?.handle;
    if (!handle) {
      const ofKind = live.filter((m) => m.kind === name);
      if (ofKind.length === 1) handle = ofKind[0]!.handle;
    }
    if (handle) {
      if (!to.includes(handle)) to.push(handle);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return { to, unknown };
}

/** A line split into plain text and the mentions in it, for drawing. */
export function mentionParts(text: string): { text: string; mention?: true }[] {
  const out: { text: string; mention?: true }[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], mention: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
