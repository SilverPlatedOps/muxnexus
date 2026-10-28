import type { Chat } from "../../shared/chat";
import type { ChatMemberLive } from "../../shared/protocol";

/** A hook's running state includes reasoning and tools; it does not prove typing. */
export function workingMembers(chat: Pick<Chat, "members"> | null, agents: Readonly<Record<string, ChatMemberLive>>): string[] {
  return chat?.members
    .filter((m) => m.kind !== "user" && !m.left && agents[m.handle]?.online && !agents[m.handle]?.replaced && agents[m.handle]?.state === "running")
    .map((m) => m.handle) ?? [];
}

export function activityLabel(handles: readonly string[]): string {
  if (!handles.length) return "";
  const names = handles.length === 1 ? handles[0]!
    : handles.length === 2 ? handles.join(" and ")
    : `${handles.slice(0, -1).join(", ")} and ${handles.at(-1)}`;
  return `${names} ${handles.length === 1 ? "is" : "are"} working`;
}

/** Status stays outside the transcript: no synthetic message or scroll jump. */
export function createChatActivity() {
  const el = document.createElement("div");
  el.className = "chat-activity";
  el.hidden = true;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "true");
  el.title = "Agent activity reported by its session; may include thinking or running tools.";
  const dots = document.createElement("span");
  dots.className = "chat-activity-dots";
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.append(document.createElement("i"));
  const label = document.createElement("span");
  label.className = "chat-activity-label";
  el.append(dots, label);
  let previous = "";

  return {
    el,
    update(chat: Pick<Chat, "members"> | null, agents: Readonly<Record<string, ChatMemberLive>>) {
      const text = activityLabel(workingMembers(chat, agents));
      // Polls with the same activity must not restart animation or repeat announcements.
      if (text === previous) return;
      previous = text;
      label.textContent = text;
      el.hidden = !text;
    },
  };
}
