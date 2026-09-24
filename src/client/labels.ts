import type { SessionInfo, WindowInfo } from "../shared/protocol";

/** What a session is called on screen: the user's rename, else cmux's title, else tmux's name. */
export function sessionLabel(s: SessionInfo): string {
  return s.customName ?? s.label ?? s.name;
}

/** What a tab is called: the user's rename, else cmux's title, else tmux's window name. */
export function tabLabel(w: WindowInfo): string {
  return w.customName ?? w.label ?? w.name;
}

/** One window named from anywhere on the page: its session, then its tab. */
export function windowPlace(s: SessionInfo, w: WindowInfo): string {
  return `${sessionLabel(s)} › ${tabLabel(w)}`;
}
