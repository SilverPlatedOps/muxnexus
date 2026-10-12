import type { NewWindowAgent, SessionInfo } from "../shared/protocol";
import type { WindowRef } from "./world";

/**
 * Everything a view can ask muxnexus to do, by ids. The app implements it with
 * the same functions the sidebar and tabs use, so a view never grows its own
 * way of opening a window.
 */
export interface WorldActions {
  /** Attach its session and show the window -- in the terminal, so a view steps aside. */
  openWindow(ref: WindowRef): void;
  /** Open the window, then its note. */
  openNote(ref: WindowRef): void;
  /** Show the window beside the current one; refused on a phone, and for another session's window. */
  openBeside(ref: WindowRef): void;
  /** What ⌘J would go to. */
  nextWaiting(): WindowRef | null;
  setFolded(groupKey: string, folded: boolean): void;
  newSession(name: string): void;
  renameSession(ref: { session: string }, name: string): void;
  killSession(ref: { session: string }): void;
  newWindow(ref: { session: string }, agent?: NewWindowAgent): void;
  renameWindow(ref: WindowRef, name: string): void;
  killWindow(ref: WindowRef): void;
  moveWindowTo(ref: WindowRef, profile: string): void;
}

/** The tmux name a session goes by now. Refs carry ids, so a rename since the world was built is still found. */
export function sessionName(sessions: readonly SessionInfo[], id: string): string | null {
  return sessions.find((s) => s.id === id)?.name ?? null;
}
