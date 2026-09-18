import { homedir } from "node:os";

/**
 * Optional parity with the cmux terminal app. When the viewer drives cmux's own
 * local-tmux server, sessions created here can be mirrored as cmux workspaces so
 * they appear in cmux's sidebar. Every call shells out to the `cmux` CLI with an
 * argv array; nothing here is required when cmux is absent.
 */
export interface CmuxMirrorOptions {
  /** Absolute path to the `cmux` CLI. */
  cmuxBin: string;
  /** The tmux socket the viewer is driving (informational; the workspace attaches via VIEWER_TMUX_SESSION). */
  socketPath: string;
  /** Working directory for mirrored workspaces. Defaults to the home directory. */
  cwd?: string;
}

export interface CmuxMirror {
  /** A session was created from the browser: open an unfocused cmux workspace attached to it. */
  sessionCreated(name: string): Promise<void>;
  /** A session was renamed: retitle its workspace, if one exists. */
  sessionRenamed(from: string, to: string): Promise<void>;
  /** A session was killed: close its workspace, if one exists. */
  sessionKilled(name: string): Promise<void>;
}

export class CmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmuxError";
  }
}

interface WorkspaceRow {
  custom_title?: string | null;
  ref?: string;
}

export function createCmuxMirror(opts: CmuxMirrorOptions): CmuxMirror {
  const cwd = opts.cwd ?? homedir();

  async function run(args: string[]): Promise<string> {
    const proc = Bun.spawn([opts.cmuxBin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new CmuxError(stderr.trim() || `cmux exited with code ${code}`);
    return stdout;
  }

  /** The `workspace:N` ref of the workspace titled exactly `name`, or undefined. */
  async function findWorkspace(name: string): Promise<string | undefined> {
    const out = await run(["workspace", "list", "--json"]);
    let rows: WorkspaceRow[] = [];
    try {
      rows = (JSON.parse(out) as { workspaces?: WorkspaceRow[] }).workspaces ?? [];
    } catch {
      throw new CmuxError("cmux workspace list returned invalid JSON");
    }
    return rows.find((w) => w.custom_title === name)?.ref;
  }

  return {
    async sessionCreated(name) {
      // The workspace's shell reads VIEWER_TMUX_SESSION and attaches to that session
      // (see the cmux guard in ~/.zshrc), so the new workspace shows this session.
      await run([
        "workspace", "create",
        "--name", name,
        "--cwd", cwd,
        "--env", `VIEWER_TMUX_SESSION=${name}`,
        "--focus", "false",
      ]);
    },
    async sessionRenamed(from, to) {
      const ref = await findWorkspace(from);
      if (ref) await run(["workspace", "rename", ref, "--title", to]);
    },
    async sessionKilled(name) {
      const ref = await findWorkspace(name);
      if (ref) await run(["workspace", "close", ref]);
    },
  };
}
