// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { readFile as fsReadFile } from "node:fs/promises";
import { cpus as osCpus, loadavg as osLoadavg, totalmem as osTotalmem, type CpuInfo } from "node:os";
import type { MemSplit, RatePoint } from "../shared/protocol";
import { INITIAL_LEVEL, stepLevel, type LevelState, type Pressure } from "./levels";
import {
  cpuPercent, linuxSplit, linuxSwap, memSplit, parseBootTime, parseBtime, parseMeminfo, parsePressure, parseSwap,
  parseSwapouts, parseVmCounters, parseVmStat,
} from "./system";

/**
 * The cheap readings, taken whether or not anyone is looking: `vm_stat`, one
 * `sysctl` and the CPU counters (on Linux, three files in `/proc`). This is the one
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
  /** Bytes a second written to swap since the sample before, or null when that could not be trusted. */
  rate: number | null;
  /** Bytes written to swap since boot. */
  written: number | null;
  /** When the machine booted, ms. */
  bootTime: number | null;
}

/** One reading of memory and swap, however this OS gives it. A figure that could not be read is left out. */
interface Reading {
  used?: number;
  split?: MemSplit;
  swap?: { used: number; total: number };
  /** The kernel's own verdict. macOS only: Linux has no equivalent the panel could colour by. */
  pressure?: Pressure;
  boot?: number;
  /** Pages written to swap since boot, and the size they count in. */
  swapouts?: { pages: number; pageSize: number };
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
  /** `/proc` files, on Linux. */
  readFile?: (path: string) => Promise<string>;
  platform?: NodeJS.Platform;
  now?: () => number;
  cpus?: () => CpuInfo[];
  totalmem?: () => number;
  loadavg?: () => [number, number, number];
  schedule?: (fn: () => void, ms: number) => () => void;
} = {}): VitalsSampler {
  const exec = deps.run ?? run;
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  const linux = (deps.platform ?? process.platform) === "linux";
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
  let sampling: Promise<void> | null = null;
  let started = false;
  let fast = false;
  let cancel: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const attempt = <T>(p: Promise<T>) => p.catch(() => undefined);
  // Each listener on its own: one that throws must not fail the sample, or
  // leave the rest unheard -- this loop runs for as long as the server does.
  const tell = () => {
    for (const cb of listeners) {
      try { cb(); } catch (e) { console.error("vitals listener:", e); }
    }
  };

  async function readMac(): Promise<Reading> {
    const [vm, sys] = await Promise.all([
      attempt(exec(["vm_stat"], RUN_TIMEOUT_MS)),
      attempt(exec(["sysctl", "-n", "vm.swapusage", "kern.memorystatus_vm_pressure_level", "kern.boottime"], RUN_TIMEOUT_MS)),
    ]);
    const counters = vm === undefined ? undefined : parseVmCounters(vm);
    const used = vm === undefined ? undefined : parseVmStat(vm);
    const pressure = sys === undefined ? undefined : parsePressure(sys);
    const swap = sys === undefined ? undefined : parseSwap(sys);
    const boot = sys === undefined ? undefined : parseBootTime(sys);
    return {
      ...(used === undefined ? {} : { used }),
      ...(counters ? { split: memSplit(counters, totalmem()), swapouts: { pages: counters.swapouts, pageSize: counters.pageSize } } : {}),
      ...(swap ? { swap } : {}),
      ...(pressure ? { pressure } : {}),
      ...(boot === undefined ? {} : { boot }),
    };
  }

  /** `pswpout` counts pages; asked of `getconf` once, and 4 KB if it will not say. */
  let pageSize: Promise<number> | null = null;
  async function readLinux(): Promise<Reading> {
    pageSize ??= exec(["getconf", "PAGESIZE"], RUN_TIMEOUT_MS).then((out) => Number(out.trim()) || 4096, () => 4096);
    const [mem, vmstat, stat, page] = await Promise.all([
      attempt(readFile("/proc/meminfo")),
      attempt(readFile("/proc/vmstat")),
      attempt(readFile("/proc/stat")),
      pageSize,
    ]);
    const m = mem === undefined ? undefined : parseMeminfo(mem);
    const split = m ? linuxSplit(m) : undefined;
    const swap = m ? linuxSwap(m) : undefined;
    const pages = vmstat === undefined ? undefined : parseSwapouts(vmstat);
    const boot = stat === undefined ? undefined : parseBtime(stat);
    return {
      ...(split ? { used: split.total - split.available, split } : {}),
      ...(swap ? { swap } : {}),
      ...(pages === undefined ? {} : { swapouts: { pages, pageSize: page } }),
      ...(boot === undefined ? {} : { boot }),
    };
  }

  function arm() {
    cancel?.();
    cancel = started ? schedule(() => { if (started) void sampleNow().catch(() => {}).finally(arm); }, fast ? FAST_MS : SLOW_MS) : null;
  }

  async function sample(): Promise<void> {
    const started = now();
    const r = await (linux ? readLinux() : readMac());
    // Timed after the tools ran, not before: their counters are from then.
    const at = now();
    const slow = at - started > SLOW_SAMPLE_MS;

    const counters = r.swapouts;
    const boot = r.boot;
    let rate: number | null = null;
    if (counters) {
      const prev = counted;
      if (!slow && prev && prev.boot === boot && prev.pageSize === counters.pageSize && counters.pages >= prev.swapouts
        && at > prev.at && at - prev.at <= MAX_GAP_MS) {
        rate = ((counters.pages - prev.swapouts) * counters.pageSize) / ((at - prev.at) / 1000);
      }
      counted = { at, swapouts: counters.pages, pageSize: counters.pageSize, boot };
    }
    history = [...history.filter((p) => p.at >= at - HISTORY_MS), { at, rate }];

    const sample = cpus();
    const age = prevCpu ? at - prevCpu.at : Infinity;
    const cpu = prevCpu && age >= CPU_MIN_MS && age <= CPU_STALE_MS ? cpuPercent(prevCpu.cpus, sample) : undefined;
    if (age >= CPU_MIN_MS) prevCpu = { at, cpus: sample };

    const total = totalmem();
    const { used, pressure, swap, split } = r;
    level = stepLevel(level, at, history, pressure);
    latest = {
      at,
      ...(cpu === undefined ? {} : { cpu }),
      load: loadavg(),
      ...(used === undefined ? {} : { mem: { used: Math.min(used, total), total, ...(pressure ? { pressure } : {}) } }),
      ...(split ? { split } : {}),
      ...(swap ? { swap } : {}),
      rate,
      written: counters ? counters.pages * counters.pageSize : null,
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
