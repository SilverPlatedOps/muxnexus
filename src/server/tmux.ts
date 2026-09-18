import { homedir } from "node:os";
import type { SessionInfo, WindowInfo } from "../shared/protocol";

export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

const NO_SERVER = /no server running|no sessions|error connecting to/;

export class Tmux {
  constructor(private readonly socketName?: string) {}

  private argv(args: string[]): string[] {
    const base = this.socketName ? ["tmux", "-L", this.socketName] : ["tmux"];
    return [...base, ...args];
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

  async listSessions(): Promise<SessionInfo[]> {
    let sessOut: string;
    let winOut: string;
    try {
      sessOut = await this.run(["list-sessions", "-F", "#{session_name}\t#{session_attached}"]);
      winOut = await this.run([
        "list-windows", "-a", "-F",
        "#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}",
      ]);
    } catch (e) {
      if (e instanceof TmuxError && NO_SERVER.test(e.message)) return [];
      throw e;
    }

    const byName = new Map<string, SessionInfo>();
    for (const line of lines(sessOut)) {
      const [name, attached] = line.split("\t");
      byName.set(name, { name, attached: Number(attached), windows: [] });
    }
    for (const line of lines(winOut)) {
      const [session, index, name, active, panes] = line.split("\t");
      const s = byName.get(session);
      if (!s) continue; // session vanished between the two calls
      const w: WindowInfo = { index: Number(index), name, active: active === "1", panes: Number(panes) };
      s.windows.push(w);
    }
    return [...byName.values()];
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch (e) {
      if (e instanceof TmuxError && /can't find session|no server running|no sessions|error connecting to/.test(e.message)) {
        return false;
      }
      throw e;
    }
  }

  async newSession(name: string, cwd: string = homedir()): Promise<void> {
    await this.run(["new-session", "-d", "-s", name, "-c", cwd]);
  }

  async newWindow(session: string): Promise<void> {
    await this.run(["new-window", "-t", `=${session}`]);
  }

  async killSession(session: string): Promise<void> {
    await this.run(["kill-session", "-t", `=${session}`]);
  }

  async killWindow(session: string, index: number): Promise<void> {
    await this.run(["kill-window", "-t", `=${session}:${index}`]);
  }

  async selectWindow(session: string, index: number): Promise<void> {
    await this.run(["select-window", "-t", `=${session}:${index}`]);
  }

  async renameSession(session: string, name: string): Promise<void> {
    await this.run(["rename-session", "-t", `=${session}`, name]);
  }

  async renameWindow(session: string, index: number, name: string): Promise<void> {
    await this.run(["rename-window", "-t", `=${session}:${index}`, name]);
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

function lines(out: string): string[] {
  return out.split("\n").filter((l) => l.length > 0);
}
