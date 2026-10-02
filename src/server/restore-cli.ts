/**
 * `muxnexus snapshot | restore | snapshots` -- the command line over restore.ts.
 *
 * The socket comes from the same resolver the server uses, so the command and
 * the server always read the same tmux.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { CMUX_TMUX_SOCKET, resolveSocketPath } from "./main";
import {
  applyRestore, loadSnapshots, parseRestoreArgs, pickSnapshot, planRestore, type RestoreStep, serverStamp,
  type Snapshot, snapshotDir, takeSnapshot,
} from "./restore";
import { Tmux } from "./tmux";

const short = (p: string) => (p.startsWith(homedir()) ? `~/${relative(homedir(), p)}` : p);

function describe(step: RestoreStep): string {
  const name = step.window.windowName ? `${step.window.windowName} -- ` : "";
  const what = step.resume ? `claude --resume (${short(step.resume.configDir ?? join(homedir(), ".claude"))})` : "shell";
  return `  ${step.window.index}: ${name}${what} in ${short(step.cwd)}${step.window.note ? "  [note]" : ""}`;
}

/** Print a plan grouped the way the sessions are rebuilt. */
function printPlan(steps: readonly RestoreStep[]): void {
  if (steps.length === 0) {
    console.log("\nnothing to do: it is all already there");
    return;
  }
  let session = "";
  for (const step of steps) {
    if (step.window.session !== session) {
      session = step.window.session;
      console.log(`\n${session}${step.createSession ? "" : "  (already exists: windows are added to it)"}`);
    }
    console.log(describe(step));
  }
}

async function cmdSnapshot(tmux: Tmux, dir: string): Promise<number> {
  const snap = await takeSnapshot(tmux, dir);
  if (!snap) {
    console.log("no tmux server running: nothing to snapshot");
    return 1;
  }
  const sessions = new Set(snap.windows.map((w) => w.session)).size;
  const conversations = snap.windows.filter((w) => w.conversation).length;
  console.log(
    `${snap.windows.length} windows in ${sessions} sessions, ${conversations} conversations`
    + ` -> ${short(dir)}/${snap.stamp}.json`,
  );
  return 0;
}

async function cmdList(tmux: Tmux, dir: string): Promise<number> {
  const snaps = (await loadSnapshots(dir)).sort((a, b) => b.taken.localeCompare(a.taken));
  if (snaps.length === 0) {
    console.log(`no snapshots in ${short(dir)}`);
    return 0;
  }
  const live = await serverStamp(tmux);
  for (const s of snaps) {
    const sessions = new Set(s.windows.map((w) => w.session)).size;
    const mine = s.stamp === live ? "  (this tmux server)" : "";
    console.log(`${s.taken}  ${s.windows.length} windows, ${sessions} sessions  ${short(s.path)}${mine}`);
  }
  return 0;
}

async function cmdRestore(tmux: Tmux, dir: string, dryRun: boolean, path?: string): Promise<number> {
  const snap = path
    ? ((await Bun.file(path).json()) as Snapshot)
    : pickSnapshot(await loadSnapshots(dir), (await serverStamp(tmux)) ?? "");
  if (!snap) {
    console.log("nothing to restore: no snapshot from a previous tmux server");
    return 0;
  }
  console.log(`snapshot from ${snap.taken}${dryRun ? "  (dry run: nothing is changed)" : ""}`);
  const steps = dryRun ? await planRestore(tmux, snap) : await applyRestore(tmux, snap);
  printPlan(steps);
  if (!dryRun && steps.length) console.log(`\nrestored ${steps.length} windows`);
  return 0;
}

let args;
try {
  args = parseRestoreArgs(Bun.argv.slice(2));
} catch (e) {
  // A mistyped command gets the usage line, not a stack trace.
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
const dir = snapshotDir();
const tmux = new Tmux(undefined, resolveSocketPath(undefined, existsSync(CMUX_TMUX_SOCKET)));

process.exit(
  args.command === "snapshot"
    ? await cmdSnapshot(tmux, dir)
    : args.command === "snapshots"
      ? await cmdList(tmux, dir)
      : await cmdRestore(tmux, dir, args.dryRun, args.path),
);
