import type { SystemApp, SystemStats } from "../shared/protocol";
import { meter } from "./usage";

/**
 * The system overview at the foot of the notes panel: CPU over the last minute,
 * memory, swap, battery, and the apps doing the most. The server only reads the
 * machine while this is open (`{t:"system", on}`), so the CPU history is this
 * view's own and starts again each time it opens.
 *
 * It is meant to say when something wants doing, not just to report: a figure
 * in trouble turns yellow then red, and while memory is the trouble the Mem
 * column asks to be sorted on, which names what is holding it.
 */

/** Thirty readings, two seconds apart: the last minute. */
const HISTORY = 30;
const SHOWN_APPS = 5;
const SORT_KEY = "muxnexus.system.sort";
const COLLAPSED_KEY = "muxnexus.system.collapsed";
const SVG = "http://www.w3.org/2000/svg";

export type AppSort = "cpu" | "mem";
export type Pressure = "" | "warning" | "critical";

/**
 * How close CPU is to costing you something; and memory's, on the rare Mac
 * whose kernel does not say (`memPressure`). Ours, where the quota panel takes
 * each provider's word, because CPU has nobody to judge it.
 */
export function pressure(percent: number): Pressure {
  if (percent >= 90) return "critical";
  if (percent >= 80) return "warning";
  return "";
}

/**
 * Memory is the kernel's call, as in Activity Monitor: macOS keeps memory full
 * of cache on purpose, so a nearly full bar is no sign of trouble on its own.
 */
export function memPressure(mem: NonNullable<SystemStats["mem"]>): Pressure {
  if (mem.pressure) return mem.pressure === "normal" ? "" : mem.pressure;
  return pressure((mem.used / mem.total) * 100);
}

/** A battery is only a worry while it is running down. */
export function batteryPressure(b: NonNullable<SystemStats["battery"]>): Pressure {
  if (b.state !== "discharging") return "";
  if (b.percent <= 10) return "critical";
  if (b.percent <= 20) return "warning";
  return "";
}

/**
 * The readings as an area, newest at the right edge of a `slots`-wide box with
 * 0-100 up the side. Fixed at 0-100 rather than fitted to the readings: a
 * scale that stretched would draw 3% and 30% as the same mountain.
 */
export function sparkPath(values: readonly number[], slots: number = HISTORY): { area: string; line: string } {
  if (values.length < 2) return { area: "", line: "" };
  const first = slots - values.length;
  const pts = values.map((v, i) => `${first + i},${(100 - Math.max(0, Math.min(100, v))).toFixed(1)}`);
  const line = `M${pts.join("L")}`;
  return { line, area: `${line}L${slots - 1},100L${first},100Z` };
}

/**
 * The apps in the order they are listed. Compared on the tenth of a percent the
 * column shows, then by name: finer, two idle apps trade places on noise; any
 * coarser, the column reads out of order ("1.0%" above "1.2%").
 */
export function sortApps(apps: readonly SystemApp[], by: AppSort): SystemApp[] {
  const cpu = (a: SystemApp) => Math.round(a.cpu * 10);
  const mem = (a: SystemApp) => a.mem;
  return [...apps].sort((a, b) =>
    (by === "cpu" ? cpu(b) - cpu(a) || mem(b) - mem(a) : mem(b) - mem(a) || cpu(b) - cpu(a)) || a.name.localeCompare(b.name));
}

/** Bytes as the panel has room for: "972M", "1.9G", "16G". Rounded before the unit is picked, so never "1024M". */
export function formatBytes(bytes: number): string {
  const mib = Math.round(bytes / 1024 ** 2);
  if (mib < 1024) return `${mib}M`;
  const gib = bytes / 1024 ** 3;
  if (gib >= 9.95) return `${Math.round(gib)}G`;
  return `${gib.toFixed(1).replace(/\.0$/, "")}G`;
}

export interface Figure { label: string; value: string; tone: Pressure }

/**
 * The overview collapsed to one line: CPU and memory, toned as in the panel,
 * so a machine in trouble still says so. A battery joins only once it wants
 * something; the rest is a click away.
 */
export function summaryFigures(cpu: number | undefined, s: SystemStats): Figure[] {
  const out: Figure[] = [{ label: "CPU", value: cpu === undefined ? "–" : formatCpu(cpu), tone: cpu === undefined ? "" : pressure(cpu) }];
  if (s.mem) out.push({ label: "Mem", value: `${formatBytes(s.mem.used)}/${formatBytes(s.mem.total)}`, tone: memPressure(s.mem) });
  const bat = s.battery ? batteryPressure(s.battery) : "";
  if (s.battery && bat) out.push({ label: "Bat", value: `${s.battery.percent}%`, tone: bat });
  return out;
}

/** Collapsed unless this browser opened it: the one line is the everyday view. */
export function systemCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSystemCollapsed(on: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, on ? "1" : "0"); } catch { /* for this view only */ }
}

/** Tenths below 10%, whole percent above; rounded first, so never "10.0%". */
export function formatCpu(percent: number): string {
  const tenths = Math.round(percent * 10) / 10;
  return `${tenths < 10 ? tenths.toFixed(1) : Math.round(percent)}%`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const withTone = (cls: string, p: Pressure) => (p ? `${cls} ${p}` : cls);

function loadSort(): AppSort {
  try {
    return localStorage.getItem(SORT_KEY) === "mem" ? "mem" : "cpu";
  } catch {
    return "cpu";
  }
}

function saveSort(by: AppSort): void {
  try { localStorage.setItem(SORT_KEY, by); } catch { /* sorted for this view only */ }
}

function row(label: string, ...rest: (Element | string)[]): HTMLElement {
  const r = el("div", "sys-row");
  r.append(el("span", "sys-label", label), ...rest);
  return r;
}

/** A bar and its figures, in the colour of the trouble it is in. */
export function gauge(label: string, used: number, total: number, p: Pressure): HTMLElement {
  const percent = (used / total) * 100;
  const r = row(label, meter(percent, p), el("span", withTone("sys-value sys-end", p), `${formatBytes(used)}/${formatBytes(total)}`));
  r.title = `${Math.round(percent)}% used`;
  return r;
}

function spark(values: readonly number[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "sys-spark");
  svg.setAttribute("viewBox", `0 0 ${HISTORY - 1} 100`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const { area, line } = sparkPath(values);
  for (const [cls, d] of [["sys-spark-area", area], ["sys-spark-line", line]]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function appRow(a: SystemApp): HTMLElement {
  const r = el("div", "sys-app");
  r.append(el("span", "sys-app-name", a.name), el("span", "sys-num", formatCpu(a.cpu)), el("span", "sys-num", formatBytes(a.mem)));
  r.title = a.procs === 1 ? a.top : `${a.name}: ${a.procs} processes, busiest ${a.top}`;
  return r;
}

export interface SystemPanel {
  /** A new reading from the server. */
  receive(stats: SystemStats): void;
  /** The box closed, or the socket went: whatever comes next is a fresh start. */
  reset(): void;
}

export function createSystemPanel(body: HTMLElement, summary: HTMLElement): SystemPanel {
  let history: number[] = [];
  /** Kept so a reading without a CPU figure (the first) still shows the last known. */
  let cpu: number | undefined;
  let last: SystemStats | null = null;
  let sort = loadSort();

  // The figures are redrawn on every reading; the sort buttons are made once
  // and only restyled, so one that has the keys keeps them through a reading.
  const figures = el("div");
  const head = el("div", "sys-app sys-app-head");
  const list = el("div");
  const apps = el("div", "sys-apps");
  apps.append(head, list);
  const sortButton = (by: AppSort, label: string) => {
    const b = el("button", "sys-num sys-sort", label);
    b.type = "button";
    b.onclick = () => {
      sort = by;
      saveSort(by);
      if (last) draw(last);
    };
    return b;
  };
  const buttons = { cpu: sortButton("cpu", "CPU"), mem: sortButton("mem", "Mem") };
  head.append(el("span", "sys-app-name", "App"), buttons.cpu, buttons.mem);

  function draw(s: SystemStats) {
    const cpuRow = row("CPU", spark(history), el("span", withTone("sys-num sys-end", cpu === undefined ? "" : pressure(cpu)), cpu === undefined ? "–" : formatCpu(cpu)));
    cpuRow.classList.add("sys-cpu");
    cpuRow.title = "CPU over the last minute, newest at the right";
    const rows: HTMLElement[] = [cpuRow];
    const memTight = s.mem ? memPressure(s.mem) : "";
    if (s.mem) rows.push(gauge("Mem", s.mem.used, s.mem.total, memTight));
    // Swap takes no colour of its own: macOS adds a file when the last fills,
    // so a full bar is heavy paging, which the memory pressure already says.
    if (s.swap) rows.push(gauge("Swap", s.swap.used, s.swap.total, ""));
    // Load and the battery share a line: neither has a bar, and every line
    // here is one the notes above do not get.
    const load = row("Load", el("span", "sys-value", s.load.map((l) => l.toFixed(2)).join("  ")));
    load.classList.add("sys-pair");
    if (s.battery) {
      const bat = el("span", "sys-aside");
      bat.append(el("span", "sys-label", "Bat"), el("span", withTone("sys-value", batteryPressure(s.battery)), `${s.battery.percent}% ${s.battery.state}`));
      load.append(bat);
    }
    rows.push(load);

    for (const by of ["cpu", "mem"] as const) {
      const b = buttons[by];
      const nudge = by === "mem" && memTight !== "" && sort !== "mem";
      b.classList.toggle("on", sort === by);
      b.classList.toggle("nudge", nudge);
      b.classList.toggle("warning", nudge && memTight === "warning");
      b.classList.toggle("critical", nudge && memTight === "critical");
      b.setAttribute("aria-pressed", String(sort === by));
      b.title = nudge ? "Memory is under pressure: sort by memory to see what is holding it" : `Sort by ${b.textContent}`;
    }
    const shown = sortApps(s.apps, sort).slice(0, SHOWN_APPS).map(appRow);
    // What the CPU line has that no process owns: the kernel, and processes
    // that came and went between readings. Said, so the column not adding up
    // to the line above is not a mystery.
    if (sort === "cpu" && cpu !== undefined && s.appsCpu !== undefined && cpu - s.appsCpu >= 1) {
      const other = el("div", "sys-app sys-other");
      other.append(el("span", "sys-app-name", "other"), el("span", "sys-num", formatCpu(cpu - s.appsCpu)), el("span", "sys-num"));
      other.title = "The kernel, and processes too brief for ps to catch";
      shown.push(other);
    }
    figures.replaceChildren(...rows);
    list.replaceChildren(...shown);
    summary.replaceChildren(...summaryFigures(cpu, s).map((f) => {
      const e = el("span", "sys-fig");
      e.append(el("span", "sys-label", f.label), el("span", withTone("sys-value", f.tone), f.value));
      return e;
    }));
    if (apps.parentElement !== body) body.replaceChildren(figures, apps);
  }

  return {
    receive(s) {
      if (s.cpu !== undefined) {
        cpu = s.cpu;
        history = [...history, s.cpu].slice(-HISTORY);
      }
      last = s;
      draw(s);
    },
    reset() {
      history = [];
      cpu = undefined;
      last = null;
      body.replaceChildren(el("div", "sys-wait", "Reading…"));
      summary.replaceChildren(el("span", "sys-wait", "Reading…"));
    },
  };
}
