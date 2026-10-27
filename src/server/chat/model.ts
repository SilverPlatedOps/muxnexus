import { resolveMentions, SHAPES, type AgentKind, type Chat, type ChatMember, type ChatMessage, type ChatSummary } from "../../shared/chat";

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
export function post(chat: Chat, from: string, text: string, now: string, opts: { system?: boolean } = {}): ChatMessage {
  const system = opts.system === true;
  const to = system ? [] : resolveMentions(chat, text).to;
  if (!system) {
    if (from === "user") {
      chat.agentRun = 0;
      if (chat.paused) {
        delete chat.paused;
        setPending(chat, "held", "queued", now);
      }
    } else {
      chat.agentRun++;
      if (!chat.paused && chat.cap > 0 && chat.agentRun >= chat.cap) {
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
    deliveries[handle] = { state: chat.paused ? "held" : "queued", at: now };
  }
  const msg: ChatMessage = { id: chat.nextId++, from, text, at: now, to, ...(system ? { system: true } : {}), deliveries };
  chat.messages.push(msg);
  const sender = chat.members.find((m) => m.handle === from);
  if (sender && !system) sender.lastSeq = msg.id;
  return msg;
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
}

/** Drops every held message; the pause stays until the user writes. */
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
  const unseen = chat.messages.filter((m) => m.id > seen && m.id < uptoId && m.from !== handle && !m.system);
  const lines = unseen.slice(-cap);
  const first = lines[0]?.id ?? uptoId;
  const older = chat.messages.filter((m) => m.id < first).length;
  return { lines, older };
}

/** Whether an agent's newest mention of the user came after the user's newest line. */
function asksUser(chat: Chat): boolean {
  let lastUser = 0;
  let lastAsk = 0;
  for (const m of chat.messages) {
    if (m.system) continue;
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
