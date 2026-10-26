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
}

export interface Send {
  chatId: string;
  msgId: number;
  handle: string;
}

/**
 * Who gets what next, decided from the chats and nothing else.
 *
 * Claude's inbox reads a message between tool calls and never interrupts one,
 * so everything queued for a Claude goes at once. `codex queue` cannot take a
 * message back, so a Codex agent is handed one at a time -- oldest first,
 * across every chat it is in, and only once its turn has ended -- which keeps
 * the rest cancellable. An agent is its tab: two chats with the same window
 * share one queue.
 */
export function nextSends(chats: readonly Chat[], view: (chat: Chat, m: ChatMember) => AgentView): { send: Send[]; fail: (Send & { reason: string })[] } {
  const send: Send[] = [];
  const fail: (Send & { reason: string })[] = [];
  const pending: { chat: Chat; member: ChatMember; msgId: number; at: string }[] = [];
  const inFlight = new Set<string>();

  for (const chat of chats) {
    if (chat.archived) continue;
    for (const msg of chat.messages) {
      for (const [handle, d] of Object.entries(msg.deliveries)) {
        const member = chat.members.find((m) => m.handle === handle);
        if (!member?.windowId || member.left) continue;
        if (d.state === "queued" && d.reason === "sent") inFlight.add(member.windowId);
        else if (d.state === "queued") pending.push({ chat, member, msgId: msg.id, at: msg.at });
      }
    }
  }
  pending.sort((a, b) => a.at.localeCompare(b.at));

  const takenCodex = new Set<string>();
  for (const p of pending) {
    const v = view(p.chat, p.member);
    const item = { chatId: p.chat.id, msgId: p.msgId, handle: p.member.handle };
    if (!v.online) {
      fail.push({ ...item, reason: "offline" });
      continue;
    }
    if (v.kind === "codex") {
      if (v.daemon) {
        fail.push({ ...item, reason: "daemon" });
        continue;
      }
      const agent = p.member.windowId!;
      if (!v.idle || inFlight.has(agent) || takenCodex.has(agent)) continue;
      takenCodex.add(agent);
    }
    send.push(item);
  }
  return { send, fail };
}
