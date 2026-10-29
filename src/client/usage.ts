// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { UsageSource, UsageWindow } from "../shared/protocol";
import { profileBadge } from "./agent";
import { badgesShown } from "./display";
import { ICONS } from "./icons";

/**
 * The quota panel in the sidebar footer: one row per window per account.
 *
 * It lives in its own element, a sibling of `#side-foot` rather than a child,
 * because the footer is rebuilt wholesale on every session render and would
 * take the panel with it.
 */

/** Short names for the windows each provider reports, since `weekly_all` is nobody's idea of a label. */
const KIND: Record<string, string> = {
  session: "5h",
  weekly_all: "7d",
  weekly_scoped: "7d+",
};

const BARS = 8;

/** The label every provider's short rolling window shares. */
const SHORT_WINDOW = "5h";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Whole calendar days from `a` to `b`, on the viewer's clock. */
function calendarDays(a: Date, b: Date): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}

/**
 * When a limit lifts, worded the way you would plan around it: "12m" or
 * "4h 1m" while it is today's problem, then the day and hour it resets --
 * "Fri 8pm" -- since nobody counts "3d09" down in their head. Once the weekday
 * would come round to today's again it is the date instead ("Oct 2").
 *
 * Coarse on purpose: the exact minute a weekly limit lifts has never mattered,
 * so past a day the time is rounded to the hour.
 */
export function formatReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) {
    const rest = mins % 60;
    return `${Math.floor(mins / 60)}h${rest === 0 ? "" : ` ${rest}m`}`;
  }
  // Rounded on the local clock: zones half an hour off UTC would get "8:30".
  const when = new Date(at + 30 * 60_000);
  when.setMinutes(0, 0, 0);
  if (calendarDays(new Date(now), when) >= 7) return `${MONTHS[when.getMonth()]} ${when.getDate()}`;
  const h = when.getHours();
  return `${DAYS[when.getDay()]} ${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`;
}

/**
 * A bar, as text: it needs no layout, scales with the font, and costs nothing to
 * redraw. The fill and the track come back separately so they can be coloured
 * apart -- in one colour the empty half reads as full at this size.
 */
export function bar(percent: number): { fill: string; track: string } {
  const clamped = Math.max(0, Math.min(100, percent));
  // Any usage at all gets a block: rounding 5% to nothing draws an empty bar
  // next to a non-zero number, which reads as "untouched" when it is not.
  const blocks = Math.round((clamped / 100) * BARS);
  const filled = clamped > 0 ? Math.max(1, blocks) : 0;
  return { fill: "█".repeat(filled), track: "█".repeat(BARS - filled) };
}

export function kindLabel(kind: string): string {
  return KIND[kind] ?? kind;
}

/**
 * The provider's own judgement decides the colour. It knows which of its limits
 * is close to biting; a percentage threshold here would only be a guess about
 * somebody else's rules.
 */
function tone(w: UsageWindow): string {
  if (w.severity && w.severity !== "normal") return w.severity;
  return "";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const EXPANDED_KEY = "muxnexus.usage.expanded";

/**
 * The one window that speaks for an account when the panel is collapsed: the
 * 5h rolling one, for every account.
 *
 * Picking each account's worst window instead made the rows incomparable --
 * personal showing 5h beside work showing 7d, which is three numbers about
 * three different things stacked in a column. The question the collapsed panel
 * answers is "which account can I work in right now", and that is the short
 * window, the same one for everybody. Providers name it differently
 * (`session`, `5h`), so it is found through the label rather than by key.
 *
 * Except when the account is at one of its limits: then it cannot be worked in
 * whatever its 5h says, so that limit speaks -- of several, the one that lifts
 * last, since that is when the account is back.
 *
 * An account with no short window falls back to its most severe, else fullest.
 */
export function summaryWindow(windows: readonly UsageWindow[], now: number = Date.now()): UsageWindow | undefined {
  if (windows.length === 0) return undefined;
  const stopped = windows.filter((w) => spent(w, now));
  if (stopped.length > 0) return [...stopped].sort((a, b) => lifts(b) - lifts(a))[0];
  const short = windows.find((w) => kindLabel(w.kind) === SHORT_WINDOW);
  if (short) return short;
  const severe = windows.filter((w) => w.severity && w.severity !== "normal");
  const pool = severe.length > 0 ? severe : windows;
  return [...pool].sort((a, b) => b.percent - a.percent)[0];
}

/** A window that has stopped the account: the provider says so, or it is full. */
export function atLimit(w: UsageWindow): boolean {
  return w.severity === "exceeded" || w.percent >= 100;
}

/** At its limit and not yet past its reset: one past it has lifted, whatever the last reading said. */
function spent(w: UsageWindow, now: number): boolean {
  return atLimit(w) && lifts(w) > now;
}

/** When a window lifts; one that does not say is taken as the last. */
function lifts(w: UsageWindow): number {
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isNaN(at) ? Infinity : at;
}

/** Whether the panel is expanded, remembered per browser -- a per-viewer preference. */
function expanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false; // private window, blocked storage: collapsed is the safe default
  }
}

function setExpanded(on: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, on ? "1" : "0");
  } catch {
    /* the panel still toggles for this view */
  }
}

/**
 * A bar drawn to whatever width its column gives it, so the panel can narrow
 * without the bars running off its edge. Any usage at all gets a sliver: an
 * empty bar next to a non-zero number reads as "untouched" when it is not.
 * `tone` is a severity class (`warning`, `critical`, `exceeded`) or empty.
 */
export function meter(percent: number, tone: string = ""): HTMLElement {
  const clamped = Math.max(0, Math.min(100, percent));
  const m = el("span", "usage-meter");
  const fill = el("span", tone ? `usage-fill ${tone}` : "usage-fill");
  fill.style.width = clamped > 0 ? `max(2px, ${clamped}%)` : "0";
  m.append(fill);
  return m;
}

/**
 * Draw the panel. An empty list empties the element, so a machine with no
 * Claude and no Codex gets the sidebar it had before this existed.
 *
 * One grid for every account, so the columns line up down the panel. Each
 * account is its badge and name followed by a row per window; the rows are
 * `display: contents`, so their cells sit in the shared columns. When the
 * sidebar is too narrow for a name column, the stylesheet moves the name onto
 * its own line above its bars -- or, collapsed with badges on, leaves only the
 * badge, which is the legend the tabs already wear.
 */
export function renderUsage(root: HTMLElement, sources: UsageSource[], now: number = Date.now()): void {
  root.replaceChildren();
  if (sources.length === 0) return;
  const open = expanded();
  root.classList.toggle("expanded", open);
  const grid = el("div", `usage-grid${badgesShown() ? " badged" : ""}`);
  sources.forEach((s, i) => {
    if (i > 0) grid.append(el("div", "usage-gap"));
    const windows = open ? s.windows : s.windows.length > 0 ? [summaryWindow(s.windows, now)!] : [];
    const stale = s.state !== "ok" ? " stale" : "";
    const head = el("div", `usage-row usage-head${windows.length > 0 ? stale : ""}`);
    // The badge stands in for the name only beside a bar: "signed out" needs both.
    const byBadge = windows.length > 0;
    head.append(...accountBadge(s, sources), el("span", `usage-name${byBadge ? " by-badge" : ""}`, s.label));
    head.title = s.label;
    grid.append(head);
    if (windows.length === 0) {
      // "signed out" keeps its row: an account that vanished looks like a bug.
      head.append(el("span", "usage-note", s.state === "signed-out" ? "signed out" : "unavailable"));
      if (s.state === "signed-out") head.title = `${s.label}: no valid token — sign in to this account`;
      return;
    }
    for (const w of windows) {
      // A row at its limit keeps its reset time at every width: when the account is back is the news.
      const row = el("div", `usage-row${stale}${spent(w, now) ? " spent" : ""}`);
      row.append(
        el("span", "usage-kind", kindLabel(w.kind)),
        meter(w.percent, tone(w)),
        el("span", "usage-pct", `${Math.round(w.percent)}%`),
        el("span", "usage-reset", formatReset(w.resetsAt, now)),
      );
      row.title = s.state !== "ok" ? `${s.label}: last read ${new Date(s.checkedAt).toLocaleTimeString()}`
        : spent(w, now) ? `${s.label}: ${kindLabel(w.kind)} limit reached${w.resetsAt ? `, resets ${formatReset(w.resetsAt, now)}` : ""}`
        : s.label;
      grid.append(row);
    }
  });
  root.append(toggle(root, sources, now, open), grid);
}

/** The accounts a tab's agent can be spending: every Claude profile, and Codex. */
export function badgedLabels(sources: readonly Pick<UsageSource, "provider" | "label">[]): string[] {
  return sources.map((s) => s.label);
}

/**
 * The account's badge, the same letter and colour its agent's tab wears: this
 * panel is the legend for the tabs, so it goes when they go.
 */
function accountBadge(s: UsageSource, sources: UsageSource[]): HTMLElement[] {
  if (!badgesShown()) return [];
  const b = profileBadge(s.label, badgedLabels(sources));
  return [el("span", `pbadge${b.slot === null ? "" : ` p${b.slot}`}`, b.initial)];
}

function toggle(root: HTMLElement, sources: UsageSource[], now: number, open: boolean): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "usage-toggle";
  const chevron = el("span", "chevron");
  chevron.innerHTML = ICONS.chevron;
  b.append(chevron, el("span", "", "Quota"));
  b.title = open ? "Show one line an account: its 5h window, or the limit it is at" : "Show every window and when it resets";
  b.setAttribute("aria-expanded", String(open));
  b.onclick = (e) => {
    e.stopPropagation();
    setExpanded(!open);
    renderUsage(root, sources, now);
  };
  return b;
}
