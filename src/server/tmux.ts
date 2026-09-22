import { homedir, hostname } from "node:os";
import type { SessionInfo } from "../shared/protocol";

/**
 * What to call a window. tmux names one after the command running in it, which
 * for an agent is its version and so identical for every tab; the title the
 * program sets is the part that differs. tmux seeds that title with the
 * hostname, which names the machine rather than the window, so it is ignored.
 */
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
        "#{session_name}\t#{session_attached}\t#{session_grouped}\t#{session_group}\t#{session_id}\t#{@muxnexus_workspace}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }
    return lines(out).map((l) => l.split("\t")).filter((p) => p.length === 6).map(([name, attached, grouped, group, id, workspaceId]) => ({
      name, attached: Number(attached), grouped: grouped === "1", group, id: Number(id.replace(/^\$/, "")), workspaceId,
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
        "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{pane_title}\t#{@muxnexus_surface}",
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
        },
        rep,
      });
    }
    const byRep = new Map<string, SessionInfo>();
    for (const g of groups.values()) byRep.set(g.rep.name, g.info);
    for (const line of lines(winOut)) {
      const parts = line.split("\t");
      if (parts.length !== 7) continue;
      const [session, index, name, active, panes, paneTitle, surfaceId] = parts;
      const s = byRep.get(session);
      if (!s) continue; // a tab session, or a session that vanished between the two calls
      s.windows.push({
        index: Number(index),
        name: windowLabel(name, paneTitle, hostname()),
        active: active === "1",
        panes: Number(panes),
        ...(surfaceId ? { surfaceId } : {}),
      });
    }
    return [...groups.values()].sort((a, b) => a.rep.id - b.rep.id).map((g) => g.info);
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
