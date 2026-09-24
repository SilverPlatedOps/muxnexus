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
  sessionRenamed(from: string, to: string, workspaceId?: string): Promise<void>;
  /**
   * A session was killed: close its workspace, if one exists. A stamped
   * `workspaceId` is the only match considered -- if that workspace is gone,
   * one that merely shares the title belongs to something else.
   */
  sessionKilled(name: string, workspaceId?: string): Promise<void>;
  /** Current title of every open workspace, by id. Empty when cmux cannot be read. */
  workspaceTitles(): Promise<Map<string, string>>;
  /** Current title of every open tab (surface), by id. Empty when cmux cannot be read. */
  surfaceTitles(): Promise<Map<string, string>>;
}

export class CmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmuxError";
  }
}

interface SurfaceRow {
  id?: string;
  title?: string | null;
}

interface WorkspaceRow {
  custom_title?: string | null;
  title?: string | null;
  ref?: string;
  id?: string;
}

const SURFACE_TTL_MS = 3000;

export function createCmuxMirror(opts: CmuxMirrorOptions): CmuxMirror {
  let surfaceCache: { at: number; titles: Map<string, string> } | undefined;
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

  let listing: Promise<WorkspaceRow[]> | null = null;

  /**
   * `workspace list --json`, shared by callers that overlap: a poll asks for
   * workspace and tab titles together, and both start from this list.
   */
  function listWorkspaces(): Promise<WorkspaceRow[]> {
    listing ??= run(["workspace", "list", "--json"])
      .then((out) => {
        try {
          return (JSON.parse(out) as { workspaces?: WorkspaceRow[] }).workspaces ?? [];
        } catch {
          throw new CmuxError("cmux workspace list returned invalid JSON");
        }
      })
      .finally(() => { listing = null; });
    return listing;
  }

  /** The `workspace:N` ref of the workspace titled exactly `name`, or undefined. */
  async function findWorkspace(name: string): Promise<string | undefined> {
    return (await listWorkspaces()).find((w) => w.custom_title === name)?.ref;
  }

  /**
   * The workspace with this stamped id. Preferred over the title lookup above:
   * a workspace keeps its id across renames, and the one case worth renaming is
   * exactly the one where the title and the tmux session name have diverged.
   */
  async function findWorkspaceById(id: string): Promise<string | undefined> {
    return (await listWorkspaces()).find((w) => w.id === id)?.ref;
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
    async sessionRenamed(from, to, workspaceId) {
      const ref = (workspaceId ? await findWorkspaceById(workspaceId) : undefined) ?? (await findWorkspace(from));
      if (ref) await run(["workspace", "rename", ref, "--title", to]);
    },
    async sessionKilled(name, workspaceId) {
      const ref = workspaceId ? await findWorkspaceById(workspaceId) : await findWorkspace(name);
      if (ref) await run(["workspace", "close", ref]);
    },
    async workspaceTitles() {
      const titles = new Map<string, string>();
      let rows: WorkspaceRow[];
      try {
        rows = await listWorkspaces();
      } catch {
        return titles; // cmux not answering: callers fall back to tmux's own names
      }
      for (const w of rows) {
        const title = w.custom_title || w.title;
        if (w.id && title) titles.set(w.id, title);
      }
      return titles;
    },
    async surfaceTitles() {
      // One call per workspace, so the result is cached: the poll runs every
      // couple of seconds and tab titles do not change nearly that fast.
      const now = Date.now();
      if (surfaceCache && now - surfaceCache.at < SURFACE_TTL_MS) return surfaceCache.titles;
      const titles = new Map<string, string>();
      let refs: string[];
      try {
        refs = (await listWorkspaces()).map((w) => w.ref).filter((r): r is string => !!r);
      } catch {
        return surfaceCache?.titles ?? titles; // keep the last good answer over none
      }
      for (const ref of refs) {
        try {
          const out = await run(["list-pane-surfaces", "--workspace", ref, "--json", "--id-format", "both"]);
          for (const s of (JSON.parse(out) as { surfaces?: SurfaceRow[] }).surfaces ?? []) {
            if (s.id && s.title) titles.set(s.id, s.title);
          }
        } catch {
          // a workspace that closed mid-sweep: the rest still count
        }
      }
      surfaceCache = { at: now, titles };
      return titles;
    },
  };
}
