import type { AgentKind, Chat, ChatSummary } from "./chat";

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
   * The conversation this window's was forked from by a move (`@muxnexus_from`),
   * so a view can tell the tab it continues. Absent for a window never moved.
   */
  forkedFrom?: string;
  /**
   * The window rang the bell and nobody has looked since. tmux's own flag, so
   * it survives cmux being closed and costs nothing to read.
   */
  unread?: boolean;
  /** The window's note (`@muxnexus_note`), once one has been opened for it. */
  noteId?: string;
  /** Its note holds nothing yet, so the tab wears no mark. */
  noteEmpty?: boolean;
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

/**
 * Where a window's state came from. `hook` is the stamp itself; the other two
 * are the server overriding it: `transcript` found an Esc interruption the hook
 * never hears about, `quiet` read a `running` stamp on a window that stopped
 * redrawing as idle.
 */
export type AgentSource = "hook" | "transcript" | "quiet";

/** Where a turn's or a wait's start came from: the hook's own mark, or the server's first sight of it. */
export type BoundarySource = "hook" | "first-seen";

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
  /** How the state was known; absent from servers older than the field. */
  source?: AgentSource;
  /** When the current turn began -- or, while idle, the last one. */
  turnStartedAt?: string;
  /** Only while idle, when the hook saw the turn end: with the start, how long it took. */
  turnEndedAt?: string;
  turnSource?: BoundarySource;
  /** Only while waiting: when this wait began, which tool calls never move. */
  waitingSince?: string;
  waitSource?: BoundarySource;
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
  /**
   * Whose quota this is. Only a `claude` row is somewhere a conversation can be
   * moved to; `codex` is an account agents spend too, so its tabs wear a badge.
   */
  provider: "claude" | "codex";
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
  /**
   * The wheel, over a program that did not ask for the mouse: scroll the
   * attached pane's history this many lines (negative is up). Sent instead of
   * the arrow keys the browser terminal would otherwise type.
   */
  | { t: "scroll"; lines: number }
  | { t: "new-session"; name: string }
  | { t: "kill-session"; session: string }
  /** `agent` starts one in the new window; the server holds the command, so none crosses the wire. */
  | { t: "new-window"; session: string; agent?: NewWindowAgent }
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
  /** Open window `id`'s note, giving it one if it has none; answered with `note`. */
  | { t: "note-open"; session: string; id: string }
  | { t: "note-save"; noteId: string; text: string }
  /** Every note with anything in it, for the explorer; answered with `notes`. */
  | { t: "notes-list" }
  | { t: "note-delete"; noteId: string }
  /**
   * Whether this browser shows the system overview: answered with `system` every
   * couple of seconds while on. `list` says whether its app list is in view;
   * absent, as from a page loaded before it existed, it counts as in view.
   */
  | { t: "system"; on: boolean; list?: boolean }
  /** Whether this browser shows memory on its tabs: answered with `memory` while on. */
  | { t: "memory"; on: boolean }
  /** The user saw the urgent nudge for this episode. */
  | { t: "swap-ack"; episode: number }
  /** Whether this browser shows the overview's Docker tab: answered with `docker` every few seconds while on. */
  | { t: "docker"; on: boolean }
  /** Whether this browser wants the chat list: answered with `chats` now and on every change. */
  | { t: "chats"; on: boolean }
  /** The chat this browser shows, or none: answered with `chat` now and on every change. */
  | { t: "chat-open"; id: string | null }
  | { t: "chat-create"; name?: string; members: ChatJoin[]; spawn?: ChatSpawn[] }
  | { t: "chat-post"; id: string; text: string }
  | { t: "chat-add"; id: string; members: ChatJoin[]; spawn?: ChatSpawn[] }
  | { t: "chat-remove"; id: string; handle: string }
  | { t: "chat-role"; id: string; handle: string; role: string }
  | { t: "chat-settings"; id: string; name?: string; cap?: number }
  | { t: "chat-archive"; id: string; archived: boolean }
  | { t: "chat-discard-held"; id: string }
  /** Point a member whose tab closed at the tab its conversation was resumed in. */
  | { t: "chat-reconnect"; id: string; handle: string; windowId?: string }
  | { t: "ping" };

/** An agent already running in a tab, joining a chat. */
export interface ChatJoin {
  windowId: string;
  role?: string;
}

/** A new agent a chat starts: a tab opened in `session`, in `folder`. */
export interface ChatSpawn {
  kind: AgentKind;
  folder: string;
  session: string;
  role?: string;
  /** A Claude profile as the quota panel names it (`personal`, `work`); absent, the session's own. */
  profile?: string;
}

/** What the chat view shows about a member beyond the chat itself. */
export interface ChatMemberLive {
  state?: AgentState;
  online: boolean;
  /** A Codex tab in the shared daemon: a chat can't reach it. */
  daemon?: boolean;
  /** Its tab now runs another agent than the one that joined. */
  replaced?: boolean;
  session?: string;
}

/** A note as the explorer lists it. */
export interface NoteSummary {
  noteId: string;
  /** Named after where it lives: the window's current names while it lives, the last ones it was saved under after. */
  session: string;
  window: string;
  text: string;
  updated: string;
  /** The window wearing it, while there is one. */
  live?: { session: string; windowId: string };
}

/** One app in the system overview: every process inside its `.app`, summed. */
export interface SystemApp {
  name: string;
  /** Share of the whole machine, 0-100, like `SystemStats.cpu`. */
  cpu: number;
  /** Bytes, counted as the reading's `metric` says: footprint, else resident memory. */
  mem: number;
  procs: number;
  /** The executable of its busiest process. */
  top: string;
  /** None of its processes could be read (another user's), so `mem` is 0 and means nothing. */
  unreadable?: boolean;
}

/**
 * How a reading counted memory: "footprint" as Activity Monitor does,
 * compressed and swapped memory included; "rss" only what is resident, when
 * footprints could not be read. A reading never mixes the two.
 */
export type MemoryMetric = "footprint" | "rss";

/** Some of a tab's processes, by name: "claude", "java · maven tests". */
export interface ProcessPart {
  name: string;
  /** Null when none of them could be read. */
  bytes: number | null;
  cpu: number;
}

/**
 * One tmux window's processes -- each pane's shell and everything under it --
 * summed. `unreadable` of its `processes` could not be read and count as
 * nothing, so `bytes` is a floor whenever that is above zero.
 */
export interface WindowMemory {
  windowId: string;
  bytes: number;
  processes: number;
  unreadable: number;
  cpu: number;
  parts: ProcessPart[];
}

/**
 * Memory in four parts that add up to `total`, in bytes: what apps hold, what
 * the kernel keeps wired, what the compressor holds, and the rest -- free pages
 * and file cache macOS can take back, the room before it compresses or swaps.
 */
export interface MemSplit {
  apps: number;
  system: number;
  compressed: number;
  available: number;
  total: number;
}

/**
 * How much the Mac is swapping, as the server judges it: calm, busy (worth a
 * yellow line), urgent (worth the whole page), and recovered -- the green line
 * that says closing things was enough, for a while after it was.
 */
export type SwapSeverity = "calm" | "busy" | "urgent" | "recovered";
/** What made it so: swap writes to the SSD, the kernel's memory pressure, or both. */
export type SwapReason = "writes" | "pressure" | "both";
/** One swap-write rate in bytes a second, at the sample that measured it; null when the delta could not be trusted. */
export interface RatePoint {
  at: number;
  rate: number | null;
}

/** The machine at a glance. A reading that could not be taken is left out. */
export interface SystemStats {
  /** Busy share of every core, 0-100; absent on the first reading, which has nothing to compare against. */
  cpu?: number;
  load: [number, number, number];
  /** Bytes, and the kernel's memory pressure when it could be read. */
  mem?: { used: number; total: number; pressure?: "normal" | "warning" | "critical" };
  swap?: { used: number; total: number };
  /**
   * The busiest few by CPU and the largest few by memory, in no order, with the
   * processes inside tmux windows taken out (they are in `windows`). Empty for a
   * client that has the list hidden: the process list is read only to be shown.
   */
  apps: SystemApp[];
  /** Every process's CPU summed, on `cpu`'s scale: the rest of `cpu` is the kernel's. */
  appsCpu?: number;
  /** The Mem bar's four parts. */
  split?: MemSplit;
  /** How `apps` and `windows` counted memory. */
  metric?: MemoryMetric;
  /** Every tmux window's processes, for the list to rank beside the apps. */
  windows?: WindowMemory[];
  /** The tmux server `windows` were read from, as `state` names it; ids mean nothing under another. */
  tmuxServer?: string;
  /** Swap-write rates over the last five minutes, oldest first. */
  history?: RatePoint[];
  /** The latest swap-write rate, bytes a second, or null when unknown. */
  rate?: number | null;
  /** Bytes written to swap since boot. */
  written?: number | null;
  /** When the Mac booted, ms. */
  bootTime?: number | null;
}

/** One of the biggest holders named by an urgent notice: an app by name, or a tab by window id. */
export interface SwapHolder {
  kind: "app" | "tab";
  name: string;
  bytes: number;
}

/**
 * The swap level, pushed to every client: the collapsed overview, the nudge
 * and the page title need it whether or not the panel is open.
 */
export interface SwapNotice {
  /** When the current episode began, ms; the id an acknowledgement names. 0 before any. */
  episode: number;
  severity: SwapSeverity;
  reason: SwapReason | null;
  rate: number | null;
  /** Bytes of swap on disk. */
  swapUsed: number | null;
  written: number | null;
  bootTime: number | null;
  /** Biggest first; filled while urgent. */
  holders: SwapHolder[];
  acked: boolean;
  /** The sample's time, by the server's clock. */
  at: number;
}

/** One container, running or not. */
export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  /** As `docker ps` words them: `state` "running", "exited", "paused"...; `status` "Up 34 hours". */
  state: string;
  status: string;
  /** The compose project and service that started it; absent for a container started by hand. */
  project?: string;
  service?: string;
  /**
   * Running containers only: CPU as a share of the engine's machine, 0-100 (its
   * VM on this Mac, or another computer), absent when its cores are not known;
   * and bytes in use.
   */
  cpu?: number;
  mem?: number;
}

/**
 * The Docker tab's reading. `engine` says why the list is empty when it is:
 * "down" is a CLI with no engine answering it, "slow" an engine that did not
 * answer in time, "missing" no `docker` on the PATH at all.
 */
export interface DockerStats {
  engine: "up" | "down" | "slow" | "missing";
  containers: DockerContainer[];
  /**
   * The memory the engine has, in bytes, as `docker info` gives it: its VM's
   * on this Mac, or the whole machine's for an engine on another one.
   */
  vmMem?: number;
  /** The docker context read through, as `docker context show` names it; absent when it could not be read. */
  context?: string;
}

/** Agents a new window can start with. */
export type NewWindowAgent = "codex";

export type DetachReason = "session-killed" | "exited";

export type ServerMessage =
  /**
   * `tmuxServer` is `<pid>-<start time>` of the tmux server read: tmux hands its
   * `$N` and `@N` ids out again after a restart, and this is how a client knows
   * the ids it holds mean nothing any more.
   */
  | { t: "state"; sessions: SessionInfo[]; tmuxServer?: string }
  /** Quota, on its own cadence: folding it into `state` would tie it to the session poll. */
  | { t: "usage"; sources: UsageSource[] }
  /** Only to a client that asked with `system`, and only while it keeps asking. */
  | { t: "system"; stats: SystemStats }
  /** Likewise, to a client that asked with `docker`. */
  | { t: "docker"; stats: DockerStats }
  /** To every client, on connect and whenever it says something new. */
  | { t: "swap"; notice: SwapNotice }
  /** To a client that asked with `memory`: every window's memory, for the tab chips. */
  | { t: "memory"; tmuxServer: string | null; at: number; metric: MemoryMetric; windows: WindowMemory[] }
  | { t: "attached"; session: string }
  /**
   * The attached session now has this name -- renamed here, in cmux, or with
   * `C-b $`. The terminal is unchanged; only the name to address it by moved.
   * Sent before the `state` that carries the new name.
   */
  | { t: "renamed"; session: string }
  | { t: "detached"; reason: DetachReason }
  /**
   * A note's text: the answer to `note-open` (with the window it was asked for),
   * or another client's save of it.
   */
  | { t: "note"; noteId: string; text: string; updated: string; windowId?: string }
  | { t: "notes"; notes: NoteSummary[] }
  /** A note is gone: any pane showing it starts its window's note afresh. */
  | { t: "note-deleted"; noteId: string }
  /**
   * Something worth saying that is not a failure -- today, that a snapshot from
   * a previous tmux server is still waiting to be restored. Sent as a client
   * connects, so it reaches a phone that was not open when the laptop rebooted.
   */
  | { t: "notice"; message: string }
  | { t: "chats"; chats: ChatSummary[] }
  | { t: "chat"; chat: Chat; agents: Record<string, ChatMemberLive> }
  /** Sent to the browser that created a chat, so it can open it. */
  | { t: "chat-created"; id: string }
  | { t: "error"; message: string };
