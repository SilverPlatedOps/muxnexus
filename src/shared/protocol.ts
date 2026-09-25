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
   * The conversation this window holds, from `@muxnexus_session`. Deliberately
   * not part of `agent`: that stamp is cleared when the agent exits, and a tab
   * whose agent has quit is precisely the one worth carrying elsewhere. Absent
   * until a Claude Code SessionStart has run in the window.
   */
  conversation?: ConversationInfo;
  /**
   * The window rang the bell and nobody has looked since. tmux's own flag, so
   * it survives cmux being closed and costs nothing to read.
   */
  unread?: boolean;
}

/**
 * Which conversation a window holds, so it can be resumed under another account
 * without the user finding a uuid. The transcript path is what `claude --resume`
 * takes, and it is the config dir's own path -- resuming it from a different
 * profile is what carrying a task between accounts amounts to.
 */
export interface ConversationInfo {
  sessionId: string;
  transcriptPath: string;
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
  /**
   * The git checkout the agent is working in (the directory holding its `.git`,
   * a worktree counting as its own). Two agents in one checkout edit, commit and
   * switch branches under each other.
   */
  checkout?: string;
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
  /**
   * Attach this socket to one window of `session` through a private view: a
   * split pane's second terminal. tmux shows a session's current window, so the
   * view is its own session in the group and the main pane's window stays put.
   */
  | { t: "attach-view"; session: string; id: string }
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
  /**
   * Carry the window's conversation to another account: the server types a
   * resume into the window's own shell. `profile` names it as the quota panel
   * does (`personal`, `work`); the server resolves it to a config dir, so no
   * path crosses the wire.
   */
  | { t: "move-window-to"; session: string; id: string; profile: string }
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
