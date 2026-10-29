// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { resolveMentions, SHAPES, type AgentKind, type Chat, type ChatMember, type ChatMessage, type ChatMode, type ChatSummary } from "../../shared/chat";

export { resolveMentions };

/**
 * The room's rules, with no I/O: who is in a chat, whom a line wakes, and when
 * the agents have talked long enough without the user. The service around it
 * reads and writes the store and drives delivery; everything decided here is
 * testable on a plain object.
 */

export const DEFAULT_CAP = 3;
/** How many missed lines ride along with a mention before `mux read` takes over. */
export const DEFAULT_CATCHUP = 5;

export function newChat(id: string, name: string, now: string, cap: number = DEFAULT_CAP): Chat {
  return {
    id,
    name,
    createdAt: now,
    cap,
    members: [{ handle: "user", kind: "user", shape: "›", colour: -1, joinedAt: now }],
    messages: [],
    nextId: 1,
    agentRun: 0,
  };
}

const agents = (chat: Chat) => chat.members.filter((m) => m.kind !== "user");
const active = (chat: Chat) => agents(chat).filter((m) => !m.left);

/**
 * Adds an agent. Its handle numbers every member of its kind the chat has ever
 * had, and its shape and colour every agent, so neither is handed out twice.
 */
export function addMember(
  chat: Chat,
  m: Omit<ChatMember, "handle" | "shape" | "colour" | "joinedAt" | "kind"> & { kind: AgentKind },
  now: string,
): ChatMember {
  const ever = agents(chat);
  const sameKind = ever.filter((x) => x.kind === m.kind).length;
  const member: ChatMember = {
    ...m,
    handle: `${m.kind}${sameKind + 1}`,
    shape: SHAPES[ever.length % SHAPES.length]!,
    colour: ever.length,
    joinedAt: now,
  };
  chat.members.push(member);
  return member;
}

function setPending(chat: Chat, from: "queued" | "held", to: "queued" | "held" | "cancelled", now: string, reason?: string): number {
  let n = 0;
  for (const msg of chat.messages) {
    for (const d of Object.values(msg.deliveries)) {
      // "queued" with reason "sent" is already in the agent's hands; holding
      // or cancelling it here would only make the panel lie.
      if (d.state !== from || d.reason === "sent") continue;
      d.state = to;
      d.at = now;
      if (reason) d.reason = reason;
      else delete d.reason;
      n++;
    }
  }
  return n;
}

/**
 * A line in the chat. The user's resets the count and lets held messages go;
 * an agent's counts toward the cap, and the one that reaches it is held along
 * with everything after it. Only mentioned agents still in the chat, never the
 * sender, get a delivery.
 */
/**
 * What a reply can point at: a message in this chat that isn't a room line.
 * A blind post can be answered only by its author until the round is revealed.
 */
export function replyTarget(chat: Chat, id: number, from: string): string | null {
  const parent = chat.messages.find((m) => m.id === id);
  if (!parent || parent.system || parent.auto) return `#${id} isn't a message in this chat.`;
  if (parent.blind && chat.round?.state === "open" && from !== "user" && parent.from !== from) return `#${id} isn't a message in this chat.`;
  return null;
}

export function post(chat: Chat, from: string, text: string, now: string, opts: { system?: boolean; handoff?: ChatMessage["handoff"]; to?: string[]; submit?: boolean; auto?: boolean; replyTo?: number } = {}): ChatMessage {
  const system = opts.system === true;
  const to = system ? [] : (opts.to ?? resolveMentions(chat, text).to);
  // In an open round an agent's post is held back from the other participants until the reveal.
  const round = chat.round?.state === "open" && !system && chat.round.participants.includes(from) ? chat.round : undefined;
  if (!system && !opts.auto) {
    if (from === "user") {
      chat.agentRun = 0;
      if (chat.paused) {
        delete chat.paused;
        setPending(chat, "held", "queued", now);
      }
    } else {
      // A blind post wakes nobody, so it can't be one side of a ping-pong the cap is for.
      if (!round) chat.agentRun++;
      if (!round && !chat.paused && chat.cap > 0 && chat.agentRun >= chat.cap) {
        // Nobody else is woken: what was still waiting waits for the user too.
        chat.paused = { reason: "cap" };
        setPending(chat, "queued", "held", now);
      }
      // Talking to the user, or to the room at large, is talking to the user.
      if (to.includes("user") || to.length === 0) chat.lastSpokeToUser = from;
    }
  }
  const deliveries: ChatMessage["deliveries"] = {};
  for (const handle of to) {
    if (handle === "user" || handle === from) continue;
    if (round) continue;
    deliveries[handle] = { state: chat.paused ? "held" : "queued", at: now };
  }
  const msg: ChatMessage = {
    id: chat.nextId++, from, text, at: now, to,
    ...(system ? { system: true } : {}),
    ...(opts.auto ? { auto: true as const } : {}),
    ...(round ? { blind: true as const } : {}),
    ...(opts.handoff ? { handoff: opts.handoff } : {}),
    ...(opts.replyTo !== undefined && !system ? { replyTo: opts.replyTo } : {}),
    deliveries,
  };
  chat.messages.push(msg);
  const sender = chat.members.find((m) => m.handle === from);
  if (sender && !system) sender.lastSeq = msg.id;
  // Only `mux submit` answers the round: any other post stays withheld but isn't counted.
  if (round && opts.submit) {
    if (!round.submitted.includes(from)) round.submitted.push(from);
    revealIfDone(chat, now);
  }
  return msg;
}

/** The agents a round waits on: those asked who are still in the chat. */
const pendingInRound = (chat: Chat) =>
  chat.round!.participants.filter((h) => !chat.round!.submitted.includes(h) && chat.members.some((m) => m.handle === h && !m.left));

function revealIfDone(chat: Chat, now: string): void {
  if (chat.round?.state === "open" && pendingInRound(chat).length === 0) reveal(chat, now);
}

/**
 * Ends the open round: every post held back goes to the other participants,
 * as it would have, and the room says so. False when no round is open.
 */
export function reveal(chat: Chat, now: string): boolean {
  const round = chat.round;
  if (round?.state !== "open") return false;
  round.state = "revealed";
  for (const msg of chat.messages) {
    if (!msg.blind) continue;
    delete msg.blind;
    // The other participants, who need the evidence to challenge it, and whoever the post named.
    for (const h of new Set([...round.participants, ...msg.to])) {
      if (h === "user") continue;
      const m = chat.members.find((x) => x.handle === h);
      if (h === msg.from || !m || m.left) continue;
      msg.deliveries[h] = { state: chat.paused ? "held" : "queued", at: now };
      if (!msg.to.includes(h)) msg.to.push(h);
    }
  }
  const silent = round.participants.filter((h) => !round.submitted.includes(h));
  // A kickoff that hasn't gone out would only tell a busy or offline agent about a round that's over.
  const kick = chat.messages.find((m) => m.id === round.kickoff);
  const told: string[] = [];
  for (const [h, d] of Object.entries(kick?.deliveries ?? {})) {
    if ((d.state === "queued" || d.state === "held") && d.reason !== "sent") {
      d.state = "cancelled";
      d.reason = "round ended";
      d.at = now;
    } else if (silent.includes(h) && chat.members.some((m) => m.handle === h && !m.left) && (d.state === "delivered" || d.reason === "sent")) {
      told.push(h);
    }
  }
  post(chat, "user", `round revealed${silent.length ? `; no post from ${silent.map((h) => `@${h}`).join(" ")}` : ""}`, now, { system: true });
  // Those already asked, who never answered: told it is over. It wakes them, which is the point.
  if (told.length) post(chat, "user", `${told.map((h) => `@${h}`).join(" ")} The round is over: you needn't submit. Your peers' answers, if any, follow; ordinary mux say posts are delivered again.`, now, { auto: true });
  return true;
}

/**
 * Starts a round: every agent still in the chat is asked, in one line from the
 * user, to post its own evidence. Null on success, else why not.
 */
export function startRound(chat: Chat, topic: string, now: string): string | null {
  if (chat.round?.state === "open") return "A round is already open: end it first.";
  const who = active(chat).map((m) => m.handle);
  if (who.length < 2) return "A blind round needs at least two agents in the chat.";
  const id = `r${chat.nextId}`;
  chat.round = { id, topic, participants: who, submitted: [], state: "open", startedAt: now };
  const kickoff = post(chat, "user", `${who.map((h) => `@${h}`).join(" ")} Independent round ${id}: ${topic}\nAnswer with exactly: mux submit --chat ${chat.id} ${id} "<your hypothesis and evidence>"\nOnly that counts as your answer; other mux say posts are held back from your peers too. Until every one of you has submitted, or the user ends the round, you won't be sent each other's posts and mux read hides them.`, now);
  chat.round.kickoff = kickoff.id;
  return null;
}

/** What the room is for: told to each agent with its next wake, waking nobody. */
export function setMode(chat: Chat, mode: ChatMode | undefined, now: string): void {
  if (chat.mode === mode) return;
  if (mode) chat.mode = mode;
  else delete chat.mode;
  post(chat, "user", mode ? `mode is now ${mode}` : "mode is now general", now, { system: true });
}

/** The user's brief: a new revision when the words change; empty clears it. */
export function setBrief(chat: Chat, text: string, now: string): boolean {
  const t = text.trim();
  if (t === (chat.brief?.text ?? "")) return false;
  chat.brief = { text: t, rev: (chat.brief?.rev ?? 0) + 1, at: now };
  post(chat, "user", t ? `brief updated (rev ${chat.brief.rev})` : "brief cleared", now, { system: true });
  return true;
}

/** An agent ends the exchange: nobody is woken until the user writes. */
export function stop(chat: Chat, by: string, reason: string, now: string): void {
  chat.paused = { reason: "stop", detail: reason, by };
  setPending(chat, "queued", "held", now);
  post(chat, by, `${by} stopped the exchange: ${reason}`, now, { system: true });
}

/** A member leaves, by its own `mux leave` or the user's Remove. Its tab is untouched. */
export function leave(chat: Chat, handle: string, now: string): void {
  const member = chat.members.find((m) => m.handle === handle);
  if (!member || member.left) return;
  member.left = true;
  for (const msg of chat.messages) {
    const d = msg.deliveries[handle];
    if (d && (d.state === "queued" || d.state === "held") && d.reason !== "sent") {
      d.state = "cancelled";
      d.reason = "left";
      d.at = now;
    }
  }
  post(chat, handle, `${handle} left`, now, { system: true });
  revealIfDone(chat, now);
}

/** Drops every held message; the pause stays until the user writes. */
/**
 * A new cap, 0 for none. A chat paused at the old one goes on when the new one
 * is no cap or isn't reached yet: what was held goes.
 */
export function setCap(chat: Chat, cap: number, now: string): void {
  chat.cap = cap;
  if (chat.paused?.reason === "cap" && (cap === 0 || chat.agentRun < cap)) {
    delete chat.paused;
    setPending(chat, "held", "queued", now);
  }
}

export function discardHeld(chat: Chat, now: string = new Date().toISOString()): number {
  return setPending(chat, "held", "cancelled", now, "discarded");
}

/**
 * What a member missed before message `uptoId`: the newest `cap` lines it has
 * not seen and did not write, and how many older lines `mux read` would show.
 */
export function missedFor(chat: Chat, handle: string, uptoId: number, cap: number = DEFAULT_CATCHUP): { lines: ChatMessage[]; older: number } {
  const seen = chat.members.find((m) => m.handle === handle)?.lastSeq ?? 0;
  // The room's own lines (joins, leaves) are in the join message and `mux who`.
  const unseen = chat.messages.filter((m) => m.id > seen && m.id < uptoId && m.from !== handle && !m.system && !m.blind);
  const lines = unseen.slice(-cap);
  const first = lines[0]?.id ?? uptoId;
  const older = chat.messages.filter((m) => m.id < first && !m.blind).length;
  return { lines, older };
}

/** Whether an agent's newest mention of the user came after the user's newest line. */
function asksUser(chat: Chat): boolean {
  let lastUser = 0;
  let lastAsk = 0;
  for (const m of chat.messages) {
    // The room's notices are nobody's word: not the human answering.
    if (m.system || m.auto) continue;
    if (m.from === "user") lastUser = m.id;
    else if (m.to.includes("user")) lastAsk = m.id;
  }
  return lastAsk > lastUser;
}

export function summary(chat: Chat, agentGlyph: (m: ChatMember) => string | undefined): ChatSummary {
  const live = active(chat);
  // A stop hands the chat to the user, like a question would; only the cap is a pause.
  const glyph = asksUser(chat) || chat.paused?.reason === "stop"
    ? "input"
    : chat.paused
      ? "paused"
      : live.some((m) => agentGlyph(m) === "running")
        ? "running"
        : "seen";
  return { id: chat.id, name: chat.name, archived: chat.archived === true, glyph, members: live.length, windows: live.flatMap((m) => (m.windowId ? [m.windowId] : [])) };
}
