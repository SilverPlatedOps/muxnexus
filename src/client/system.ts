// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { MemSplit, RatePoint, SessionInfo, SwapNotice, SystemApp, SystemStats, WindowMemory } from "../shared/protocol";
import { formatElapsed } from "./agent";
import { ICONS } from "./icons";
import { sessionLabel, windowPlace } from "./labels";
import { meter } from "./usage";

/**
 * The system overview at the foot of the notes panel: CPU over the last minute,
 * memory, swap, and the apps doing the most. The server only reads the
 * machine while this is open (`{t:"system", on}`), so the CPU history is this
 * view's own and starts again each time it opens.
 *
 * It is meant to say when something wants doing, not just to report: a figure
 * in trouble turns yellow then red, and while memory is the trouble the Mem
 * column asks to be sorted on, which names what is holding it.
 */

/** Thirty readings, two seconds apart: the last minute. */
const HISTORY = 30;
const SORT_KEY = "muxnexus.system.sort";
const COLLAPSED_KEY = "muxnexus.system.collapsed";
const OPEN_KEY = "muxnexus.system.open";
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

/**
 * The readings as an area, newest at the right edge of a `slots`-wide box with
 * 0-`max` up the side. Fixed rather than fitted to the readings: a scale that
 * stretched would draw 3% and 30% as the same mountain. An unknown reading is a
 * gap, not a zero: the line stops there and starts again after it.
 */
export function sparkPath(values: readonly (number | null)[], slots: number = HISTORY, max = 100): { area: string; line: string } {
  if (values.length < 2) return { area: "", line: "" };
  const first = slots - values.length;
  const runs: string[][] = [];
  let run: string[] | null = null;
  values.forEach((v, i) => {
    if (v === null) { run = null; return; }
    const y = (100 - (Math.max(0, Math.min(max, v)) / max) * 100).toFixed(1);
    if (!run) runs.push((run = []));
    run.push(`${first + i},${y}`);
  });
  const line = runs.map((r) => `M${r.join("L")}`).join("");
  const area = runs.filter((r) => r.length > 1).map((r) => {
    const x0 = r[0].split(",")[0];
    const x1 = r[r.length - 1].split(",")[0];
    return `M${r.join("L")}L${x1},100L${x0},100Z`;
  }).join("");
  return { line, area };
}

/** The overview's one-line verdict, worded by why it is in trouble; nothing while calm. */
export function statusLine(n: SwapNotice | null): { tone: "critical" | "warning" | "ok"; text: string; hint: string } | null {
  if (!n || n.severity === "calm") return null;
  const writes = n.reason !== "pressure";
  if (n.severity === "recovered") return { tone: "ok", text: writes ? "✓ Swap writes quiet for 2 min" : "✓ Pressure back to normal", hint: "" };
  return { tone: n.severity === "urgent" ? "critical" : "warning", text: writes ? "● Swapping to SSD" : "● Memory pressure", hint: "· close something below" };
}

/**
 * The Swap row's colour: the level's, but only when swap writes are why. In a
 * pressure-only episode memory is the trouble and says so; the swap figure
 * stays plain, since what it shows is not the problem.
 */
export function swapTone(n: SwapNotice | null): Pressure {
  if (!n || n.reason === "pressure" || n.reason === null) return "";
  return n.severity === "urgent" ? "critical" : n.severity === "busy" ? "warning" : "";
}

/** Swap traffic: "22 MB/s", "0.4 MB/s". Rounded before the form is picked, so never "10.0". */
export function formatRate(bytesPerSec: number): string {
  const mb = bytesPerSec / 1024 ** 2;
  const tenths = Math.round(mb * 10) / 10;
  return `${tenths < 10 ? tenths.toFixed(1) : Math.round(mb)} MB/s`;
}

/** Disk-write volumes, in the decimal units drives are sold in: "250 GB", "0.9 TB" -- terabytes from half of one, so never "1000 GB". */
export function formatVolume(bytes: number): string {
  return bytes < 0.5e12 ? `${Math.round(bytes / 1e9)} GB` : `${(bytes / 1e12).toFixed(1)} TB`;
}

const DAY_MS = 86_400_000;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const weekday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short" });

/**
 * Under the swap graph: how much swap sits on the disk, and what it has written
 * since the Mac started, as a daily average once there has been a day to
 * average over. The exact total and the boot time are the detail behind it.
 */
export function swapLine(onDisk: number | undefined, written: number | null, bootTime: number | null, now: number): { text: string; detail: string } | null {
  const disk = onDisk === undefined ? null : `${formatBytes(onDisk)} on disk`;
  if (written === null || bootTime === null) return disk ? { text: disk, detail: "" } : null;
  const boot = new Date(bootTime);
  const days = (now - bootTime) / DAY_MS;
  const since = days >= 1 ? `avg ${Math.round(written / 1e9 / days)} GB/day since ${weekday(boot)}` : `${formatVolume(written)} since ${hhmm(boot)}`;
  return { text: disk ? `${disk} · ${since}` : since, detail: `${formatVolume(written)} since ${weekday(boot)} ${hhmm(boot)}` };
}

export interface LegendPart { key: "apps" | "system" | "compressed" | "available"; label: string; bytes: number; tooltip?: string }

/** The Mem bar's parts, in the bar's order. */
export function memLegend(split: MemSplit): LegendPart[] {
  return [
    { key: "apps", label: "apps", bytes: split.apps },
    { key: "system", label: "system", bytes: split.system, tooltip: "Wired: memory the kernel keeps in RAM for itself, drivers and the GPU, sometimes on an app's behalf. It can't be compressed or swapped." },
    { key: "compressed", label: "compressed", bytes: split.compressed },
    { key: "available", label: "available", bytes: split.available, tooltip: "Free memory plus file cache macOS can reclaim: the room before it has to compress or swap" },
  ];
}

/** A tab's memory: "≥" when some of its processes could not be read, "?" when none could. */
export function formatMem(bytes: number, processes: number, unreadable: number): string {
  if (processes > 0 && unreadable >= processes) return "?";
  return `${unreadable > 0 ? "≥" : ""}${formatBytes(bytes)}`;
}

export type PanelRow =
  | { kind: "app"; app: SystemApp }
  | { kind: "tab"; windowId: string; place: string; alsoIn: string[]; mem: WindowMemory; idle: string | null }
  | { kind: "more"; count: number; bytes: number };

const LIST_LIMIT = 8;
const IDLE_MS = 3600_000;

/**
 * The list: apps and tabs on one scale, ranked as sorted, at most `limit` rows.
 * Tabs that do not make the cut fold into one "more" row rather than vanish;
 * smaller apps are not listed. A window no session shows (gone since the
 * reading) is left out.
 */
export function panelRows(
  apps: readonly SystemApp[],
  windows: readonly WindowMemory[],
  sessions: readonly SessionInfo[],
  by: AppSort,
  now: number,
  limit = LIST_LIMIT,
  /** The folded row opened: its tabs listed in its place, the smaller apps still left out. */
  unfold = false,
): PanelRow[] {
  const tabs: PanelRow[] = [];
  for (const mem of windows) {
    const showing = sessions.filter((s) => s.windows.some((w) => w.id === mem.windowId));
    if (showing.length === 0) continue;
    const w = showing[0].windows.find((x) => x.id === mem.windowId)!;
    const a = w.agent;
    const waited = a && (a.state === "input" || a.state === "done") && now - Date.parse(a.since) > IDLE_MS;
    tabs.push({
      kind: "tab", windowId: mem.windowId, place: windowPlace(showing[0], w),
      alsoIn: showing.slice(1).map(sessionLabel), mem, idle: waited ? `agent idle ${formatElapsed(a.since, now)}` : null,
    });
  }
  const bytes = (r: PanelRow) => (r.kind === "app" ? r.app.mem : r.kind === "tab" ? r.mem.bytes : r.bytes);
  const cpu = (r: PanelRow) => Math.round((r.kind === "app" ? r.app.cpu : r.kind === "tab" ? r.mem.cpu : 0) * 10);
  const name = (r: PanelRow) => (r.kind === "app" ? r.app.name : r.kind === "tab" ? r.place : "");
  const ranked = [...apps.map((app): PanelRow => ({ kind: "app", app })), ...tabs].sort((a, b) =>
    (by === "cpu" ? cpu(b) - cpu(a) || bytes(b) - bytes(a) : bytes(b) - bytes(a) || cpu(b) - cpu(a)) || name(a).localeCompare(name(b)));
  if (ranked.length <= limit) return ranked;
  const kept = ranked.slice(0, limit - 1);
  const folded = ranked.slice(limit - 1).filter((r) => r.kind === "tab");
  if (folded.length === 0) return ranked.slice(0, limit);
  if (unfold) return [...kept, ...folded];
  return [...kept, { kind: "more", count: folded.length, bytes: folded.reduce((n, r) => n + bytes(r), 0) }];
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
 * so a machine in trouble still says so; the rest is a click away.
 */
export function summaryFigures(cpu: number | undefined, s: SystemStats): Figure[] {
  const out: Figure[] = [{ label: "CPU", value: cpu === undefined ? "–" : formatCpu(cpu), tone: cpu === undefined ? "" : pressure(cpu) }];
  if (s.mem) out.push({ label: "Mem", value: `${formatBytes(s.mem.used)}/${formatBytes(s.mem.total)}`, tone: memPressure(s.mem) });
  return out;
}

/** What opens on a tap: Mem's legend, Swap's history on disk, and the list. */
export type SystemPart = "mem" | "swap" | "list";
const PARTS: readonly SystemPart[] = ["mem", "swap", "list"];

/** The parts this browser opened; closed unless it did, so the overview starts as its three lines. */
export function parseOpen(raw: string | null): Set<SystemPart> {
  try {
    const v: unknown = JSON.parse(raw ?? "[]");
    return new Set(Array.isArray(v) ? PARTS.filter((p) => v.includes(p)) : []);
  } catch {
    return new Set();
  }
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

const SWAP_SPAN_MS = 300_000;
const SWAP_SLOT_MS = 5000;
/** A reading older than this, with none since, is a gap in the graph -- the server's own limit for a rate. */
const SWAP_GAP_MS = 15_000;
/** The swap graph's ceiling, MB/s, with the busy and urgent thresholds marked under it. */
const SWAP_MAX = 40;
const SWAP_MARKS = [5, 20];
/** A notice this old, with none since, is not trusted: the server or the socket has gone quiet. */
const STALE_MS = 15_000;

/**
 * Five minutes of swap-write rates as `slots` evenly spaced values in MB/s, so
 * the graph's time axis holds whether readings came every two seconds or five.
 * Each slot is the latest reading at or before its end; none within
 * `SWAP_GAP_MS`, or an unknown one, is a gap.
 */
export function resampleRates(points: readonly RatePoint[], now: number, spanMs = SWAP_SPAN_MS, slots = spanMs / SWAP_SLOT_MS): (number | null)[] {
  const out: (number | null)[] = [];
  const step = spanMs / slots;
  let j = 0;
  let latest: RatePoint | null = null;
  for (let i = 0; i < slots; i++) {
    const end = now - spanMs + (i + 1) * step;
    while (j < points.length && points[j].at <= end) latest = points[j++];
    out.push(latest && latest.rate !== null && end - latest.at < SWAP_GAP_MS ? latest.rate / 1024 ** 2 : null);
  }
  return out;
}

function spark(values: readonly (number | null)[], slots: number = HISTORY, max = 100, marks: readonly number[] = []): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "sys-spark");
  svg.setAttribute("viewBox", `0 0 ${slots - 1} 100`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const m of marks) {
    const line = document.createElementNS(SVG, "line");
    const y = (100 - (m / max) * 100).toFixed(1);
    line.setAttribute("class", "sys-spark-mark");
    for (const [k, v] of [["x1", "0"], ["x2", String(slots - 1)], ["y1", y], ["y2", y]]) line.setAttribute(k, v);
    svg.append(line);
  }
  const { area, line } = sparkPath(values, slots, max);
  for (const [cls, d] of [["sys-spark-area", area], ["sys-spark-line", line]]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function numCell(text: string, tone: Pressure = ""): HTMLElement {
  return el("span", withTone("sys-num", tone), text);
}

function appRow(a: SystemApp): HTMLElement {
  const r = el("div", "sys-app");
  r.append(el("span", "sys-app-name", a.name), numCell(formatCpu(a.cpu)), numCell(a.unreadable ? "–" : formatBytes(a.mem)));
  r.title = a.unreadable
    ? `${a.name}: another user's processes, whose memory cannot be read without root`
    : a.procs === 1 ? a.top : `${a.name}: ${a.procs} processes, busiest ${a.top}`;
  return r;
}

const partsText = (m: WindowMemory) => m.parts.map((p) => `${p.name}  ${p.bytes === null ? "?" : formatBytes(p.bytes)}`).join("\n");

export interface SystemPanel {
  /** A new reading from the server. */
  receive(stats: SystemStats): void;
  /** The swap level, which arrives on its own message whether or not the panel is open. */
  notice(n: SwapNotice): void;
  /** Sort the list, as its header buttons do; the nudge's Show list sorts by memory. */
  sortBy(by: AppSort): void;
  /** Whether the list is open: only then does the server read what holds memory. */
  listOpen(): boolean;
  /** Open the list, as the nudge's Show list does. */
  openList(): void;
  /** The box closed, or the socket went: whatever comes next is a fresh start. */
  reset(): void;
}

export function createSystemPanel(
  body: HTMLElement,
  summary: HTMLElement,
  deps: { sessions(): SessionInfo[]; tmuxServer(): string | null; goTo(windowId: string): void; listToggled(): void },
): SystemPanel {
  let history: number[] = [];
  /** Kept so a reading without a CPU figure (the first) still shows the last known. */
  let cpu: number | undefined;
  let last: SystemStats | null = null;
  let swap: { n: SwapNotice; at: number } | null = null;
  let sort = loadSort();
  /** Tab rows opened by their chevron, by window id; and whether the folded tabs are shown. */
  const open = new Set<string>();
  let moreOpen = false;
  const opened = (() => {
    try { return parseOpen(localStorage.getItem(OPEN_KEY)); } catch { return new Set<SystemPart>(); }
  })();
  function setOpened(part: SystemPart, on: boolean) {
    if (on) opened.add(part); else opened.delete(part);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...opened])); } catch { /* for this view only */ }
  }

  // Made once and kept: the status line is a live region, which is announced
  // only if it stays the same element; the sort buttons and the swap line keep
  // the keys through a reading.
  const status = el("div", "sys-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const figures = el("div");
  const swapNote = el("span", "sys-note");
  swapNote.tabIndex = 0;
  const swapDetail = el("span", "sys-note-detail");
  swapDetail.id = "sys-swap-detail";
  swapNote.setAttribute("aria-describedby", swapDetail.id);
  swapNote.onclick = () => swapNote.classList.toggle("open");
  swapNote.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); swapNote.classList.toggle("open"); }
  };
  swapNote.onblur = () => swapNote.classList.remove("open");
  const swapNoteRow = el("div", "sys-note-row");
  swapNoteRow.append(swapNote, swapDetail);
  const head = el("div", "sys-app sys-app-head");
  // Folded, the list is its head alone, and the server stops reading it.
  const headName = el("button", "sys-app-name sys-list-toggle");
  headName.type = "button";
  const chevron = el("span", "chevron");
  chevron.innerHTML = ICONS.chevron;
  headName.append(chevron, "Holding memory");
  const list = el("div");
  const apps = el("div", "sys-apps");
  apps.append(head, list);
  function paintList() {
    const on = opened.has("list");
    apps.classList.toggle("folded", !on);
    headName.setAttribute("aria-expanded", String(on));
    list.hidden = !on;
  }
  paintList();
  headName.onclick = () => {
    setOpened("list", !opened.has("list"));
    paintList();
    deps.listToggled();
    if (last) draw(last);
  };
  /**
   * A figure's line that opens its detail under it: the whole line is the
   * button, so a finger can find it; the detail stays open in this browser.
   */
  function opener(part: SystemPart, label: string, ...rest: Element[]): HTMLButtonElement {
    const b = el("button", "sys-row sys-opener");
    b.type = "button";
    b.dataset.opener = part;
    b.setAttribute("aria-expanded", String(opened.has(part)));
    b.append(el("span", "sys-label", label), ...rest);
    b.onclick = () => {
      setOpened(part, !opened.has(part));
      if (last) draw(last);
    };
    return b;
  }
  const sortButton = (by: AppSort, label: string) => {
    const b = el("button", "sys-num sys-sort", label);
    b.type = "button";
    b.onclick = () => setSort(by);
    return b;
  };
  const buttons = { cpu: sortButton("cpu", "CPU"), mem: sortButton("mem", "Mem") };
  head.append(headName, buttons.cpu, buttons.mem);

  function setSort(by: AppSort) {
    sort = by;
    saveSort(by);
    if (last) draw(last);
  }

  /** The notice, unless it has gone quiet; by this browser's clock, so another device's does not matter. */
  const fresh = () => (swap && Date.now() - swap.at <= STALE_MS ? swap.n : null);

  function drawStatus() {
    const n = swap?.n ?? null;
    const line = statusLine(n);
    status.hidden = !line;
    if (!line) return status.replaceChildren();
    const stale = !fresh();
    status.className = `sys-status ${stale ? "stale" : line.tone}`;
    status.title = stale ? "stale: no word from the server for a while" : "";
    const text = `${line.text}${line.hint ? ` ${line.hint}` : ""}`;
    if (status.textContent !== text) {
      // Running text, so a narrow drawer wraps it between words.
      const hint = line.hint ? [" ", el("span", "sys-status-hint", line.hint)] : [];
      status.replaceChildren(el("span", "", line.text), ...hint);
    }
  }

  function memRows(s: SystemStats, tone: Pressure): HTMLElement[] {
    if (!s.mem) return [];
    if (!s.split) return [gauge("Mem", s.mem.used, s.mem.total, tone)];
    const bar = el("span", "usage-meter sys-split");
    for (const part of ["apps", "system", "compressed"] as const) {
      const seg = el("span", `sys-seg ${part}`);
      seg.style.width = `${(s.split[part] / s.split.total) * 100}%`;
      bar.append(seg);
    }
    const r = opener("mem", "Mem", bar, el("span", withTone("sys-value sys-end", tone), `${formatBytes(s.mem.used)}/${formatBytes(s.mem.total)}`));
    r.title = `${Math.round((s.mem.used / s.mem.total) * 100)}% used`;
    if (!opened.has("mem")) return [r];
    const legend = el("div", "sys-legend");
    for (const part of memLegend(s.split)) {
      const item = el("span", `sys-legend-item ${part.key}`);
      item.append(el("i", "sys-swatch"), `${part.label} ${formatBytes(part.bytes)}`);
      if (part.tooltip) item.title = part.tooltip;
      legend.append(item);
    }
    return [r, legend];
  }

  function swapRows(s: SystemStats): HTMLElement[] {
    if (!s.history && !s.swap) return [];
    const n = fresh();
    const rate = s.rate ?? n?.rate ?? null;
    const recovered = n?.severity === "recovered";
    const value = rate === null ? "–" : recovered || rate < 0.05 * 1024 ** 2 ? "quiet" : formatRate(rate);
    const tone = swapTone(n);
    const values = resampleRates(s.history ?? [], Date.now());
    const graph = spark(values, values.length, SWAP_MAX, SWAP_MARKS);
    graph.classList.add("sys-swap", tone || (recovered ? "ok" : "calm"));
    const end = el("span", `${withTone("sys-value sys-end", tone)}${recovered && value === "quiet" ? " ok" : ""}`, value);
    const line = swapLine(s.swap?.used, s.written ?? null, s.bootTime ?? null, Date.now());
    const r = line ? opener("swap", "Swap", graph, end) : row("Swap", graph, end);
    r.title = "Writes to the SSD over the last five minutes, newest at the right; the marks are 5 and 20 MB/s";
    if (!line || !opened.has("swap")) {
      swapNote.classList.remove("open");
      return [r];
    }
    swapNote.textContent = line.text;
    swapDetail.textContent = line.detail;
    swapNote.classList.toggle("has-detail", line.detail !== "");
    return [r, swapNoteRow];
  }

  function tabRow(t: Extract<PanelRow, { kind: "tab" }>): HTMLElement[] {
    const r = el("div", "sys-app sys-tab-row");
    const chevron = el("button", "sys-chevron");
    chevron.type = "button";
    chevron.dataset.chevron = t.windowId;
    const isOpen = open.has(t.windowId);
    chevron.setAttribute("aria-expanded", String(isOpen));
    chevron.setAttribute("aria-label", `What runs in ${t.place}`);
    chevron.textContent = isOpen ? "▾" : "▸";
    chevron.onclick = () => {
      if (open.has(t.windowId)) open.delete(t.windowId); else open.add(t.windowId);
      if (last) draw(last);
    };
    const name = el("button", "sys-app-name sys-goto", t.place);
    name.type = "button";
    name.title = `${t.place}\n${partsText(t.mem)}\nClick to go to the tab`;
    name.onclick = () => deps.goTo(t.windowId);
    if (t.idle) name.append(el("span", "sys-idle", ` · ${t.idle}`));
    r.append(chevron, name, numCell(formatCpu(t.mem.cpu)), numCell(formatMem(t.mem.bytes, t.mem.processes, t.mem.unreadable)));
    if (!isOpen) return [r];
    const out = [r];
    for (const p of t.mem.parts) {
      const part = el("div", "sys-app sys-part");
      part.append(el("span", "sys-app-name", p.name), numCell(formatCpu(p.cpu)), numCell(p.bytes === null ? "?" : formatBytes(p.bytes)));
      out.push(part);
    }
    if (t.mem.unreadable > 0) out.push(el("div", "sys-app sys-part sys-dim", `${t.mem.unreadable} of ${t.mem.processes} processes couldn't be read`));
    if (t.alsoIn.length > 0) out.push(el("div", "sys-app sys-part sys-dim", `also in ${t.alsoIn.join(", ")}`));
    return out;
  }

  function moreRow(m: Extract<PanelRow, { kind: "more" }>): HTMLElement {
    const r = el("button", "sys-app sys-more");
    r.type = "button";
    r.append(el("span", "sys-app-name", `▸ ${m.count} more tab${m.count === 1 ? "" : "s"}`), numCell(""), numCell(formatBytes(m.bytes)));
    r.onclick = () => { moreOpen = true; if (last) draw(last); };
    return r;
  }

  function draw(s: SystemStats) {
    const cpuRow = row("CPU", spark(history), el("span", withTone("sys-num sys-end", cpu === undefined ? "" : pressure(cpu)), cpu === undefined ? "–" : formatCpu(cpu)));
    cpuRow.classList.add("sys-cpu");
    cpuRow.title = "CPU over the last minute, newest at the right";
    const memTight = s.mem ? memPressure(s.mem) : "";
    const rows: HTMLElement[] = [cpuRow, ...memRows(s, memTight), ...swapRows(s)];

    // Folded, the sort buttons are away, so the fold itself asks to be opened.
    const foldNudge = memTight !== "" && !opened.has("list");
    headName.classList.toggle("nudge", foldNudge);
    headName.classList.toggle("warning", foldNudge && memTight === "warning");
    headName.classList.toggle("critical", foldNudge && memTight === "critical");
    headName.setAttribute("aria-description", foldNudge ? "Memory is under pressure: open to see what is holding it" : "");
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
    headName.title = s.metric === "rss"
      ? "resident memory: compressed and swapped memory not counted"
      : "Counted the way Activity Monitor counts: compressed and swapped memory included, so the list can add up to more than the bar";
    // Window ids are tmux's, and mean nothing under another tmux server.
    const windows = s.windows && s.tmuxServer && s.tmuxServer === deps.tmuxServer() ? s.windows : [];
    const listed = opened.has("list");
    const ranked = listed ? panelRows(s.apps, windows, deps.sessions(), sort, Date.now(), undefined, moreOpen) : [];
    const shown = ranked.flatMap((r) => (r.kind === "app" ? [appRow(r.app)] : r.kind === "tab" ? tabRow(r) : [moreRow(r)]));
    if (listed && !shown.length) shown.push(el("div", "sys-wait", "Reading…"));
    // What the CPU line has that no process owns: the kernel, and processes
    // that came and went between readings. Said, so the column not adding up
    // to the line above is not a mystery.
    if (listed && sort === "cpu" && cpu !== undefined && s.appsCpu !== undefined && cpu - s.appsCpu >= 1) {
      const other = el("div", "sys-app sys-other");
      other.append(el("span", "sys-app-name", "other"), numCell(formatCpu(cpu - s.appsCpu)), el("span", "sys-num"));
      other.title = "The kernel, and processes too brief for ps to catch";
      shown.push(other);
    }
    // Redrawn every reading, so a chevron or a figure's line that had the keys gets them back.
    const active = (document.activeElement as HTMLElement | null)?.dataset;
    const focused = active?.chevron;
    const focusedLine = active?.opener;
    drawStatus();
    figures.replaceChildren(...rows);
    if (focusedLine) figures.querySelector<HTMLElement>(`[data-opener="${focusedLine}"]`)?.focus({ preventScroll: true });
    list.replaceChildren(...shown);
    if (focused) list.querySelector<HTMLElement>(`[data-chevron="${CSS.escape(focused)}"]`)?.focus();
    const figs = summaryFigures(cpu, s);
    const n = swap?.n;
    if (n && n.severity !== "calm" && n.severity !== "recovered" && n.rate !== null) {
      figs.push({ label: "Swap", value: `↑${formatRate(n.rate)}`, tone: fresh() ? swapTone(n) : "" });
    }
    summary.replaceChildren(...figs.map((f) => {
      const e = el("span", "sys-fig");
      e.append(el("span", "sys-label", f.label), el("span", withTone("sys-value", f.tone), f.value));
      return e;
    }));
    if (apps.parentElement !== body) body.replaceChildren(status, figures, apps);
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
    notice(n) {
      swap = { n, at: Date.now() };
      if (last) draw(last);
      else drawStatus();
    },
    sortBy: setSort,
    listOpen: () => opened.has("list"),
    openList() {
      if (opened.has("list")) return;
      setOpened("list", true);
      paintList();
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
