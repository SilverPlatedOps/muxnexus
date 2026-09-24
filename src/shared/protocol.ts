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
  /** The name the user gave it in muxnexus (`@muxnexus_window_name`); beats both `name` and `label`. */
  customName?: string;
  /**
   * What the agent in this window is doing, from `@muxnexus_agent` -- stamped by
   * a Claude Code hook and already checked against the two ways a stamp goes
   * stale. Absent when no agent has spoken in this window.
   */
  agent?: AgentInfo;
  /**
   * The window rang the bell and nobody has looked since. tmux's own flag, so
   * it survives cmux being closed and costs nothing to read.
   */
  unread?: boolean;
}

/** The three things a window can say about the agent running in it. */
export type AgentState = "input" | "running" | "done";

export interface AgentInfo {
  state: AgentState;
  /** When the window entered this state, so a row can say how long it has waited. */
  since: string;
  /**
   * The Claude profile the agent runs under, named as the quota panel names it
   * (`personal`, `work`). Absent for an agent stamped before the hook recorded it.
   */
  profile?: string;
}

export interface SessionInfo {
  /** tmux's name for the session. Identity: every command targets this. */
  name: string;
  /**
   * tmux's own session id (`$3`). Stable across renames, which is how the server
   * notices that the session a client is attached to now has another name.
   */
  id: string;
  /** Number of clients currently attached (cmux, other browsers, ...). */
  attached: number;
  windows: WindowInfo[];
  /** The cmux workspace this session belongs to, when the guard stamped one. */
  workspaceId?: string;
  /** What to show instead of `name`: the workspace's current title in cmux. */
  label?: string;
  /** The name the user gave it in muxnexus (`@muxnexus_name`); beats both `name` and `label`. */
  customName?: string;
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
  /** Windows by tmux id (`@3`), never index: an index is a slot windows move through. */
  | { t: "kill-window"; session: string; id: string }
  | { t: "select-window"; session: string; id: string }
  | { t: "rename-session"; session: string; name: string }
  | { t: "rename-window"; session: string; id: string; name: string }
  /** The whole wanted sidebar order, not one move: concurrent clients then settle on last-write-wins. */
  | { t: "reorder-sessions"; names: string[] }
  /** The whole wanted tab order, as window ids. */
  | { t: "reorder-windows"; session: string; ids: string[] }
  | { t: "ping" };

export type DetachReason = "session-killed" | "exited";

export type ServerMessage =
  | { t: "state"; sessions: SessionInfo[] }
  /** Quota, on its own cadence: folding it into `state` would tie it to the session poll. */
  | { t: "usage"; sources: UsageSource[] }
  | { t: "attached"; session: string }
  /**
   * The attached session now has this name -- renamed here, in cmux, or with
   * `C-b $`. The terminal is unchanged; only the name to address it by moved.
   * Sent before the `state` that carries the new name.
   */
  | { t: "renamed"; session: string }
  | { t: "detached"; reason: DetachReason }
  | { t: "error"; message: string };
