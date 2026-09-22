import { homedir, hostname } from "node:os";
import type { SessionInfo } from "../shared/protocol";

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
        "#{session_name}\t#{session_attached}\t#{session_grouped}\t#{session_group}\t#{session_id}\t#{@muxnexus_workspace}\t#{@muxnexus_order}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }
    return lines(out).map((l) => l.split("\t")).filter((p) => p.length === 7).map(([name, attached, grouped, group, id, workspaceId, order]) => ({
      name, attached: Number(attached), grouped: grouped === "1", group, id: Number(id.replace(/^\$/, "")), workspaceId,
      order: order === "" ? undefined : Number(order),
    }));
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
        "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{pane_title}\t#{@muxnexus_surface}\t#{window_id}",
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
          ...(rep.order === undefined || Number.isNaN(rep.order) ? {} : { order: rep.order }),
        },
        rep,
      });
    }
    const byRep = new Map<string, SessionInfo>();
    for (const g of groups.values()) byRep.set(g.rep.name, g.info);
    for (const line of lines(winOut)) {
      const parts = line.split("\t");
      if (parts.length !== 8) continue;
      const [session, index, name, active, panes, paneTitle, surfaceId, id] = parts;
      const s = byRep.get(session);
      if (!s) continue; // a tab session, or a session that vanished between the two calls
      s.windows.push({
        id,
        index: Number(index),
        name: windowLabel(name, paneTitle, hostname()),
        active: active === "1",
        panes: Number(panes),
        ...(surfaceId ? { surfaceId } : {}),
      });
    }
    // Creation order was only ever a stand-in; `@muxnexus_order` is the real one
    // once the sidebar has been arranged. Unstamped sessions keep falling back to
    // oldest-first, which is what orderSessions's name tiebreak would otherwise
    // disturb, so feed it the list already in id order.
    const byAge = [...groups.values()].sort((a, b) => a.rep.id - b.rep.id).map((g) => g.info);
    return orderSessions(byAge);
  }

  /**
   * The tmux session to address for a sidebar name: an exact-name lookup, since
   * every name the sidebar shows is a real session.
   * Rejects with TmuxError("can't find session: <name>") when it does not exist.
   */
  async target(name: string): Promise<string> {
    if (name === "") await this.run(["has-session", "-t", "="]); // let tmux report its own error
    const r = (await this.rows()).find((x) => x.name === name);
    if (!r) throw new TmuxError(`can't find session: ${name}`);
    return name;
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
    await this.run(["new-window", "-t", `=${await this.target(session)}`]);
  }

  async killSession(session: string): Promise<void> {
    const all = await this.rows();
    const row = all.find((r) => r.name === session);
    if (!row) throw new TmuxError(`can't find session: ${session}`);
    for (const m of this.groupOf(row, all)) {
      await this.run(["kill-session", "-t", `=${m.name}`]).catch((e) => {
        if (e instanceof TmuxError && NOT_FOUND.test(e.message)) return; // already gone
        throw e;
      });
    }
  }

  async killWindow(session: string, index: number): Promise<void> {
    await this.run(["kill-window", "-t", `=${await this.target(session)}:${index}`]);
  }

  async selectWindow(session: string, index: number): Promise<void> {
    await this.run(["select-window", "-t", `=${await this.target(session)}:${index}`]);
  }

  async renameSession(session: string, name: string): Promise<void> {
    await this.run(["rename-session", "-t", `=${await this.target(session)}`, "--", name]);
  }

  async renameWindow(session: string, index: number, name: string): Promise<void> {
    await this.run(["rename-window", "-t", `=${await this.target(session)}:${index}`, "--", name]);
  }

  /** Kill the whole server on this socket. Never throws (used by tests). */
  /** Stamp the sidebar position of each name, in the order given. */
  async setSessionOrder(names: readonly string[]): Promise<void> {
    // set-option takes no "=" target prefix; exact names are matched first.
    for (const [i, name] of names.entries()) {
      await this.run(["set-option", "-t", name, "@muxnexus_order", String(i)]);
    }
  }

  /**
   * Rearrange a session's windows into `wanted` (window indices, in order).
   * `move-window` cannot be used: tmux refuses an occupied target index.
   */
  async reorderWindows(session: string, wanted: readonly number[]): Promise<void> {
    const out = await this.run(["list-windows", "-t", `=${session}`, "-F", "#{window_index}"]);
    const positions = lines(out).map(Number).sort((a, b) => a - b);
    for (const [a, b] of swapPlan(positions, wanted)) {
      await this.run(["swap-window", "-s", `=${session}:${b}`, "-t", `=${session}:${a}`]);
    }
  }

  async killServer(): Promise<void> {
    try {
      await this.run(["kill-server"]);
    } catch {
      /* no server: nothing to do */
    }
  }
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
