/**
 * Snapshot and restore the windows of a tmux server.
 *
 * A tmux server takes every window and running agent with it when it stops, but
 * each conversation's transcript and every note stays on disk. A snapshot records
 * what tmux knew -- where each window was, what it was called, the note it wore
 * and the conversation it held -- so a reboot costs a command rather than a day.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationInfo } from "../shared/protocol";
import { NO_SERVER, resolveTranscript, SHELLS, shellQuote, type Tmux, TmuxError } from "./tmux";

/** `list-panes` fields a snapshot is built from, in the order parsePanes reads them. */
export const PANE_FIELDS = [
  "session_name", "session_id", "@muxnexus_view", "@muxnexus_name", "@muxnexus_order", "window_id", "window_index",
  "window_name", "@muxnexus_window_name", "@muxnexus_note", "@muxnexus_note_empty", "pane_index", "pane_current_path",
  "pane_current_command", "@muxnexus_session", "@muxnexus_from", "@muxnexus_agent",
] as const;

const SEP = "\x1f";

export interface SnapWindow {
  session: string;
  /** The name muxnexus shows for the session, when it differs from tmux's. */
  sessionName?: string;
  order?: string;
  index: number;
  windowName?: string;
  cwd: string;
  command: string;
  /** Note id, so the note pane finds the same note again. */
  note?: string;
  noteEmpty?: string;
  conversation?: ConversationInfo;
  from?: ConversationInfo;
}

/** `<sessionId> <transcript path>`, the shape the tmux options hold. */
function conversation(raw: string): ConversationInfo | undefined {
  const m = /^(\S+)\s+(.+)$/.exec(raw);
  return m ? { sessionId: m[1], transcriptPath: m[2] } : undefined;
}

/**
 * The windows in a `list-panes -a` dump, one entry each.
 *
 * A window shows up once per session that links it -- cmux's grouped tab
 * sessions, muxnexus's split-pane views -- so the first real session that has it
 * keeps it, and view sessions are skipped entirely.
 */
export function parsePanes(out: string): SnapWindow[] {
  const seen = new Set<string>();
  const windows: SnapWindow[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const parts = line.split(SEP);
    const r = Object.fromEntries(PANE_FIELDS.map((f, i) => [f, parts[i] ?? ""])) as Record<string, string>;
    if (r["@muxnexus_view"] === "1" || seen.has(r.window_id)) continue;
    seen.add(r.window_id);
    windows.push({
      session: r.session_name,
      sessionName: r["@muxnexus_name"] || undefined,
      order: r["@muxnexus_order"] || undefined,
      index: Number(r.window_index),
      windowName: r["@muxnexus_window_name"] || undefined,
      cwd: r.pane_current_path,
      command: r.pane_current_command,
      note: r["@muxnexus_note"] || undefined,
      noteEmpty: r["@muxnexus_note_empty"] || undefined,
      conversation: conversation(r["@muxnexus_session"]),
      from: conversation(r["@muxnexus_from"]),
    });
  }
  return windows;
}

export interface Snapshot {
  taken: string;
  /**
   * The tmux server this was taken from (`#{start_time}-#{pid}`). Every server
   * writes its own file, so the empty tmux that comes up after a reboot cannot
   * overwrite the one worth restoring.
   */
  stamp: string;
  windows: SnapWindow[];
}

/** The newest snapshot taken by some *other* tmux server than the one running now. */
export function pickSnapshot(snaps: readonly Snapshot[], liveStamp: string): Snapshot | null {
  const others = snaps.filter((s) => s.stamp !== liveStamp);
  if (others.length === 0) return null;
  return others.reduce((newest, s) => (s.taken > newest.taken ? s : newest));
}

/** The snapshots past the newest `keep`, oldest first: the ones to delete. */
export function stalePaths<T extends { path: string; taken: string }>(entries: readonly T[], keep: number): string[] {
  return [...entries].sort((a, b) => b.taken.localeCompare(a.taken)).slice(keep).map((e) => e.path);
}

/** What the tmux server being restored into already holds. */
export interface Live {
  /** Session names, so a session that survived is left alone. */
  sessions: ReadonlySet<string>;
  /** Conversation ids running right now, so one already on screen is not started twice. */
  conversations: ReadonlySet<string>;
}

export interface RestoreStep {
  window: SnapWindow;
  /** The recorded directory, or home when it has since been deleted. */
  cwd: string;
  /** This window opens the session; the ones after it are added to it. */
  createSession: boolean;
  /** The conversation to resume, absent for a window that held a plain shell. */
  resume?: { configDir: string | null; transcript: string };
}

/**
 * The account a transcript belongs to: the directory holding its `projects/`.
 * `null` means the default `~/.claude`, which is addressed by unsetting
 * CLAUDE_CONFIG_DIR rather than by setting it.
 */
function configDirOf(transcript: string, home: string): string | null {
  const dir = transcript.split("/projects/")[0];
  return dir === join(home, ".claude") ? null : dir;
}

/**
 * What it would take to rebuild `windows`, skipping whatever is already there.
 *
 * Safe to run twice, which matters because this is a command reached for
 * half-awake after a reboot: a session that survived keeps its windows, and a
 * conversation already on screen is never started a second time.
 */
export function restorePlan(
  windows: readonly SnapWindow[],
  live: Live,
  opts: { home: string; exists: (path: string) => boolean },
): RestoreStep[] {
  const steps: RestoreStep[] = [];
  const bySession = new Map<string, SnapWindow[]>();
  for (const w of windows) bySession.set(w.session, [...(bySession.get(w.session) ?? []), w]);

  for (const [session, group] of bySession) {
    if (live.sessions.has(session)) continue;
    let opens = true;
    for (const w of [...group].sort((a, b) => a.index - b.index)) {
      if (w.conversation && live.conversations.has(w.conversation.sessionId)) continue;
      const transcript = w.conversation && !SHELLS.has(w.command)
        ? resolveTranscript(w.conversation, w.from ?? null, opts.exists)
        : null;
      steps.push({
        window: w,
        cwd: opts.exists(w.cwd) ? w.cwd : opts.home,
        createSession: opens,
        resume: transcript ? { configDir: configDirOf(transcript, opts.home), transcript } : undefined,
      });
      opens = false;
    }
  }
  return steps;
}

/** How many snapshots are kept; the rest are pruned as each new one is written. */
const KEEP = 5;

/** Where snapshots live, beside the pidfile and log muxnexusctl already keeps. */
export function snapshotDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "muxnexus", "snapshots");
}

/** A tmux that is not running is not a failure: at login muxnexus may start before cmux does. */
function noServer(e: unknown): boolean {
  return e instanceof TmuxError && NO_SERVER.test(e.message);
}

/** What a tmux server holds right now, in the terms restorePlan skips by. */
export function liveFrom(windows: readonly SnapWindow[]): Live {
  return {
    sessions: new Set(windows.map((w) => w.session)),
    conversations: new Set(windows.flatMap((w) => (w.conversation ? [w.conversation.sessionId] : []))),
  };
}

/** The live windows, or null when no tmux server is running. */
async function panes(tmux: Tmux): Promise<SnapWindow[] | null> {
  try {
    return parsePanes(await tmux.run(["list-panes", "-a", "-F", PANE_FIELDS.map((f) => `#{${f}}`).join(SEP)]));
  } catch (e) {
    if (noServer(e)) return null;
    throw e;
  }
}

/** This tmux server's identity, or null when none is running. */
export async function serverStamp(tmux: Tmux): Promise<string | null> {
  try {
    return (await tmux.run(["display", "-p", "#{start_time}-#{pid}"])).trim() || null;
  } catch (e) {
    if (noServer(e)) return null;
    throw e;
  }
}

/**
 * Record the live windows, or return null when there is no tmux to record.
 *
 * One file per tmux server, named for it: a snapshot taken after a reboot writes
 * its own file rather than overwriting the one that holds the day's work.
 */
export async function takeSnapshot(tmux: Tmux, dir: string): Promise<Snapshot | null> {
  const stamp = await serverStamp(tmux);
  if (!stamp) return null;
  const windows = await panes(tmux);
  if (!windows) return null;
  const snap: Snapshot = { taken: new Date().toISOString(), stamp, windows };
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, `${stamp}.json`), `${JSON.stringify(snap, null, 2)}\n`);
  for (const path of stalePaths(await loadSnapshots(dir), KEEP)) rmSync(path, { force: true });
  return snap;
}

/** Every readable snapshot in `dir`. An unreadable one is skipped, never fatal. */
export async function loadSnapshots(dir: string): Promise<(Snapshot & { path: string })[]> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const snaps = await Promise.all(names.map(async (name) => {
    const path = join(dir, name);
    try {
      const snap = (await Bun.file(path).json()) as Snapshot;
      return typeof snap?.stamp === "string" && Array.isArray(snap.windows) ? { ...snap, path } : null;
    } catch {
      return null;
    }
  }));
  return snaps.filter((s): s is Snapshot & { path: string } => s !== null);
}

/**
 * Rebuild whatever `snap` holds and the live tmux does not, and return the steps
 * actually taken. `resume: false` builds the windows without typing the resume,
 * so a test can exercise the rebuild without starting real agents.
 */
export async function applyRestore(
  tmux: Tmux,
  snap: Snapshot,
  opts: { resume?: boolean } = {},
): Promise<RestoreStep[]> {
  const steps = await planRestore(tmux, snap);
  let session = "";
  for (const step of steps) {
    const w = step.window;
    let id: string;
    if (step.createSession) {
      // By id from here on: a name like `[Work] Refactor` is not a safe tmux target.
      [session, id] = (await tmux.run(
        ["new-session", "-d", "-P", "-F", "#{session_id} #{window_id}", "-s", w.session, "-c", step.cwd],
      )).trim().split(" ");
      if (w.sessionName) await tmux.run(["set-option", "-t", session, "@muxnexus_name", w.sessionName]);
      if (w.order) await tmux.run(["set-option", "-t", session, "@muxnexus_order", w.order]);
    } else {
      id = (await tmux.run(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `${session}:`, "-c", step.cwd])).trim();
    }
    if (w.windowName) {
      await tmux.run(["rename-window", "-t", id, "--", w.windowName]);
      await tmux.run(["set-option", "-w", "-t", id, "@muxnexus_window_name", w.windowName]);
    }
    // The note's id goes back on its window, so the note pane finds the same note.
    if (w.note) {
      await tmux.run(["set-option", "-w", "-t", id, "@muxnexus_note", w.note]);
      await tmux.run(["set-option", "-w", "-t", id, "@muxnexus_note_empty", w.noteEmpty || "1"]);
    }
    if (step.resume && opts.resume !== false) {
      // Typed rather than run as the window's command: when the agent exits the
      // tab keeps its shell, as it did before. No `--fork-session` -- this
      // continues the conversation rather than branching it.
      const { configDir, transcript } = step.resume;
      const prefix = configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ` : "env -u CLAUDE_CONFIG_DIR ";
      await tmux.type(id, `${prefix}claude --resume ${shellQuote(transcript)}`);
    }
  }
  // Mark the server, so the offer is made once. Without it, closing or renaming
  // a restored session makes the old snapshot look unfinished again -- and the
  // next run would bring back the very sessions that were just closed. The mark
  // lives in tmux, so it goes when that server does.
  try {
    await tmux.run(["set-option", "-g", RESTORED_OPTION, snap.stamp]);
  } catch (e) {
    if (!noServer(e)) throw e;
  }
  return steps;
}

const RESTORED_OPTION = "@muxnexus_restored";

/** The snapshot a restore has already run from on this tmux server, if any. */
export async function restoredFrom(tmux: Tmux): Promise<string | null> {
  try {
    return (await tmux.run(["show-options", "-gqv", RESTORED_OPTION])).trim() || null;
  } catch (e) {
    if (noServer(e)) return null;
    throw e;
  }
}

/**
 * The newest snapshot from a previous tmux server and what restoring it would
 * do, or null when there is nothing left to bring back. Computed fresh each time
 * it is asked for: at login tmux may not be up yet, and the answer becomes null
 * of its own accord once the restore has run.
 */
export async function pendingRestore(tmux: Tmux, dir: string): Promise<{ snap: Snapshot; steps: RestoreStep[] } | null> {
  if (await restoredFrom(tmux)) return null;
  const snap = pickSnapshot(await loadSnapshots(dir), (await serverStamp(tmux)) ?? "");
  if (!snap) return null;
  const steps = await planRestore(tmux, snap);
  return steps.length ? { snap, steps } : null;
}

/** What restoring `snap` into the tmux running right now would do, without doing it. */
export async function planRestore(tmux: Tmux, snap: Snapshot): Promise<RestoreStep[]> {
  return restorePlan(snap.windows, liveFrom((await panes(tmux)) ?? []), { home: homedir(), exists: existsSync });
}

/** The one line that tells you a restore is waiting, or null when none is. */
export function restoreHint(steps: readonly RestoreStep[]): string | null {
  if (steps.length === 0) return null;
  return `${steps.length} window${steps.length === 1 ? "" : "s"} from a previous session — run: muxnexus restore`;
}

/**
 * Snapshot on a timer, so shutting the laptop down costs nothing to remember.
 * A failure is logged and dropped: a snapshot is a convenience, and taking the
 * server down with it would cost far more than the snapshot is worth.
 */
export function createSnapshotter(opts: { tmux: Tmux; dir: string; intervalMs: number }): { stop: () => void } {
  const tick = () => {
    takeSnapshot(opts.tmux, opts.dir).catch((e) => {
      console.error(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const timer = setInterval(tick, opts.intervalMs);
  tick();
  return { stop: () => clearInterval(timer) };
}

export interface RestoreArgs {
  command: "snapshot" | "restore" | "snapshots";
  dryRun: boolean;
  /** An explicit snapshot file, for the reboot that happened twice without a restore. */
  path?: string;
}

const USAGE = "usage: muxnexus snapshot | restore [--dry-run] [<snapshot.json>] | snapshots";

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error(USAGE);
  if (command !== "snapshot" && command !== "restore" && command !== "snapshots") {
    throw new Error(`unknown command: ${command}\n${USAGE}`);
  }
  const args: RestoreArgs = { command, dryRun: false, path: undefined };
  for (const a of rest) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}\n${USAGE}`);
    else args.path = a;
  }
  return args;
}
