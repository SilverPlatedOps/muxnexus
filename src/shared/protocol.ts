export interface WindowInfo {
  /**
   * tmux's own window id (`@3`). Stable for the window's life, unlike `index`,
   * which is a *position*: `swap-window` moves windows between indices, so an
   * index identifies a slot and never the window sitting in it.
   */
  id: string;
  index: number;
  /** tmux's name for the window: the running command, so often the same for every tab. */
  name: string;
  active: boolean;
  panes: number;
  /** The cmux tab (surface) this window shows, when the guard stamped one. */
  surfaceId?: string;
  /** What to show instead of `name`: the cmux tab's own title. */
  label?: string;
}

export interface SessionInfo {
  /** tmux's name for the session. Identity: every command targets this. */
  name: string;
  /** Number of clients currently attached (cmux, other browsers, ...). */
  attached: number;
  windows: WindowInfo[];
  /** The cmux workspace this session belongs to, when the guard stamped one. */
  workspaceId?: string;
  /** What to show instead of `name`: the workspace's current title in cmux. */
  label?: string;
  /** The stamped workspace is gone from cmux, so nothing here is reachable there. */
  orphan?: boolean;
  /** Sidebar position (`@muxnexus_order`). Absent until muxnexus has been told where this goes. */
  order?: number;
}

export type ClientMessage =
  | { t: "attach"; session: string }
  | { t: "resize"; cols: number; rows: number }
  | { t: "new-session"; name: string }
  | { t: "kill-session"; session: string }
  | { t: "new-window"; session: string }
  | { t: "kill-window"; session: string; index: number }
  | { t: "select-window"; session: string; index: number }
  | { t: "rename-session"; session: string; name: string }
  | { t: "rename-window"; session: string; index: number; name: string }
  /** The whole wanted sidebar order, not one move: concurrent clients then settle on last-write-wins. */
  | { t: "reorder-sessions"; names: string[] }
  /** The whole wanted tab order, as window indices. */
  | { t: "reorder-windows"; session: string; indices: number[] }
  | { t: "ping" };

export type DetachReason = "session-killed" | "exited";

export type ServerMessage =
  | { t: "state"; sessions: SessionInfo[] }
  | { t: "attached"; session: string }
  | { t: "detached"; reason: DetachReason }
  | { t: "error"; message: string };
