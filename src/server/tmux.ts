import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { AgentState, ConversationInfo, SessionInfo } from "../shared/protocol";
import { profileLabel } from "./usage";

/**
 * The swaps that rearrange `positions` into `wanted`, as pairs of window
 * indices. tmux refuses `move-window` onto an occupied index ("index in use"),
 * so reordering is done with `swap-window`; selection sort reaches any order in
 * at most n-1 swaps and every intermediate state is a valid arrangement.
 *
 * `positions` are the live window indices, ascending; they may have gaps. Any
 * entry of `wanted` that no longer exists is skipped -- a window can be killed
 * between the browser sending an order and the server applying it.
 */
export function swapPlan(positions: readonly number[], wanted: readonly number[]): [number, number][] {
  const at = [...positions];
  const plan: [number, number][] = [];
  let k = 0;
  for (const target of wanted) {
    if (k >= at.length) break;
    const j = at.indexOf(target, k);
    if (j === -1) continue; // gone since the client last looked
    if (j !== k) {
      plan.push([positions[k], positions[j]]);
      [at[k], at[j]] = [at[j], at[k]];
    }
    k++;
  }
  return plan;
}

/**
 * Sidebar order: `@muxnexus_order` when muxnexus has been told where a session
 * goes, then everything else by name. tmux has no session ordering of its own --
 * `list-sessions` sorts by name -- so a session created outside muxnexus has no
 * stamp, and belongs at the end rather than interleaved by an unrelated name.
 */
export function orderSessions<T extends { name: string; order?: number }>(sessions: readonly T[]): T[] {
  const rank = (s: T) => (s.order === undefined ? Number.MAX_SAFE_INTEGER : s.order);
  return [...sessions].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if (a.order === undefined && b.order === undefined) return a.name.localeCompare(b.name);
    return 0; // equal stamps keep their incoming order
  });
}

/**
 * A window's `@muxnexus_agent` stamp: `"<state> <epoch> <pid> [<config dir>]"`,
 * written by the Claude Code hook. The config dir is the rest of the line, since
 * a path may hold spaces, and is absent from stamps written before it was added.
 * Anything else is no stamp at all rather than a guess -- the option is a string
 * tmux will hand back whatever is in it.
 */
export interface Stamp {
  state: AgentState;
  /** Unix seconds: when the pane entered this state. */
  since: number;
  /** The agent process, so a stamp outliving its process can be dropped. */
  pid: number;
  /** The agent's `CLAUDE_CONFIG_DIR`: which account, and so which quota, it spends. */
  configDir?: string;
}

export function parseStamp(raw: string): Stamp | null {
  const m = /^(\S+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/.exec(raw.trim());
  if (!m) return null;
  const [, state, since, pid, configDir] = m;
  if (state !== "input" && state !== "running" && state !== "done") return null;
  const at = Number(since);
  const process = Number(pid);
  if (!Number.isInteger(at) || !Number.isInteger(process) || process <= 0) return null;
  return { state, since: at, pid: process, ...(configDir ? { configDir } : {}) };
}

/**
 * A window's `@muxnexus_session` stamp: `"<session id> <transcript path>"`. The
 * path is the rest of the line, since it may hold spaces. Unlike the agent
 * stamp this one is never cleared, so it is parsed on its own and survives the
 * agent exiting -- which is the case the switcher exists for.
 */
export function parseSession(raw: string): ConversationInfo | null {
  const m = /^(\S+)\s+(.+)$/.exec(raw.trim());
  if (!m) return null;
  const [, sessionId, transcriptPath] = m;
  return { sessionId, transcriptPath };
}

/**
 * The transcript to resume a tab's conversation from.
 *
 * Normally the stamped one. But a fork's file is written on its first message,
 * not at startup, so a tab moved and then moved again before anyone typed in it
 * is stamped with a path that does not exist yet. `from` is the pane's record of
 * what its current fork was made from (`@muxnexus_from`, same shape as the
 * session stamp) and stands in -- only for the session it was recorded for, since
 * the pane may have held other conversations since.
 */
export function resolveTranscript(
  conversation: ConversationInfo,
  from: ConversationInfo | null,
  exists: (path: string) => boolean,
): string | null {
  if (exists(conversation.transcriptPath)) return conversation.transcriptPath;
  if (from?.sessionId === conversation.sessionId && exists(from.transcriptPath)) return from.transcriptPath;
  return null;
}

/**
 * POSIX single-quoting: everything is literal inside single quotes, and an
 * embedded quote closes, escapes and reopens. Transcript paths hold the project
 * directory's name, which on this machine is a path with its separators turned
 * into dashes -- but a quote or a space in a repo name would otherwise end the
 * argument early and resume the wrong thing.
 */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Attention first: a window wanting the human outranks one merely working. */
const RANK: Record<AgentState, number> = { input: 0, running: 1, done: 2 };

export function worstState(states: readonly AgentState[]): AgentState | undefined {
  let worst: AgentState | undefined;
  for (const s of states) if (worst === undefined || RANK[s] < RANK[worst]) worst = s;
  return worst;
}

/** A `running` stamp this long without the window redrawing is not running. */
export const STALE_SECONDS = 10;

/**
 * The state to believe, given a stamp and the window's last activity.
 *
 * Two known ways a stamp lies. A killed agent never fires `SessionEnd`, so its
 * stamp would sit there forever: a dead pid is no stamp. And `Stop` does not
 * fire when the user interrupts a turn, so `running` would stick: a running
 * Claude redraws several times a second, so a `running` window that has not
 * moved in STALE_SECONDS is reported as done. That guard is blind to a status
 * line with a `refreshInterval`, which redraws an idle pane for ever, and
 * `Notification[idle_prompt]` never follows an interrupt -- `interruptedAfter`
 * is the answer that holds.
 */
export function guardStamp(
  stamp: Stamp,
  activity: number,
  now: number,
  alive: (pid: number) => boolean,
): AgentState | null {
  if (!alive(stamp.pid)) return null;
  if (stamp.state === "running" && now - activity > STALE_SECONDS) return "done";
  return stamp.state;
}

/** How much of a transcript's end `interruptedAfter` is shown. */
export const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/**
 * Whether the conversation's last turn was interrupted after the stamp was
 * written, read from the end of its transcript.
 *
 * No hook fires for Esc, but Claude Code writes the fact down: a user line
 * `[Request interrupted by user]` (`... for tool use` when a tool was cut off
 * or a permission prompt refused). It counts only as the main thread's last
 * word -- a prompt typed since is a new turn -- and only if it is no older than
 * the stamp, so the `UserPromptSubmit` that starts the next turn wins even
 * before its prompt reaches the file. System lines written after it (a recap)
 * say nothing about the turn and are skipped.
 */
export function interruptedAfter(tail: string, since: number): boolean {
  const rows = tail.split("\n");
  // A line cut off where the tail began fails to parse, and is skipped like one
  // Claude Code was still writing.
  for (let i = rows.length - 1; i >= 0; i--) {
    let row: { type?: string; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(rows[i]);
    } catch {
      continue;
    }
    if ((row.type !== "user" && row.type !== "assistant") || row.isSidechain) continue;
    if (row.type === "assistant") return false;
    const content = row.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.find((c) => c?.type === "text")?.text : undefined;
    if (typeof text !== "string" || !text.startsWith("[Request interrupted by user")) return false;
    return Date.parse(row.timestamp ?? "") >= since * 1000;
  }
  return false;
}

/**
 * Whether a rung bell still means "nobody has looked".
 *
 * `links` is every winlink pointing at one window: the base session's and each
 * grouped tab session's. Reading only the base's flag is not enough, which the
 * live server showed while this was being built -- a bell sat on a tab
 * session's winlink with the base's flag clear, because the base had been
 * viewing the window when it rang. So the bell counts from any winlink, and it
 * has been seen only if some *attached* session currently has the window
 * current. With cmux closed there is one winlink and the flag is exact.
 */
export function unreadWindow(links: readonly { bell: boolean; attached: boolean; active: boolean }[]): boolean {
  if (!links.some((l) => l.bell)) return false;
  return !links.some((l) => l.attached && l.active);
}

/**
 * The state of every window that has a live stamp, from the raw `list-panes`
 * rows. A window with two panes running two agents takes the more urgent of
 * them, since the row has one glyph and the question it answers is "does
 * anything in here want me".
 */
export function windowStates(
  panes: readonly { id: string; raw: string; cwd?: string; interrupted?: boolean }[],
  activity: ReadonlyMap<string, number>,
  now: number,
  alive: (pid: number) => boolean,
): Map<string, WindowAgent> {
  const seen = new Map<string, WindowAgent[]>();
  for (const pane of panes) {
    const stamp = parseStamp(pane.raw);
    if (!stamp) continue;
    const guarded = guardStamp(stamp, activity.get(pane.id) ?? 0, now, alive);
    if (guarded === null) continue;
    const state = pane.interrupted ? "done" : guarded;
    const list = seen.get(pane.id) ?? [];
    list.push({
      state,
      since: stamp.since,
      ...(stamp.configDir ? { configDir: stamp.configDir } : {}),
      ...(pane.cwd ? { cwd: pane.cwd } : {}),
    });
    seen.set(pane.id, list);
  }
  const out = new Map<string, WindowAgent>();
  for (const [id, list] of seen) {
    const state = worstState(list.map((x) => x.state));
    if (state === undefined) continue;
    // The oldest pane in that state: "waiting 12m" should be the longest wait,
    // and the rest of what the window says comes from that same pane.
    const oldest = list.filter((x) => x.state === state).sort((a, b) => a.since - b.since)[0]!;
    out.set(id, oldest);
  }
  return out;
}

/** What `windowStates` reports for one window: the pane speaking for it. */
export interface WindowAgent {
  state: AgentState;
  since: number;
  configDir?: string;
  /** The agent's pane's working directory: the one the agent is editing in. */
  cwd?: string;
}

/**
 * The git checkout a directory is in: the nearest directory up from it holding
 * a `.git`, whether that is a repository's directory or a worktree's file. A
 * worktree is its own checkout on purpose -- two agents in two worktrees of one
 * repository are the fix for sharing, not an instance of it. Null outside git.
 */
export function checkoutOf(dir: string, hasGit: (dir: string) => boolean): string | null {
  let at = dir.replace(/\/+$/, "") || "/";
  for (;;) {
    if (hasGit(at)) return at;
    if (at === "/") return null;
    const up = at.slice(0, at.lastIndexOf("/")) || "/";
    if (up === at) return null;
    at = up;
  }
}

/** Whether a process exists. EPERM means it does and is not ours, which is still alive. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * The status mark Claude Code puts before its title (`✳ Banner migration`), or
 * a braille spinner frame. Only a mark from this set, and only as a word of
 * its own, so a title's own punctuation, like `[WIP] x`, is never cut.
 */
const TITLE_MARK = /^(?:[\u2800-\u28FF]|[✳✶✻✽✢·])(?:\s+|$)/u;

/**
 * What to call a window. tmux names one after the command running in it, which
 * for an agent is its version and so identical for every tab; the title the
 * program sets is the part that differs. Claude's own status mark is dropped
 * from it: the tab's glyph already says the state, and the mark said it again.
 * tmux seeds the title with the hostname, which names the machine rather than
 * the window, so that is ignored.
 */
export function windowLabel(windowName: string, paneTitle: string, host: string): string {
  const title = paneTitle.trim().replace(TITLE_MARK, "").trim();
  if (!title || title === windowName) return windowName;
  const lower = title.toLowerCase();
  if (lower === host.toLowerCase() || lower === host.split(".")[0].toLowerCase()) return windowName;
  return title;
}

export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

const NO_SERVER = /no server running|no sessions|error connecting to/;
const NOT_FOUND = /can't find session/;
const WINDOW_ID = /^@\d+$/;

/** Foreground commands that mean nothing owns the keyboard -- anything else is a program. */
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

/** One `list-sessions` row. `id` is `#{session_id}` without its `$`. */
interface SessionRow {
  name: string;
  attached: number;
  grouped: boolean;
  group: string;
  id: number;
  workspaceId: string;
  order?: number;
  customName: string;
  /** A split pane's private view of the group (`@muxnexus_view`), never a sidebar row or a client of its own. */
  view: boolean;
}

export class Tmux {
  /**
   * @param socketName  tmux `-L` socket name (default socket directory)
   * @param socketPath  tmux `-S` socket path; takes precedence over `socketName`
   */
  constructor(
    private readonly socketName?: string,
    private readonly socketPath?: string,
  ) {}

  /**
   * `checkoutOf`, remembered per directory: it is asked for every agent on
   * every poll, and a directory's checkout only changes when one is created or
   * removed. Forgotten wholesale past a few hundred directories.
   */
  private checkouts = new Map<string, string | null>();

  private checkout(dir: string): string | null {
    let root = this.checkouts.get(dir);
    if (root === undefined) {
      if (this.checkouts.size > 500) this.checkouts.clear();
      root = checkoutOf(dir, (d) => existsSync(join(d, ".git")));
      this.checkouts.set(dir, root);
    }
    return root;
  }

  private argv(args: string[]): string[] {
    return ["tmux", ...socketArgs(this.socketName, this.socketPath), ...args];
  }

  /** Run a tmux command. Resolves stdout, rejects with TmuxError(stderr) on nonzero exit. */
  async run(args: string[]): Promise<string> {
    const proc = Bun.spawn(this.argv(args), { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new TmuxError(stderr.trim() || `tmux exited with code ${code}`);
    return stdout;
  }

  /** All sessions, one tmux call. Returns [] when no server is running. */
  private async rows(): Promise<SessionRow[]> {
    let out: string;
    try {
      out = await this.run([
        "list-sessions", "-F",
        "#{session_name}\t#{session_attached}\t#{session_grouped}\t#{session_group}\t#{session_id}\t#{@muxnexus_workspace}\t#{@muxnexus_order}\t#{@muxnexus_name}\t#{@muxnexus_view}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }
    return lines(out).map((l) => l.split("\t")).filter((p) => p.length === 9).map(([name, attached, grouped, group, id, workspaceId, order, customName, view]) => ({
      name, attached: Number(attached), grouped: grouped === "1", group, id: Number(id.replace(/^\$/, "")), workspaceId,
      order: order === "" ? undefined : Number(order),
      customName,
      view: view === "1",
    }));
  }

  /**
   * Agent state per window, in one `list-panes` call (~5 ms) rather than
   * anything per session. Panes are the unit because the hook knows its pane;
   * grouped tab sessions share the pane, so they are covered for free.
   */
  private async agentStates(
    rows: readonly { id: string; activity: number }[],
  ): Promise<{ agents: Map<string, WindowAgent>; conversations: Map<string, ConversationInfo> }> {
    let out: string;
    try {
      out = await this.run(["list-panes", "-a", "-F",
        "#{window_id}\t#{pane_current_path}\t#{@muxnexus_session}\t#{@muxnexus_agent}"]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) {
        return { agents: new Map(), conversations: new Map() };
      }
      throw e;
    }
    // The agent stamp goes last so it keeps the "rest of the line" treatment it
    // had before the session stamp was added in front of it.
    const panes = lines(out).map((l) => {
      const [id, cwd, session, ...rest] = l.split("\t");
      return { id, cwd, session, raw: rest.join("\t") };
    });
    // Gathered per window rather than per pane: two panes in one window would
    // each hold their own conversation, and the tab offers one. First stamp wins,
    // matching how the window takes one pane's agent rather than merging them.
    const conversations = new Map<string, ConversationInfo>();
    for (const pane of panes) {
      if (!pane.session || conversations.has(pane.id)) continue;
      const parsed = parseSession(pane.session);
      if (parsed) conversations.set(pane.id, parsed);
    }
    // Only a stamp claiming a turn is under way needs its transcript read; a
    // missing file (a fork before its first message) is no evidence either way.
    const checked = await Promise.all(panes.map(async (pane) => {
      const stamp = parseStamp(pane.raw);
      const transcript = pane.session ? parseSession(pane.session)?.transcriptPath : undefined;
      if (!stamp || stamp.state === "done" || !transcript) return pane;
      try {
        const file = Bun.file(transcript);
        const tail = await file.slice(Math.max(0, file.size - TRANSCRIPT_TAIL_BYTES)).text();
        return { ...pane, interrupted: interruptedAfter(tail, stamp.since) };
      } catch {
        return pane;
      }
    }));
    const activity = new Map(rows.map((r) => [r.id, r.activity]));
    const agents = windowStates(checked, activity, Math.floor(Date.now() / 1000), processAlive);
    return { agents, conversations };
  }

  /** Members of the group `row` belongs to (just `row` when ungrouped), oldest first. */
  private groupOf(row: SessionRow, all: SessionRow[]): SessionRow[] {
    if (!row.grouped) return [row];
    return all.filter((r) => r.grouped && r.group === row.group).sort((a, b) => a.id - b.id);
  }

  /** The representative of a group: the member named like the group if present, else the oldest. */
  private representative(members: SessionRow[]): SessionRow {
    const groupName = members[0].grouped ? members[0].group : members[0].name;
    return members.find((m) => m.name === groupName) ?? members[0];
  }

  /** One entry per session group (or per ungrouped session), named after its representative. */
  async listSessions(): Promise<SessionInfo[]> {
    const all = await this.rows();
    if (all.length === 0) return [];
    let winOut: string;
    try {
      winOut = await this.run([
        "list-windows", "-a", "-F",
        "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{pane_title}\t#{@muxnexus_surface}\t#{window_id}\t#{window_bell_flag}\t#{window_activity}\t#{@muxnexus_window_name}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }

    // A group key can never collide with a plain session's key: an ungrouped
    // session named `ws` can coexist with an orphaned group whose group name
    // is `ws`, and both must appear.
    const groups = new Map<string, { info: SessionInfo; rep: SessionRow }>();
    for (const row of all) {
      const key = row.grouped ? `g ${row.group}` : `s ${row.name}`;
      if (groups.has(key)) continue;
      // A split pane's view is the browser looking twice, not a session of its
      // own: it must neither name the group nor light the "someone else is
      // attached" dot. Kept when nothing else is left, so the windows still show.
      const group = this.groupOf(row, all);
      const members = group.some((m) => !m.view) ? group.filter((m) => !m.view) : group;
      const rep = this.representative(members);
      groups.set(key, {
        info: {
          name: rep.name,
          id: idTarget(rep.id),
          attached: members.reduce((n, m) => n + m.attached, 0),
          windows: [],
          ...(rep.workspaceId ? { workspaceId: rep.workspaceId } : {}),
          ...(rep.customName ? { customName: rep.customName } : {}),
          ...(rep.order === undefined || Number.isNaN(rep.order) ? {} : { order: rep.order }),
        },
        rep,
      });
    }
    const byRep = new Map<string, SessionInfo>();
    for (const g of groups.values()) byRep.set(g.rep.name, g.info);

    // Every winlink, including the tab sessions that share these windows: a
    // window's bell means "unseen" only if no attached tab session is showing it.
    const rows = lines(winOut)
      .map((l) => l.split("\t"))
      .filter((p) => p.length === 11)
      .map(([session, index, name, active, panes, paneTitle, surfaceId, id, bell, activity, customName]) => ({
        session, index, name, paneTitle, surfaceId, id, customName,
        active: active === "1",
        panes: Number(panes),
        bell: bell === "1",
        activity: Number(activity),
        attached: (all.find((r) => r.name === session)?.attached ?? 0) > 0,
      }));

    const { agents, conversations } = await this.agentStates(rows);

    for (const row of rows) {
      const s = byRep.get(row.session);
      if (!s) continue; // a tab session: it contributed its viewing above, nothing more
      const state = agents.get(row.id);
      const checkout = state?.cwd ? this.checkout(state.cwd) : null;
      s.windows.push({
        id: row.id,
        index: Number(row.index),
        name: windowLabel(row.name, row.paneTitle, hostname()),
        active: row.active,
        panes: row.panes,
        ...(row.customName ? { customName: row.customName } : {}),
        ...(row.surfaceId ? { surfaceId: row.surfaceId } : {}),
        ...(state
          ? {
              agent: {
                state: state.state,
                since: new Date(state.since * 1000).toISOString(),
                ...(state.configDir ? { profile: profileLabel(state.configDir) } : {}),
                ...(checkout ? { checkout } : {}),
              },
            }
          : {}),
        ...(conversations.has(row.id) ? { conversation: conversations.get(row.id)! } : {}),
        ...(unreadWindow(rows.filter((o) => o.id === row.id)) ? { unread: true } : {}),
      });
    }
    // Creation order was only ever a stand-in; `@muxnexus_order` is the real one
    // once the sidebar has been arranged. Unstamped sessions keep falling back to
    // oldest-first, which is what orderSessions's name tiebreak would otherwise
    // disturb, so feed it the list already in id order.
    const byAge = [...groups.values()].sort((a, b) => a.rep.id - b.rep.id).map((g) => g.info);
    return orderSessions(byAge);
  }

  /** The session a sidebar name refers to, by exact name. */
  private async row(name: string): Promise<SessionRow> {
    const r = (await this.rows()).find((x) => x.name === name);
    if (!r) throw new TmuxError(`can't find session: ${name}`);
    return r;
  }

  /**
   * The tmux target for a sidebar name: the session's id (`$3`), never its name.
   * tmux accepts '.' and ':' in a session name yet splits a target on them, so
   * `=api.v2` is session `api`, window `v2` -- set-option stamped the wrong
   * session with it, and kill-session could not find the right one. An id has
   * neither character.
   * Rejects with TmuxError("can't find session: <name>") when it does not exist.
   */
  async target(name: string): Promise<string> {
    return idTarget((await this.row(name)).id);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.target(name);
      return true;
    } catch (e) {
      if (e instanceof TmuxError && (NO_SERVER.test(e.message) || NOT_FOUND.test(e.message))) return false;
      throw e;
    }
  }

  /**
   * Whether a session id (`$3`) still names a live session. By id rather than
   * name, so a session renamed since it was looked up still counts.
   */
  async alive(target: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", target]);
      return true;
    } catch (e) {
      if (e instanceof TmuxError && (NO_SERVER.test(e.message) || NOT_FOUND.test(e.message))) return false;
      throw e;
    }
  }

  /** `env` lands in the session's environment, so every window made in it later inherits it too. */
  async newSession(name: string, cwd: string = homedir(), env: Record<string, string> = {}): Promise<void> {
    const vars = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    await this.run(["new-session", "-d", "-s", name, "-c", cwd, ...vars]);
  }

  /**
   * Type a resume into the window's shell, so the conversation continues under
   * another account in the tab it is already in. `send-keys` rather than
   * `respawn-window` on purpose: the pane is never replaced, so its scrollback
   * -- the last thing the agent said before it was stopped -- stays readable
   * while the new one starts.
   *
   * `configDir` null means the default profile, and the variable is *unset*
   * rather than set to `~/.claude`: Claude Code keys its credentials on its
   * absence, so an explicit path there reads as signed out. The session's own
   * tmux environment may already hold a `CLAUDE_CONFIG_DIR` from its `[Work]`
   * tag, which is exactly why neither branch can rely on inheriting it.
   *
   * `--fork-session` because a plain resume keeps appending to the transcript
   * where it was found, i.e. in the *old* profile's `projects/`. The target
   * account then never lists the conversation in its own `/resume`, and the
   * status line, which names the profile from `.transcript_path`, badges it as
   * the account it left. A fork writes a new session under the current config
   * dir and leaves the original file as it was.
   */
  async resumeIn(
    session: string,
    id: string,
    configDir: string | null,
    conversation: ConversationInfo,
  ): Promise<void> {
    const target = await this.windowTarget(session, id);
    // Settled before anything is quit: an agent stopped for a resume that cannot
    // run is a tab lost for nothing.
    const from = parseSession(await this.run(["display", "-p", "-t", target, "#{@muxnexus_from}"]).catch(() => ""));
    const transcript = resolveTranscript(conversation, from, existsSync);
    if (!transcript) throw new TmuxError(`no transcript on disk for that conversation: ${conversation.transcriptPath}`);
    // An agent owns the keyboard: typed at a running Claude Code, the resume
    // lands in its prompt box and is sent as a message rather than run. Ask the
    // pane what is in the foreground rather than the hook stamp -- a pane whose
    // agent started before the hook existed carries no stamp at all, and that
    // is exactly the pane this used to type straight into.
    if (!(await this.isShell(target))) {
      await this.type(target, "/exit");
      if (!(await this.waitForShell(target))) {
        throw new TmuxError("the agent in that tab did not exit; quit it and try again");
      }
    }
    const prefix = configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ` : "env -u CLAUDE_CONFIG_DIR ";
    await this.type(target, `${prefix}claude --resume ${shellQuote(transcript)} --fork-session`);
    // The new agent's SessionStart stamp is the only proof the line actually ran.
    // Without this a command left sitting on the prompt -- swallowed Enter, a
    // shell that was not ready -- looks identical to a switch that worked, and
    // the user finds out by staring at the tab. An agent merely appearing is not
    // proof: one that cannot load the transcript starts, prints why, and exits.
    const fork = await this.waitForSession(target, conversation.sessionId);
    if (!fork) {
      throw new TmuxError("typed the resume, but no conversation started in that tab -- check its terminal");
    }
    await this.run(["set-option", "-p", "-t", target, "@muxnexus_from", `${fork.sessionId} ${transcript}`]);
  }

  /**
   * Type a line at a shell and run it.
   *
   * Three calls, not one. `send-keys "<cmd>" Enter` looks equivalent and is not:
   * zsh reads a long string as a bracketed paste and holds the Enter that
   * arrives inside it, leaving the command sitting on the prompt unrun -- which
   * is exactly what it did. `-l` sends the text literally, the Enter goes
   * separately as a key, and `C-u` first clears whatever half-typed line the
   * pane was left with, which would otherwise be submitted instead.
   */
  private async type(target: string, line: string): Promise<void> {
    await this.run(["send-keys", "-t", target, "C-u"]);
    await this.run(["send-keys", "-t", target, "-l", "--", line]);
    await this.run(["send-keys", "-t", target, "Enter"]);
  }

  /**
   * Whether the pane's foreground process is a plain shell.
   *
   * The hook stamp cannot answer this: it outlives the agent it describes (a
   * pane reads `done` while Claude Code is still on screen) and is absent for
   * any agent started before the hook was installed. `pane_current_command` is
   * the kernel's own answer and needs no cooperation from the agent.
   */
  private async isShell(target: string): Promise<boolean> {
    const raw = await this.run(["display", "-p", "-t", target, "#{pane_current_command}"]).catch(() => "");
    return SHELLS.has(raw.trim());
  }

  /** Poll until a session other than `previous` stamps the pane, meaning the resume really started. */
  private async waitForSession(target: string, previous: string, ms = 20000, step = 250): Promise<ConversationInfo | null> {
    for (let waited = 0; waited < ms; waited += step) {
      await new Promise((r) => setTimeout(r, step));
      const raw = await this.run(["display", "-p", "-t", target, "#{@muxnexus_session}"]).catch(() => "");
      const now = parseSession(raw);
      if (now && now.sessionId !== previous) return now;
    }
    return null;
  }

  /**
   * Poll until the pane's agent stamp is gone, meaning SessionEnd has fired and
   * the shell is back. Bounded rather than indefinite: a wedged agent must not
   * leave the switch hanging, and the caller says so instead.
   */
  private async waitForShell(target: string, ms = 6000, step = 150): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += step) {
      await new Promise((r) => setTimeout(r, step));
      if (await this.isShell(target)) return true;
    }
    return false;
  }

  async newWindow(session: string): Promise<void> {
    await this.run(["new-window", "-t", `${await this.target(session)}:`]);
  }

  async killSession(session: string): Promise<void> {
    const all = await this.rows();
    const row = all.find((r) => r.name === session);
    if (!row) throw new TmuxError(`can't find session: ${session}`);
    for (const m of this.groupOf(row, all)) {
      await this.run(["kill-session", "-t", idTarget(m.id)]).catch((e) => {
        if (e instanceof TmuxError && NOT_FOUND.test(e.message)) return; // already gone
        throw e;
      });
    }
  }

  /**
   * A window of a session, by tmux's window id (`@3`). Never by index: an index
   * is a slot that swap-window moves windows through, so a kill confirmed
   * against one tab could land on whatever another device reordered into it.
   * The session part keeps select-window acting on this session alone, not on
   * a grouped cmux tab session that shares the window.
   */
  private async windowTarget(session: string, id: string): Promise<string> {
    if (!WINDOW_ID.test(id)) throw new TmuxError(`invalid window id: ${id}`);
    return `${await this.target(session)}:${id}`;
  }

  /**
   * A private grouped session showing one window of `session`, for a split
   * pane: a tmux client shows its session's current window, so two panes of one
   * session need two sessions. Addressed by the id it returns, never by name --
   * the name inherits any '.' or ':' of the base's. Stamped so a sweep can find
   * it and the sidebar can ignore it.
   */
  async openView(session: string, windowId: string): Promise<string> {
    if (!WINDOW_ID.test(windowId)) throw new TmuxError(`not a window id: ${windowId}`);
    const base = await this.target(session);
    // Named after the session so tmux's own status line reads the same in both
    // panes; the name is only ever shown, never used as a target.
    const name = `${session}~view-${crypto.randomUUID().slice(0, 6)}`;
    const id = (await this.run(["new-session", "-d", "-P", "-F", "#{session_id}", "-t", base, "-s", name])).trim();
    try {
      await this.run(["set-option", "-t", id, "@muxnexus_view", "1"]);
      await this.run(["select-window", "-t", `${id}:${windowId}`]);
    } catch (e) {
      await this.closeView(id);
      throw e;
    }
    return id;
  }

  /**
   * From here on tmux removes the view when its client goes, even if this
   * server dies first -- but never as the last member of its group, which would
   * take the windows with it. Only once a client is attached: set on a session
   * with none, it is destroyed on the spot.
   */
  async releaseView(id: string): Promise<void> {
    await this.run(["set-option", "-t", id, "destroy-unattached", "keep-last"]);
  }

  /** Remove a view, unless it is the last of its group: then it is all that holds the windows. */
  async closeView(id: string): Promise<void> {
    const all = await this.rows();
    const row = all.find((r) => idTarget(r.id) === id);
    if (!row || this.groupOf(row, all).length < 2) return;
    await this.run(["kill-session", "-t", id]).catch((e) => {
      if (!(e instanceof TmuxError && (NOT_FOUND.test(e.message) || NO_SERVER.test(e.message)))) throw e;
    });
  }

  /** Views left behind by a server that stopped before releasing them. */
  async sweepViews(): Promise<void> {
    for (const r of await this.rows()) {
      if (r.view && r.attached === 0) await this.closeView(idTarget(r.id));
    }
  }

  async killWindow(session: string, id: string): Promise<void> {
    await this.run(["kill-window", "-t", await this.windowTarget(session, id)]);
  }

  async selectWindow(session: string, id: string): Promise<void> {
    await this.run(["select-window", "-t", await this.windowTarget(session, id)]);
  }

  async renameSession(session: string, name: string): Promise<void> {
    const target = await this.target(session);
    await this.run(["rename-session", "-t", target, "--", name]);
    // The stamp is what the client displays: it survives cmux re-titling and, on
    // a session whose name is a cmux workspace, keeps the rename from racing the
    // guard's own name sync.
    await this.run(["set-option", "-t", target, "@muxnexus_name", name]);
  }

  async renameWindow(session: string, id: string, name: string): Promise<void> {
    const target = await this.windowTarget(session, id);
    await this.run(["rename-window", "-t", target, "--", name]);
    await this.run(["set-option", "-w", "-t", target, "@muxnexus_window_name", name]);
  }

  /**
   * Stamp the sidebar position of each name, in the order given. A name that is
   * gone -- killed between the drag and now -- is skipped, not an error.
   */
  async setSessionOrder(names: readonly string[]): Promise<void> {
    const all = await this.rows();
    for (const [i, name] of names.entries()) {
      const row = all.find((r) => r.name === name);
      if (row) await this.run(["set-option", "-t", idTarget(row.id), "@muxnexus_order", String(i)]);
    }
  }

  /**
   * Rearrange a session's windows into `wanted` (window ids, in order). The ids
   * are turned into the indices they sit at right now, so an order made before
   * another device moved things still means the windows the user dragged.
   * `move-window` cannot be used: tmux refuses an occupied target index.
   */
  async reorderWindows(session: string, wanted: readonly string[]): Promise<void> {
    const target = await this.target(session);
    const out = await this.run(["list-windows", "-t", target, "-F", "#{window_index}\t#{window_id}"]);
    const at = new Map(lines(out).map((l) => {
      const [index, id] = l.split("\t");
      return [id, Number(index)] as const;
    }));
    const positions = [...at.values()].sort((a, b) => a - b);
    const indices = wanted.map((id) => at.get(id)).filter((i): i is number => i !== undefined);
    for (const [a, b] of swapPlan(positions, indices)) {
      await this.run(["swap-window", "-s", `${target}:${b}`, "-t", `${target}:${a}`]);
    }
  }

  /** Kill the whole server on this socket. Never throws (used by tests). */
  async killServer(): Promise<void> {
    try {
      await this.run(["kill-server"]);
    } catch {
      /* no server: nothing to do */
    }
  }
}

/** A session id as a tmux target. */
function idTarget(id: number): string {
  return `$${id}`;
}

/** tmux socket selection flags: `-S path` wins over `-L name`; neither means tmux's default. */
export function socketArgs(socketName?: string, socketPath?: string): string[] {
  if (socketPath) return ["-S", socketPath];
  if (socketName) return ["-L", socketName];
  return [];
}

function lines(out: string): string[] {
  return out.split("\n").filter((l) => l.length > 0);
}
