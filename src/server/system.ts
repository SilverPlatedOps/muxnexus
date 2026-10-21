import { cpus as osCpus, loadavg, totalmem, type CpuInfo } from "node:os";
import type { SystemApp, SystemStats } from "../shared/protocol";

/**
 * A small btop for the notes panel: how busy the machine is and which apps are
 * making it so. macOS only, read with the tools every Mac has -- no sudo, so no
 * temperatures or GPU, which only `powermetrics` as root can see.
 *
 * Nothing here runs unless a browser has the panel open (server.ts), and each
 * reading stands alone: a tool that is missing or prints something unexpected
 * leaves its row out rather than failing the rest.
 */

export type Runner = (cmd: string[]) => Promise<string>;

export interface SystemReader {
  read(): Promise<SystemStats>;
}

/** How many apps the panel lists, by each of the measures it can sort on. */
const TOP_APPS = 5;
/** The battery moves by the minute; asking `pmset` every two seconds would say nothing new. */
const BATTERY_MS = 30_000;
/**
 * A CPU sample older than this is not a "previous" reading but the last time
 * anyone looked: the delta would average over however long the panel was shut.
 */
const CPU_STALE_MS = 10_000;
/**
 * Nor is one this fresh: two reads a moment apart (the timer, and a client
 * opening the box) leave counters that have barely moved, and a delta of a few
 * ticks reads 0% or 100%. The older sample is kept for the next read instead.
 */
const CPU_MIN_MS = 1_000;
/** `kern.memorystatus_vm_pressure_level`, the kernel's own verdict that Activity Monitor colours its graph by. */
const PRESSURE: Record<string, "normal" | "warning" | "critical"> = { "1": "normal", "2": "warning", "4": "critical" };

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}`);
  return out;
}

/**
 * Whole-machine busy share between two `os.cpus()` samples, 0-100. The counters
 * only ever grow, so a core that reports less than before (a hot-plugged CPU, a
 * reordered list) gives no answer rather than a negative one.
 */
export function cpuPercent(before: CpuInfo[], after: CpuInfo[]): number | undefined {
  if (before.length !== after.length || before.length === 0) return undefined;
  let busy = 0;
  let total = 0;
  for (let i = 0; i < after.length; i++) {
    const a = before[i].times;
    const b = after[i].times;
    const idle = b.idle - a.idle;
    const all = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    if (idle < 0 || all < 0) return undefined;
    busy += all - idle;
    total += all;
  }
  return total > 0 ? (busy / total) * 100 : undefined;
}

/**
 * Memory in use the way Activity Monitor counts it: app memory (anonymous pages
 * nobody marked purgeable), wired, and what the compressor holds. File cache is
 * left out -- the kernel gives it back the moment anything asks. The page size
 * comes from the header: it is 16 KB on Apple Silicon, 4 KB on Intel.
 */
export function parseVmStat(text: string): number | undefined {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!page) return undefined;
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
  return Number.isFinite(used) ? used * page : undefined;
}

/** `total = 13312.00M  used = 11735.12M  free = 1576.88M  (encrypted)`, in bytes. */
export function parseSwap(text: string): { used: number; total: number } | undefined {
  const size = (key: string) => {
    const m = new RegExp(`${key} = ([\\d.]+)([KMG])`).exec(text);
    if (!m) return NaN;
    return Number(m[1]) * 1024 ** ({ K: 1, M: 2, G: 3 } as const)[m[2] as "K" | "M" | "G"];
  };
  const used = size("used");
  const total = size("total");
  // No swap file yet reads `total = 0.00M`: nothing worth a bar.
  return Number.isFinite(used) && total > 0 ? { used, total } : undefined;
}

/**
 * The kernel's memory pressure, from the same `sysctl` as the swap. Used memory
 * alone cannot say this: macOS fills memory with cache on purpose, and swap
 * grows new files as the old fill, so neither "nearly full" is trouble on its
 * own. The pressure level is the kernel saying it is struggling.
 */
export function parsePressure(text: string): "normal" | "warning" | "critical" | undefined {
  return PRESSURE[/^\s*([124])\s*$/m.exec(text)?.[1] ?? ""];
}

/**
 * `pmset -g batt`: the percentage and what the power is doing. A Mac with no
 * battery prints only the "drawing from" line, which is no battery at all
 * rather than a broken one. "AC attached; not charging" is a full-enough battery
 * on a charger that is holding it there.
 */
export function parseBattery(text: string): SystemStats["battery"] {
  const m = /(\d+)%;\s*([^;]+)/.exec(text);
  if (!m) return undefined;
  const state = m[2].trim();
  return { percent: Number(m[1]), state: state === "AC attached" ? "on AC" : state };
}

/**
 * The app a process belongs to: the outermost `.app` on its path, so Arc's
 * dozen "Browser Helper"s and Claude's helpers each count as their app, the way
 * Activity Monitor groups them. Anything outside a bundle -- `java`, a daemon --
 * is its own name. A bundle has `Contents` inside it; a project folder that
 * merely ends in `.app` does not, and does not make its processes one app.
 */
export function appOf(path: string): string {
  const parts = path.split("/");
  const bundle = parts.find((part, i) => part.endsWith(".app") && parts[i + 1] === "Contents");
  if (bundle) return bundle.slice(0, -".app".length);
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * `ps -Ao pid,pcpu,rss,comm` grouped by app: the busiest `limit` by CPU and the
 * largest `limit` by memory, so the panel can sort on either without asking
 * again. `total` is every process's CPU, listed or not -- what the CPU line has
 * that no app accounts for is the kernel's.
 *
 * `comm` is the full executable path and may hold spaces ("Claude Helper"), so
 * it is whatever follows the third field. `ps` counts one core as 100%;
 * dividing by the cores puts each app on the same scale as the CPU line.
 */
export function topApps(text: string, cores: number, limit: number = TOP_APPS): { apps: SystemApp[]; total: number } {
  const apps = new Map<string, SystemApp & { largest: number }>();
  let total = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue; // the header, a blank last line
    const cpu = Number(m[2]) / Math.max(1, cores);
    const mem = Number(m[3]) * 1024;
    total += cpu;
    const path = m[4].trim();
    const name = appOf(path);
    const app = apps.get(name) ?? { name, cpu: 0, mem: 0, procs: 0, top: "", largest: -1 };
    app.cpu += cpu;
    app.mem += mem;
    app.procs++;
    if (cpu > app.largest) {
      app.largest = cpu;
      app.top = path.slice(path.lastIndexOf("/") + 1);
    }
    apps.set(name, app);
  }
  const all = [...apps.values()].map(({ largest: _, ...app }) => app);
  const byCpu = [...all].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, limit);
  const byMem = [...all].sort((a, b) => b.mem - a.mem).slice(0, limit);
  return { apps: [...new Set([...byCpu, ...byMem])], total };
}

export function createSystemReader(opts: { run?: Runner; cpus?: () => CpuInfo[]; now?: () => number } = {}): SystemReader {
  const exec = opts.run ?? run;
  const cpus = opts.cpus ?? osCpus;
  const now = opts.now ?? Date.now;
  let prev: { at: number; cpus: CpuInfo[] } | null = null;
  let battery: { at: number; value: SystemStats["battery"] } | null = null;

  const attempt = <T>(p: Promise<T>) => p.catch(() => undefined);

  return {
    async read() {
      const at = now();
      const sample = cpus();
      const age = prev ? at - prev.at : Infinity;
      const cpu = prev && age >= CPU_MIN_MS && age <= CPU_STALE_MS ? cpuPercent(prev.cpus, sample) : undefined;
      if (age >= CPU_MIN_MS) prev = { at, cpus: sample };

      const batteryDue = !battery || at - battery.at >= BATTERY_MS;
      const [vm, swap, ps, batt] = await Promise.all([
        attempt(exec(["vm_stat"])),
        attempt(exec(["sysctl", "-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level"])),
        attempt(exec(["ps", "-Ao", "pid,pcpu,rss,comm"])),
        batteryDue ? attempt(exec(["pmset", "-g", "batt"])) : Promise.resolve(undefined),
      ]);
      if (batteryDue) battery = { at, value: batt === undefined ? undefined : parseBattery(batt) };

      const total = totalmem();
      const used = vm === undefined ? undefined : parseVmStat(vm);
      const level = swap === undefined ? undefined : parsePressure(swap);
      const listed = ps === undefined ? undefined : topApps(ps, sample.length);
      return {
        ...(cpu === undefined ? {} : { cpu }),
        load: loadavg() as [number, number, number],
        ...(used === undefined ? {} : { mem: { used: Math.min(used, total), total, ...(level ? { pressure: level } : {}) } }),
        ...(swap === undefined ? {} : { swap: parseSwap(swap) }),
        ...(battery?.value ? { battery: battery.value } : {}),
        apps: listed?.apps ?? [],
        ...(listed ? { appsCpu: listed.total } : {}),
      };
    },
  };
}
