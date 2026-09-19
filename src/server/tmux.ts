import { homedir } from "node:os";
import type { SessionInfo } from "../shared/protocol";

export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

const NO_SERVER = /no server running|no sessions|error connecting to/;
const NOT_FOUND = /can't find session/;

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

  /** One entry per session group (or per ungrouped session), named after the group. */
  async listSessions(): Promise<SessionInfo[]> {
    let sessOut: string;
    let winOut: string;
    try {
      sessOut = await this.run([
        "list-sessions", "-F",
        "#{session_name}\t#{session_attached}\t#{session_grouped}\t#{session_group}\t#{session_group_list}\t#{session_group_attached}",
      ]);
      winOut = await this.run([
        "list-windows", "-a", "-F",
        "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }

    // group name -> { info, representative }
    const groups = new Map<string, { info: SessionInfo; rep: string }>();
    const names = new Set<string>();
    const rows = lines(sessOut).map((l) => l.split("\t")).filter((p) => p.length === 6);
    for (const [name] of rows) names.add(name);
    for (const [name, attached, grouped, group, list, groupAttached] of rows) {
      const isGroup = grouped === "1";
      const key = isGroup ? group : name;
      if (groups.has(key)) continue;
      const members = isGroup ? list.split(",") : [name];
      const rep = names.has(key) ? key : members[0];
      groups.set(key, {
        info: { name: key, attached: Number(isGroup ? groupAttached : attached), windows: [] },
        rep,
      });
    }
    const byRep = new Map<string, SessionInfo>();
    for (const g of groups.values()) byRep.set(g.rep, g.info);
    for (const line of lines(winOut)) {
      const parts = line.split("\t");
      if (parts.length !== 5) continue;
      const [session, index, name, active, panes] = parts;
      const s = byRep.get(session);
      if (!s) continue; // a tab session, or a session that vanished between the two calls
      s.windows.push({ index: Number(index), name, active: active === "1", panes: Number(panes) });
    }
    return [...groups.values()].map((g) => g.info);
  }

  /**
   * The tmux session to address for a sidebar name: the session with that exact
   * name when it exists, else the first surviving member of the group of that name.
   * Rejects with TmuxError("can't find session: <name>") when neither exists.
   */
  async target(name: string): Promise<string> {
    if (name === "") await this.run(["has-session", "-t", "="]); // let tmux report its own error
    const out = await this.run(["list-sessions", "-F", "#{session_name}\t#{session_grouped}\t#{session_group}\t#{session_group_list}"])
      .catch((e) => { if (e instanceof TmuxError && NO_SERVER.test(e.message)) return ""; throw e; });
    const rows = lines(out).map((l) => l.split("\t")).filter((p) => p.length === 4);
    if (rows.some(([n]) => n === name)) return name;
    const member = rows.find(([, grouped, group]) => grouped === "1" && group === name);
    if (member) return member[3].split(",")[0];
    throw new TmuxError(`can't find session: ${name}`);
  }

  /** All tmux sessions that belong to the group `name` names (the session itself when ungrouped). */
  private async members(name: string): Promise<string[]> {
    const rep = await this.target(name);
    const out = await this.run(["list-sessions", "-F", "#{session_name}\t#{session_grouped}\t#{session_group_list}"]);
    const row = lines(out).map((l) => l.split("\t")).find((p) => p[0] === rep);
    return row && row[1] === "1" ? row[2].split(",") : [rep];
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
    for (const m of await this.members(session)) {
      await this.run(["kill-session", "-t", `=${m}`]).catch((e) => {
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
