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
  /** The Claude session id or Codex thread id it held when added. */
  agentId?: string;
  /** The newest message this member has seen: one it sent, or one delivered to it. */
  lastSeq?: number;
  /** The join message has gone out with a delivery. */
  welcomed?: boolean;
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
