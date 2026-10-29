import type { AgentKind, Chat, ChatMember } from "../../shared/chat";

/** What delivery needs to know about the agent behind a member, right now. */
export interface AgentView {
  kind: AgentKind;
  /** Its tab is open and its agent running. */
  online: boolean;
  /** Its turn has ended, or nobody can tell. Only Codex waits on it. */
  idle: boolean;
  /** A Codex tab whose hooks run in the shared daemon: `codex queue` cannot reach it. */
  daemon?: boolean;
  /** Out of usage credits: nothing goes to it, of either kind, until the limit lifts. */
  limited?: boolean;
}

export interface Send {
  chatId: string;
  msgId: number;
  handle: string;
  /** One bounded, chronological burst for this recipient; absent for a single message. */
  msgIds?: number[];
}

/**
 * Who gets what next, decided from the chats and nothing else.
 *
 * Adjacent queued messages for one room/recipient share a bounded packet.
 * Claude accepts packets between tool calls. Codex gets one packet at a time,
 * oldest first across its rooms, only when idle. In-flight packets cannot be
 * recalled; the rest remain cancellable. An agent is its tab: two rooms with
 * the same window share one queue.
 */
export function nextSends(
  chats: readonly Chat[],
  view: (chat: Chat, m: ChatMember) => AgentView,
): { send: Send[]; fail: (Send & { reason: string })[]; wait: (Send & { reason: string })[] } {
  const send: Send[] = [];
  const fail: (Send & { reason: string })[] = [];
  // Offline is a wait, not a failure: a tab that comes back, or a stamp that
  // lagged a moment, gets what was waiting for it.
  const wait: (Send & { reason: string })[] = [];
  const pending: { chat: Chat; member: ChatMember; msgId: number; at: string; bytes: number }[] = [];
  const inFlight = new Set<string>();

  for (const chat of chats) {
    if (chat.archived) continue;
    for (const msg of chat.messages) {
      for (const [handle, d] of Object.entries(msg.deliveries)) {
        const member = chat.members.find((m) => m.handle === handle);
        if (!member?.windowId || member.left) continue;
        if (d.state === "queued" && d.reason === "sent") inFlight.add(member.windowId);
        else if (d.state === "queued") pending.push({ chat, member, msgId: msg.id, at: msg.at, bytes: Buffer.byteLength(msg.text, "utf8") });
      }
    }
  }
  pending.sort((a, b) => a.at.localeCompare(b.at));

  const takenCodex = new Set<string>();
  const latest = new Map<string, { packet: Send; bytes: number; blocked?: boolean }>();
  for (const p of pending) {
    const v = view(p.chat, p.member);
    const item = { chatId: p.chat.id, msgId: p.msgId, handle: p.member.handle };
    if (!v.online) {
      wait.push({ ...item, reason: "offline" });
      continue;
    }
    // A Claude takes a packet mid-turn, so idle can't hold it back: being out of credits does.
    if (v.limited) continue;
    const window = p.member.windowId!;
    const prev = latest.get(window);
    // Only adjacent messages for the same room may share a packet. Another room keeps its place.
    if (prev?.packet.chatId !== p.chat.id && prev) prev.blocked = true;
    const append = prev && !prev.blocked && prev.packet.chatId === p.chat.id
      && (prev.packet.msgIds?.length ?? 1) < 20 && prev.bytes + p.bytes <= 48_000;
    if (v.kind === "codex") {
      if (v.daemon) {
        fail.push({ ...item, reason: "daemon" });
        continue;
      }
      const agent = p.member.windowId!;
      if (!v.idle || inFlight.has(agent)) continue;
      if (takenCodex.has(agent) && !append) { if (prev) prev.blocked = true; continue; }
      takenCodex.add(agent);
    }
    if (append) {
      (prev.packet.msgIds ??= [prev.packet.msgId]).push(p.msgId);
      prev.bytes += p.bytes;
    } else {
      send.push(item);
      latest.set(window, { packet: item, bytes: p.bytes });
    }
  }
  return { send, fail, wait };
}
