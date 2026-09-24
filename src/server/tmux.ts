import { homedir, hostname } from "node:os";
import type { AgentState, SessionInfo } from "../shared/protocol";

/**
 * What to call a window. tmux names one after the command running in it, which
 * for an agent is its version and so identical for every tab; the title the
 * program sets is the part that differs. tmux seeds that title with the
 * hostname, which names the machine rather than the window, so it is ignored.
 */
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
 * A window's `@muxnexus_agent` stamp: `"<state> <epoch> <pid>"`, written by the
 * Claude Code hook. Anything else is no stamp at all rather than a guess -- the
 * option is a string tmux will hand back whatever is in it.
 */
export interface Stamp {
  state: AgentState;
  /** Unix seconds: when the pane entered this state. */
  since: number;
  /** The agent process, so a stamp outliving its process can be dropped. */
  pid: number;
}

export function parseStamp(raw: string): Stamp | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const [state, since, pid] = parts;
  if (state !== "input" && state !== "running" && state !== "done") return null;
  const at = Number(since);
  const process = Number(pid);
  if (!Number.isInteger(at) || !Number.isInteger(process) || process <= 0) return null;
  return { state, since: at, pid: process };
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
 * moved in STALE_SECONDS is reported as done. `Notification[idle_prompt]`
 * corrects it properly a minute later.
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
  panes: readonly { id: string; raw: string }[],
  activity: ReadonlyMap<string, number>,
  now: number,
  alive: (pid: number) => boolean,
): Map<string, { state: AgentState; since: number }> {
  const seen = new Map<string, { state: AgentState; since: number }[]>();
  for (const pane of panes) {
    const stamp = parseStamp(pane.raw);
    if (!stamp) continue;
    const state = guardStamp(stamp, activity.get(pane.id) ?? 0, now, alive);
    if (state === null) continue;
    const list = seen.get(pane.id) ?? [];
    list.push({ state, since: stamp.since });
    seen.set(pane.id, list);
  }
  const out = new Map<string, { state: AgentState; since: number }>();
  for (const [id, list] of seen) {
    const state = worstState(list.map((x) => x.state));
    if (state === undefined) continue;
    // The oldest pane in that state: "waiting 12m" should be the longest wait.
    const since = Math.min(...list.filter((x) => x.state === state).map((x) => x.since));
    out.set(id, { state, since });
  }
  return out;
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

export function windowLabel(windowName: string, paneTitle: string, host: string): string {
  const title = paneTitle.trim();
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
        "#{session_name}\t#{session_attached}\t#{session_grouped}\t#{session_group}\t#{session_id}\t#{@muxnexus_workspace}\t#{@muxnexus_order}\t#{@muxnexus_name}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }
    return lines(out).map((l) => l.split("\t")).filter((p) => p.length === 8).map(([name, attached, grouped, group, id, workspaceId, order, customName]) => ({
      name, attached: Number(attached), grouped: grouped === "1", group, id: Number(id.replace(/^\$/, "")), workspaceId,
      order: order === "" ? undefined : Number(order),
      customName,
    }));
  }

  /**
   * Agent state per window, in one `list-panes` call (~5 ms) rather than
   * anything per session. Panes are the unit because the hook knows its pane;
   * grouped tab sessions share the pane, so they are covered for free.
   */
  private async agentStates(
    rows: readonly { id: string; activity: number }[],
  ): Promise<Map<string, { state: AgentState; since: number }>> {
    let out: string;
    try {
      out = await this.run(["list-panes", "-a", "-F", "#{window_id}\t#{@muxnexus_agent}"]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return new Map();
      throw e;
    }
    const panes = lines(out).map((l) => {
      const [id, raw] = l.split("\t");
      return { id, raw: raw ?? "" };
    });
    const activity = new Map(rows.map((r) => [r.id, r.activity]));
    return windowStates(panes, activity, Math.floor(Date.now() / 1000), processAlive);
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
      const members = this.groupOf(row, all);
      const rep = this.representative(members);
      groups.set(key, {
        info: {
          name: rep.name,
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

    const agents = await this.agentStates(rows);

    for (const row of rows) {
      const s = byRep.get(row.session);
      if (!s) continue; // a tab session: it contributed its viewing above, nothing more
      const state = agents.get(row.id);
      s.windows.push({
        id: row.id,
        index: Number(row.index),
        name: windowLabel(row.name, row.paneTitle, hostname()),
        active: row.active,
        panes: row.panes,
        ...(row.customName ? { customName: row.customName } : {}),
        ...(row.surfaceId ? { surfaceId: row.surfaceId } : {}),
        ...(state
          ? { agent: { state: state.state, since: new Date(state.since * 1000).toISOString() } }
          : {}),
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

  async newSession(name: string, cwd: string = homedir()): Promise<void> {
    await this.run(["new-session", "-d", "-s", name, "-c", cwd]);
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

  async killWindow(session: string, index: number): Promise<void> {
    await this.run(["kill-window", "-t", `${await this.target(session)}:${index}`]);
  }

  async selectWindow(session: string, index: number): Promise<void> {
    await this.run(["select-window", "-t", `${await this.target(session)}:${index}`]);
  }

  async renameSession(session: string, name: string): Promise<void> {
    const target = await this.target(session);
    await this.run(["rename-session", "-t", target, "--", name]);
    // The stamp is what the client displays: it survives cmux re-titling and, on
    // a session whose name is a cmux workspace, keeps the rename from racing the
    // guard's own name sync.
    await this.run(["set-option", "-t", target, "@muxnexus_name", name]);
  }

  async renameWindow(session: string, index: number, name: string): Promise<void> {
    const target = `${await this.target(session)}:${index}`;
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
   * Rearrange a session's windows into `wanted` (window indices, in order).
   * `move-window` cannot be used: tmux refuses an occupied target index.
   */
  async reorderWindows(session: string, wanted: readonly number[]): Promise<void> {
    const target = await this.target(session);
    const out = await this.run(["list-windows", "-t", target, "-F", "#{window_index}"]);
    const positions = lines(out).map(Number).sort((a, b) => a - b);
    for (const [a, b] of swapPlan(positions, wanted)) {
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
