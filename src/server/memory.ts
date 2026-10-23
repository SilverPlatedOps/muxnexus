import { availableParallelism } from "node:os";
import type { MemoryMetric, SystemApp, WindowMemory } from "../shared/protocol";
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

export interface MemoryReading extends Attribution {
  at: number;
  metric: MemoryMetric;
  /** The tmux server `windows` were read from; null when tmux gave no panes. */
  tmuxServer: string | null;
}

export interface MemoryReader {
  /** Null when there is no process list to read from. */
  read(): Promise<MemoryReading | null>;
}

export type Runner = (cmd: string[], timeoutMs: number) => Promise<string>;

const APP_LIMIT = 8;
const VM_PROCESS = "com.apple.Virtualization.VirtualMachine";
const RUN_TIMEOUT_MS = 2000;

async function run(cmd: string[], timeoutMs: number): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd[0]} exited ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** `p`, or a rejection once `ms` pass without it. */
function deadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * One snapshot per reading: the process list once, then the panes, then every
 * footprint straight away, so a process is read moments after it was listed
 * and nothing is carried between readings by pid -- a pid reused later cannot
 * inherit an older process's figure. Only the VM's name is remembered, by pid,
 * since asking `lsof` every two seconds for a name that never changes is waste.
 */
export function createMemoryReader(opts: {
  panes: () => Promise<PaneRoot[]>;
  footprint: ((pid: number) => Footprint) | null;
  run?: Runner;
  now?: () => number;
  cores?: () => number;
}): MemoryReader {
  const exec = opts.run ?? run;
  const now = opts.now ?? Date.now;
  const cores = opts.cores ?? availableParallelism;
  const vmNames = new Map<number, string>();

  return {
    async read() {
      const ps = await exec(["ps", "-Ao", "pid=,ppid=,pcpu=,rss=,comm="], RUN_TIMEOUT_MS).catch(() => null);
      if (ps === null) return null;
      const procs = parsePs(ps, cores());
      // tmux answers in milliseconds; one that does not costs this reading its tabs, not the reading.
      const panes = await deadline(opts.panes(), RUN_TIMEOUT_MS).catch(() => [] as PaneRoot[]);
      const metric: MemoryMetric = opts.footprint ? "footprint" : "rss";
      const sizes = new Map<number, Footprint>(procs.map((p) => [p.pid, opts.footprint ? opts.footprint(p.pid) : { bytes: p.rss }]));

      // Arguments only where a label needs them: java inside a tab.
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      const roots = new Set(panes.map((p) => p.pid));
      const inTab = (pid: number) => {
        for (let p: number | undefined = pid, hops = 0; p !== undefined && p > 1 && hops <= procs.length; hops++) {
          if (roots.has(p)) return true;
          p = byPid.get(p)?.ppid;
        }
        return false;
      };
      const javas = procs.filter((p) => p.path.endsWith("/java") && inTab(p.pid)).map((p) => p.pid);
      const args = new Map<number, string>();
      if (javas.length > 0) {
        const out = await exec(["ps", "-o", "pid=,args=", "-p", javas.join(",")], RUN_TIMEOUT_MS).catch(() => "");
        for (const line of out.split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m) args.set(Number(m[1]), m[2]);
        }
      }

      const vms = procs.filter((p) => p.path.endsWith(`/${VM_PROCESS}`)).map((p) => p.pid);
      for (const pid of vmNames.keys()) if (!vms.includes(pid)) vmNames.delete(pid);
      for (const pid of vms) {
        if (vmNames.has(pid)) continue;
        const out = await exec(["lsof", "-Fn", "-p", String(pid)], RUN_TIMEOUT_MS).catch(() => null);
        if (out === null) continue; // asked again next time
        vmNames.set(pid, vmName(out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1))));
      }

      const a = attribute(procs, panes, (pid) => sizes.get(pid) ?? { error: "gone" }, {
        argsOf: (pid) => args.get(pid),
        vmNameOf: (pid) => vmNames.get(pid),
      });
      return { ...a, at: now(), metric, tmuxServer: panes[0]?.server ?? null };
    },
  };
}

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
