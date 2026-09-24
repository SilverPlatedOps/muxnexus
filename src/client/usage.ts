import type { UsageSource, UsageWindow } from "../shared/protocol";
import { profileBadge } from "./agent";

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
  rolling: "5h",
  weekly: "7d",
  monthly: "30d",
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
  if (w.severity && w.severity !== "normal") return ` ${w.severity}`;
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
 * (`session`, `rolling`), so it is found through the label rather than by key.
 *
 * An account with no short window falls back to its most severe, else fullest.
 */
export function summaryWindow(windows: readonly UsageWindow[]): UsageWindow | undefined {
  if (windows.length === 0) return undefined;
  const short = windows.find((w) => kindLabel(w.kind) === SHORT_WINDOW);
  if (short) return short;
  const severe = windows.filter((w) => w.severity && w.severity !== "normal");
  const pool = severe.length > 0 ? severe : windows;
  return [...pool].sort((a, b) => b.percent - a.percent)[0];
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
 * Draw the panel. An empty list empties the element, so a machine with no
 * Claude and no opencode gets the sidebar it had before this existed.
 * `onBadges` is told when the badge switch is pressed, so the tabs can redraw.
 */
export function renderUsage(root: HTMLElement, sources: UsageSource[], now: number = Date.now(), onBadges?: () => void): void {
  root.replaceChildren();
  if (sources.length === 0) return;
  const open = expanded();
  root.classList.toggle("expanded", open);
  if (!open) return renderCollapsed(root, sources, now, onBadges);
  for (const s of sources) {
    const block = el("div", "usage-src");
    if (s.state !== "ok" && s.windows.length === 0) {
      const row = el("div", "usage-row");
      row.append(
        ...accountBadge(s, sources),
        el("span", "usage-name", s.label),
        el("span", "usage-note", s.state === "signed-out" ? "signed out" : "unavailable"),
      );
      if (s.state === "signed-out") row.title = `${s.label}: no valid token — sign in to this account`;
      block.append(row);
      root.append(block);
      continue;
    }
    s.windows.forEach((w, i) => {
      const row = el("div", `usage-row${s.state !== "ok" ? " stale" : ""}`);
      // The account is named once, against its first window, and the rest indent
      // under it -- the name is not a property of the window.
      row.append(...(i === 0 ? accountBadge(s, sources) : badgesShown() ? [el("span", "pbadge blank")] : []), el("span", "usage-name", i === 0 ? s.label : ""));
      row.append(el("span", "usage-kind", kindLabel(w.kind)));
      const b = bar(w.percent);
      const meter = el("span", "usage-meter");
      meter.append(el("span", `usage-fill${tone(w)}`, b.fill), el("span", "usage-track", b.track));
      row.append(meter);
      row.append(el("span", "usage-pct", `${Math.round(w.percent)}%`));
      row.append(el("span", "usage-reset", formatReset(w.resetsAt, now)));
      if (s.state !== "ok") row.title = `last read ${new Date(s.checkedAt).toLocaleTimeString()}`;
      block.append(row);
    });
    root.append(block);
  }
  root.firstElementChild?.firstElementChild?.append(toggle(root, sources, now, true, onBadges));
  const foot = badgesToggle(root, sources, now, onBadges);
  if (foot) root.append(foot);
}

const BADGES_KEY = "muxnexus.badges";

/** What the preference is kept in: `localStorage`, or a stand-in under test. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Whether the tabs wear their agent's profile badge, remembered per browser
 * like the folded groups: a viewer's convenience, not shared state. On unless
 * switched off, so a browser that has never chosen sees them; a browser whose
 * storage is blocked sees them too, and its choice lasts the page.
 */
export function badgesShown(store?: Store): boolean {
  try {
    return (store ?? localStorage).getItem(BADGES_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setBadgesShown(on: boolean, store?: Store): void {
  try {
    (store ?? localStorage).setItem(BADGES_KEY, on ? "1" : "0");
  } catch {
    /* not remembered; the page still switches */
  }
}

/**
 * The account's badge, the same letter and colour its agent's tab wears: this
 * panel is the legend for the tabs, so it goes when they go. opencode's agents
 * carry no profile, so it gets an empty slot that keeps the columns aligned.
 */
function accountBadge(s: UsageSource, sources: UsageSource[]): HTMLElement[] {
  if (!badgesShown()) return [];
  const claude = sources.filter((x) => x.id !== "opencode").map((x) => x.label);
  if (s.id === "opencode") return [el("span", "pbadge blank")];
  const b = profileBadge(s.label, claude);
  return [el("span", `pbadge${b.slot === null ? "" : ` p${b.slot}`}`, b.initial)];
}

/**
 * The switch for the badges, under the accounts it is the legend for. A verb
 * for a label, so it says what pressing it does without a state to decode;
 * its own line, since the account rows are full at 280 px. Only when there is
 * a Claude account: opencode alone has nothing to badge.
 */
function badgesToggle(root: HTMLElement, sources: UsageSource[], now: number, onBadges?: () => void): HTMLElement | null {
  if (!sources.some((s) => s.id !== "opencode")) return null;
  const on = badgesShown();
  const foot = el("div", "usage-foot");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "usage-badges";
  b.textContent = on ? "hide profiles" : "show profiles";
  b.title = "The account each tab's agent spends, as a letter on the tab";
  b.setAttribute("aria-pressed", String(on));
  b.onclick = (e) => {
    e.stopPropagation();
    setBadgesShown(!on);
    renderUsage(root, sources, now, onBadges);
    onBadges?.();
  };
  foot.append(b);
  return foot;
}

/** One row per account: the account, its worst window, and the toggle. */
function renderCollapsed(root: HTMLElement, sources: UsageSource[], now: number, onBadges?: () => void): void {
  const block = el("div", "usage-src");
  for (const s of sources) {
    const row = el("div", `usage-row${s.state !== "ok" ? " stale" : ""}`);
    row.append(...accountBadge(s, sources), el("span", "usage-name", s.label));
    const w = summaryWindow(s.windows);
    if (!w) {
      // "signed out" keeps its row: an account that vanished looks like a bug.
      row.append(el("span", "usage-note", s.state === "signed-out" ? "signed out" : "unavailable"));
    } else {
      row.append(el("span", "usage-kind", kindLabel(w.kind)));
      const b = bar(w.percent);
      const meter = el("span", "usage-meter");
      meter.append(el("span", `usage-fill${tone(w)}`, b.fill), el("span", "usage-track", b.track));
      row.append(meter, el("span", "usage-pct", `${Math.round(w.percent)}%`), el("span", "usage-reset", formatReset(w.resetsAt, now)));
      if (s.state !== "ok") row.title = `last read ${new Date(s.checkedAt).toLocaleTimeString()}`;
    }
    block.append(row);
  }
  block.firstElementChild?.append(toggle(root, sources, now, false, onBadges));
  root.append(block);
  const foot = badgesToggle(root, sources, now, onBadges);
  if (foot) root.append(foot);
}

function toggle(root: HTMLElement, sources: UsageSource[], now: number, open: boolean, onBadges?: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "usage-toggle";
  b.textContent = open ? "\u25be" : "\u25b8";
  b.setAttribute("aria-label", open ? "Collapse quota" : "Expand quota");
  b.setAttribute("aria-expanded", String(open));
  b.onclick = (e) => {
    e.stopPropagation();
    setExpanded(!open);
    renderUsage(root, sources, now, onBadges);
  };
  return b;
}
