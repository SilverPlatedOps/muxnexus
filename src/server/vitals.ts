import { cpus as osCpus, loadavg as osLoadavg, totalmem as osTotalmem, type CpuInfo } from "node:os";
import type { MemSplit, RatePoint, SystemStats } from "../shared/protocol";
import { INITIAL_LEVEL, stepLevel, type LevelState, type Pressure } from "./levels";
import { cpuPercent, memSplit, parseBattery, parseBootTime, parsePressure, parseSwap, parseVmCounters, parseVmStat } from "./system";

/**
 * The cheap readings, taken whether or not anyone is looking: `vm_stat`, one
 * `sysctl`, the CPU counters and now and then the battery. This is the one
 * owner of the swap counter, so the rate, its five-minute history and the
 * alarm level come from one place; everything costly (the process list,
 * footprints) is the memory reader's, and runs only on demand.
 *
 * A rate is the bytes written to swap over the time that really passed. A gap
 * longer than `MAX_GAP_MS` -- sleep, a stall, a failed read -- makes the next
 * delta unknown rather than a spike or a zero, and the level never counts
 * unobserved time as quiet.
 */

export type Runner = (cmd: string[], timeoutMs: number) => Promise<string>;

export interface Vitals {
  at: number;
  cpu?: number;
  load: [number, number, number];
  mem?: { used: number; total: number; pressure?: Pressure };
  split?: MemSplit;
  swap?: { used: number; total: number };
  battery?: SystemStats["battery"];
  /** Bytes a second written to swap since the sample before, or null when that could not be trusted. */
  rate: number | null;
  /** Bytes written to swap since boot. */
  written: number | null;
  /** When the Mac booted, ms. */
  bootTime: number | null;
}

export interface VitalsSampler {
  start(): void;
  stop(): void;
  /** Two seconds between samples while someone has the panel open, five otherwise. */
  setFast(on: boolean): void;
  /** Take a sample now; one already under way is joined rather than doubled. */
  sampleNow(): Promise<void>;
  latest(): Vitals | null;
  history(): RatePoint[];
  level(): LevelState;
  /** True if `episode` is the current one and was not yet acknowledged. */
  acknowledge(episode: number): boolean;
  /** Told after every sample and every acknowledgement; returns its own unsubscribe. */
  onSample(cb: () => void): () => void;
}

export const SLOW_MS = 5000;
export const FAST_MS = 2000;
/** A delta spanning more than three slow periods is not a rate. */
export const MAX_GAP_MS = 15_000;
export const HISTORY_MS = 300_000;
const RUN_TIMEOUT_MS = 2000;
/**
 * A sample whose own tools took longer than this -- the Mac slept, or the
 * machine is thrashing -- read its counters at a moment nobody knows: its rate
 * is unknown rather than a delta divided by the wrong time.
 */
const SLOW_SAMPLE_MS = 1000;
/** The battery moves by the minute; asking `pmset` on every sample would say nothing new. */
const BATTERY_MS = 30_000;
/** A CPU sample older than this is not a "previous" reading: the delta would average over the whole gap. */
const CPU_STALE_MS = 10_000;
/** Nor is one this fresh: counters a moment apart read 0% or 100%. The older sample is kept instead. */
const CPU_MIN_MS = 1_000;

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

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function createVitalsSampler(deps: {
  run?: Runner;
  now?: () => number;
  cpus?: () => CpuInfo[];
  totalmem?: () => number;
  loadavg?: () => [number, number, number];
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}): VitalsSampler {
  const exec = deps.run ?? run;
  const now = deps.now ?? Date.now;
  const cpus = deps.cpus ?? osCpus;
  const totalmem = deps.totalmem ?? osTotalmem;
  const loadavg = deps.loadavg ?? (() => osLoadavg() as [number, number, number]);
  const schedule = deps.schedule ?? defaultSchedule;

  let latest: Vitals | null = null;
  let history: RatePoint[] = [];
  let level = INITIAL_LEVEL;
  let counted: { at: number; swapouts: number; pageSize: number; boot: number | undefined } | null = null;
  let prevCpu: { at: number; cpus: CpuInfo[] } | null = null;
  let battery: { at: number; value: SystemStats["battery"] } | null = null;
  let sampling: Promise<void> | null = null;
  let started = false;
  let fast = false;
  let cancel: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const attempt = <T>(p: Promise<T>) => p.catch(() => undefined);
  const tell = () => { for (const cb of listeners) cb(); };

  function arm() {
    cancel?.();
    cancel = started ? schedule(() => { if (started) void sampleNow().finally(arm); }, fast ? FAST_MS : SLOW_MS) : null;
  }

  async function sample(): Promise<void> {
    const started = now();
    const batteryDue = !battery || started - battery.at >= BATTERY_MS;
    const [vm, sys, batt] = await Promise.all([
      attempt(exec(["vm_stat"], RUN_TIMEOUT_MS)),
      attempt(exec(["sysctl", "-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level", "kern.boottime"], RUN_TIMEOUT_MS)),
      batteryDue ? attempt(exec(["pmset", "-g", "batt"], RUN_TIMEOUT_MS)) : Promise.resolve(undefined),
    ]);
    // Timed after the tools ran, not before: their counters are from then.
    const at = now();
    const slow = at - started > SLOW_SAMPLE_MS;
    if (batteryDue) battery = { at, value: batt === undefined ? undefined : parseBattery(batt) };

    const counters = vm === undefined ? undefined : parseVmCounters(vm);
    const boot = sys === undefined ? undefined : parseBootTime(sys);
    let rate: number | null = null;
    if (counters) {
      const prev = counted;
      if (!slow && prev && prev.boot === boot && prev.pageSize === counters.pageSize && counters.swapouts >= prev.swapouts
        && at > prev.at && at - prev.at <= MAX_GAP_MS) {
        rate = ((counters.swapouts - prev.swapouts) * counters.pageSize) / ((at - prev.at) / 1000);
      }
      counted = { at, swapouts: counters.swapouts, pageSize: counters.pageSize, boot };
    }
    history = [...history.filter((p) => p.at >= at - HISTORY_MS), { at, rate }];

    const sample = cpus();
    const age = prevCpu ? at - prevCpu.at : Infinity;
    const cpu = prevCpu && age >= CPU_MIN_MS && age <= CPU_STALE_MS ? cpuPercent(prevCpu.cpus, sample) : undefined;
    if (age >= CPU_MIN_MS) prevCpu = { at, cpus: sample };

    const total = totalmem();
    const used = vm === undefined ? undefined : parseVmStat(vm);
    const pressure = sys === undefined ? undefined : parsePressure(sys);
    const swap = sys === undefined ? undefined : parseSwap(sys);
    level = stepLevel(level, at, history, pressure);
    latest = {
      at,
      ...(cpu === undefined ? {} : { cpu }),
      load: loadavg(),
      ...(used === undefined ? {} : { mem: { used: Math.min(used, total), total, ...(pressure ? { pressure } : {}) } }),
      ...(counters ? { split: memSplit(counters, total) } : {}),
      ...(swap ? { swap } : {}),
      ...(battery?.value ? { battery: battery.value } : {}),
      rate,
      written: counters ? counters.swapouts * counters.pageSize : null,
      bootTime: boot ?? null,
    };
    tell();
  }

  function sampleNow(): Promise<void> {
    sampling ??= sample().finally(() => { sampling = null; });
    return sampling;
  }

  return {
    start() {
      started = true;
      arm();
    },
    stop() {
      started = false;
      cancel?.();
      cancel = null;
    },
    setFast(on) {
      if (on === fast) return;
      fast = on;
      if (started) arm();
    },
    sampleNow,
    latest: () => latest,
    history: () => history,
    level: () => level,
    acknowledge(episode) {
      if (episode === 0 || episode !== level.episode || level.acked) return false;
      level = { ...level, acked: true };
      tell();
      return true;
    },
    onSample(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}
