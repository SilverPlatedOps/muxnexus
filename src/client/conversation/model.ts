// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { SessionInfo, WindowInfo } from "../../shared/protocol";

/**
 * The tab the conversation view shows for a workspace: the one asked for if it
 * still exists, else one waiting on the user, else the one tmux has active (the
 * desk's choice, only read), else the first.
 */
export function conversationWindow(windows: readonly WindowInfo[], wanted: string | null): string | null {
  if (wanted && windows.some((w) => w.id === wanted)) return wanted;
  return (windows.find((w) => w.agent?.state === "input") ?? windows.find((w) => w.active) ?? windows[0])?.id ?? null;
}

/**
 * The sessions with `windowId` marked active in `session` instead of tmux's own
 * choice: a phone picking a tab must not move the desk's, so the tab strip
 * follows the page's pick while tmux's stays as the desk left it.
 */
export function withLocalActive(sessions: SessionInfo[], session: string | null, windowId: string | null): SessionInfo[] {
  if (!session || !windowId) return sessions;
  return sessions.map((s) => (s.name === session ? { ...s, windows: s.windows.map((w) => ({ ...w, active: w.id === windowId })) } : s));
}

/** The messages that attach a terminal, size it or type into it: a conversation page sends none of them. */
export const TERMINAL_MESSAGES: ReadonlySet<string> = new Set(["attach", "attach-view", "select-window", "resize", "scroll"]);
