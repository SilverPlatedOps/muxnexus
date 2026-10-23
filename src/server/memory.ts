import type { SystemApp, WindowMemory } from "../shared/protocol";
import type { Footprint } from "./footprint";
import { appOf } from "./system";
import type { PaneRoot } from "./tmux";

/**
 * Which tab, or which app, is holding the memory. Every process is charged to
 * the nearest tmux pane above it in the process tree -- the pane's shell and
 * everything it started -- and the rest to the `.app` it lives in. Everything is
 * summed before anything is ranked or cut, so a tab's figure and an app's are
 * whole, and `claude` or `java` running in a tab is that tab's, not an app.
 *
 * What a tab started that left its tree (`open -a`, a daemon, Docker's VM) is
 * not the tab's: nothing on the Mac records who asked for it.
 */

export interface Proc {
  pid: number;
  ppid: number;
  /** Share of the whole machine, 0-100. */
  cpu: number;
  /** Resident memory, bytes. */
  rss: number;
  path: string;
}

export interface Attribution {
  /** The largest `appLimit` by memory and the busiest `appLimit` by CPU. */
  apps: SystemApp[];
  /** Every window that has a process. */
  windows: WindowMemory[];
  /** Every process's CPU, listed or not. */
  appsCpu: number;
}

const APP_LIMIT = 8;
const VM_PROCESS = "com.apple.Virtualization.VirtualMachine";

/** `ps -Ao pid=,ppid=,pcpu=,rss=,comm=`. `comm` is the full path and may hold spaces; `ps` counts one core as 100%. */
export function parsePs(text: string, cores: number): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]) / Math.max(1, cores), rss: Number(m[4]) * 1024, path: m[5].trim() });
  }
  return out;
}

/** What a process is called in a tab's breakdown. */
export function processLabel(path: string, args?: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  // Claude Code installs each version as its own binary, named by its number.
  if (path.includes("/claude/versions/")) return "claude";
  if (base === "java" && args && /surefire|maven/i.test(args)) return "java · maven tests";
  return base;
}

/**
 * Whose VM a Virtualization process is, from the disk images it has open: a
 * file in the host's own data folder is proof, where an app merely running
 * alongside it is not.
 */
export function vmName(openPaths: readonly string[]): string {
  if (openPaths.some((p) => p.includes("/rancher-desktop/"))) return "Docker VM · Rancher";
  if (openPaths.some((p) => p.includes("/com.docker.docker/"))) return "Docker VM · Docker Desktop";
  if (openPaths.some((p) => p.includes("/.colima/"))) return "Docker VM · Colima";
  return "Linux VM";
}

export function attribute(
  procs: readonly Proc[],
  panes: readonly PaneRoot[],
  memOf: (pid: number) => Footprint,
  opts: { argsOf?: (pid: number) => string | undefined; vmNameOf?: (pid: number) => string | undefined; appLimit?: number } = {},
): Attribution {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rootOf = new Map(panes.map((p) => [p.pid, p.windowId]));
  const windowOf = new Map<number, string | null>();
  const owner = (pid: number): string | null => {
    const path: number[] = [];
    let p: number | undefined = pid;
    let found: string | null = null;
    while (p !== undefined && p > 1) {
      if (windowOf.has(p)) { found = windowOf.get(p)!; break; }
      path.push(p);
      if (rootOf.has(p)) { found = rootOf.get(p)!; break; }
      const next: number | undefined = byPid.get(p)?.ppid;
      p = next === p ? undefined : next;
      if (path.length > procs.length) break; // a cycle in a torn snapshot
    }
    for (const q of path) windowOf.set(q, found);
    return found;
  };

  const windows = new Map<string, WindowMemory & { partMap: Map<string, { bytes: number; readable: boolean; cpu: number }> }>();
  const apps = new Map<string, SystemApp & { readable: number; largest: number }>();
  let appsCpu = 0;
  for (const p of procs) {
    appsCpu += p.cpu;
    const fp = memOf(p.pid);
    if ("error" in fp && fp.error === "gone") continue;
    const bytes = "bytes" in fp ? fp.bytes : null;
    const w = owner(p.pid);
    if (w !== null) {
      const win = windows.get(w) ?? { windowId: w, bytes: 0, processes: 0, unreadable: 0, cpu: 0, parts: [], partMap: new Map() };
      win.bytes += bytes ?? 0;
      win.processes++;
      if (bytes === null) win.unreadable++;
      win.cpu += p.cpu;
      const label = processLabel(p.path, p.path.endsWith("/java") ? opts.argsOf?.(p.pid) : undefined);
      const part = win.partMap.get(label) ?? { bytes: 0, readable: false, cpu: 0 };
      part.bytes += bytes ?? 0;
      part.readable ||= bytes !== null;
      part.cpu += p.cpu;
      win.partMap.set(label, part);
      windows.set(w, win);
      continue;
    }
    const isVm = p.path.endsWith(`/${VM_PROCESS}`);
    const name = (isVm ? opts.vmNameOf?.(p.pid) : undefined) ?? appOf(p.path);
    const app = apps.get(name) ?? { name, cpu: 0, mem: 0, procs: 0, top: "", readable: 0, largest: -1 };
    app.mem += bytes ?? 0;
    app.procs++;
    if (bytes !== null) app.readable++;
    app.cpu += p.cpu;
    if (p.cpu > app.largest) {
      app.largest = p.cpu;
      app.top = p.path.slice(p.path.lastIndexOf("/") + 1);
    }
    apps.set(name, app);
  }

  const all: SystemApp[] = [...apps.values()].map(({ readable, largest: _, ...a }) => (readable === 0 ? { ...a, unreadable: true } : a));
  const limit = opts.appLimit ?? APP_LIMIT;
  const byCpu = [...all].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, limit);
  const byMem = [...all].filter((a) => !a.unreadable).sort((a, b) => b.mem - a.mem).slice(0, limit);
  return {
    apps: [...new Set([...byCpu, ...byMem])],
    windows: [...windows.values()].map(({ partMap, ...w }) => ({
      ...w,
      parts: [...partMap].map(([name, v]) => ({ name, bytes: v.readable ? v.bytes : null, cpu: v.cpu }))
        .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || b.cpu - a.cpu),
    })),
    appsCpu,
  };
}
