// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { CpuInfo } from "node:os";
import type { MemSplit } from "../shared/protocol";

/**
 * Reading the machine for the system overview: the parsers for what every Mac
 * has -- `vm_stat`, `sysctl`, the CPU counters -- with no sudo, so no
 * temperatures or GPU, which only `powermetrics` as root can see. The sampler
 * (vitals.ts) and the memory reader (memory.ts) run the tools; each parser
 * stands alone, and output it does not recognise gives no answer rather than a
 * wrong one.
 */

/** `kern.memorystatus_vm_pressure_level`, the kernel's own verdict that Activity Monitor colours its graph by. */
const PRESSURE: Record<string, "normal" | "warning" | "critical"> = { "1": "normal", "2": "warning", "4": "critical" };

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

/** The `vm_stat` counters the memory split and the swap rate are made of, in pages. */
export interface VmCounters {
  /** Bytes. */
  pageSize: number;
  anonymous: number;
  purgeable: number;
  wired: number;
  compressor: number;
  /** Since boot. XNU adds each written swap segment's size over the page size, so this times the page size is bytes written to swap. */
  swapouts: number;
}

export function parseVmCounters(text: string): VmCounters | undefined {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return undefined;
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  const c = {
    pageSize,
    anonymous: pages("Anonymous pages"),
    purgeable: pages("Pages purgeable"),
    wired: pages("Pages wired down"),
    compressor: pages("Pages occupied by compressor"),
    swapouts: pages("Swapouts"),
  };
  return Object.values(c).every(Number.isFinite) ? c : undefined;
}

/**
 * The Mem bar's four parts. Each measured part is held at zero or above, and a
 * reading whose parts overrun the total -- counters read a moment apart -- is
 * scaled down to fit, so the bar never overflows and "available" is never negative.
 */
export function memSplit(c: VmCounters, total: number): MemSplit {
  let apps = Math.max(0, c.anonymous - c.purgeable) * c.pageSize;
  let system = Math.max(0, c.wired) * c.pageSize;
  let compressed = Math.max(0, c.compressor) * c.pageSize;
  const sum = apps + system + compressed;
  if (sum > total) {
    const k = total / sum;
    apps *= k;
    system *= k;
    compressed *= k;
  }
  return { apps, system, compressed, available: Math.max(0, total - apps - system - compressed), total };
}

/** `sysctl -n kern.boottime`: `{ sec = 1792468718, usec = 801966 } Tue Oct 20 ...`, as milliseconds. */
export function parseBootTime(text: string): number | undefined {
  const sec = Number(/sec = (\d+)/.exec(text)?.[1]);
  return sec ? sec * 1000 : undefined;
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
