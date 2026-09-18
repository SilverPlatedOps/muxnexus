export interface WindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: number;
}

export interface SessionInfo {
  name: string;
  /** Number of clients currently attached (cmux, other browsers, ...). */
  attached: number;
  windows: WindowInfo[];
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
  | { t: "ping" };

export type DetachReason = "session-killed" | "exited";

export type ServerMessage =
  | { t: "state"; sessions: SessionInfo[] }
  | { t: "attached"; session: string }
  | { t: "detached"; reason: DetachReason }
  | { t: "error"; message: string };
