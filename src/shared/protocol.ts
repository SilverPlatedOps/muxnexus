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

/** One quota window of one account: a 5h session limit, a weekly limit, and so on. */
export interface UsageWindow {
  /** The provider's own name for the window (`session`, `weekly_all`, `rolling`, ...). */
  kind: string;
  percent: number;
  resetsAt?: string;
  /** The provider's own judgement (`normal`, `warning`, ...), which is what colours the bar. */
  severity?: string;
}

/**
 * Quota for one account. `windows` is whatever the provider reported -- the set
 * of kinds differs between accounts, so nothing here is looked up by a fixed
 * key. On a failure the last good `windows` are kept and `state` says so, which
 * is why a row can be both `error` and populated.
 */
export interface UsageSource {
  id: string;
  label: string;
  windows: UsageWindow[];
  state: "ok" | "signed-out" | "error";
  /** When the numbers were last read, not when they were last requested. */
  checkedAt: string;
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
  /** Quota, on its own cadence: folding it into `state` would tie it to the session poll. */
  | { t: "usage"; sources: UsageSource[] }
  | { t: "attached"; session: string }
  | { t: "detached"; reason: DetachReason }
  | { t: "error"; message: string };
