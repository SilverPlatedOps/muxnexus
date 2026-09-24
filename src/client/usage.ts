import type { UsageSource, UsageWindow } from "../shared/protocol";

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

/**
 * Time until a reset, at a glance: "3h44", "2d22", "12m". Coarse on purpose --
 * the exact second a limit lifts has never mattered, and a ticking clock in the
 * corner of the eye is a distraction.
 */
export function formatReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, "0")}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 === 0 ? "" : String(hours % 24).padStart(2, "0")}`;
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
 */
export function renderUsage(root: HTMLElement, sources: UsageSource[], now: number = Date.now()): void {
  root.replaceChildren();
  if (sources.length === 0) return;
  const open = expanded();
  root.classList.toggle("expanded", open);
  if (!open) return renderCollapsed(root, sources, now);
  for (const s of sources) {
    const block = el("div", "usage-src");
    if (s.state !== "ok" && s.windows.length === 0) {
      const row = el("div", "usage-row");
      row.append(
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
      row.append(el("span", "usage-name", i === 0 ? s.label : ""));
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
  root.firstElementChild?.firstElementChild?.append(toggle(root, sources, now, true));
}

/** One row per account: the account, its worst window, and the toggle. */
function renderCollapsed(root: HTMLElement, sources: UsageSource[], now: number): void {
  const block = el("div", "usage-src");
  for (const s of sources) {
    const row = el("div", `usage-row${s.state !== "ok" ? " stale" : ""}`);
    row.append(el("span", "usage-name", s.label));
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
  block.firstElementChild?.append(toggle(root, sources, now, false));
  root.append(block);
}

function toggle(root: HTMLElement, sources: UsageSource[], now: number, open: boolean): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "usage-toggle";
  b.textContent = open ? "\u25be" : "\u25b8";
  b.setAttribute("aria-label", open ? "Collapse quota" : "Expand quota");
  b.setAttribute("aria-expanded", String(open));
  b.onclick = (e) => {
    e.stopPropagation();
    setExpanded(!open);
    renderUsage(root, sources, now);
  };
  return b;
}
