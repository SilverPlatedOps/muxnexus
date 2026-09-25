/**
 * Two tabs of one session side by side.
 *
 * The main pane is the terminal that was always there, attached to the session
 * itself. The other -- "beside" -- is a second terminal on its own socket,
 * attached through a private view the server makes for it (`attach-view`), so
 * each pane has its own current window. Nothing about the split is stored in
 * tmux: it is this browser's arrangement, as a window's size on screen is.
 */
import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { agentTitle, GLYPH, windowGlyph } from "./agent";
import { tabLabel } from "./labels";
import { Connection } from "./socket";
import { createTerminal, type TerminalView } from "./terminal";

export type Side = "left" | "right";

export interface SplitState {
  /** The window the beside pane shows, by tmux id. */
  windowId: string;
  side: Side;
}

export const otherSide = (s: Side): Side => (s === "left" ? "right" : "left");

/** Which pane a pointer at `x` is over: the halves, or either side of the divider at `at` once split. */
export function dropSide(rect: { left: number; width: number }, x: number, at = 0.5): Side {
  return x < rect.left + rect.width * at ? "left" : "right";
}

export type DropPlan =
  | { kind: "none" }
  /** Show `windowId` in the beside pane, placed on `side`. */
  | { kind: "beside"; windowId: string; side: Side }
  /** Show `windowId` in the main pane instead. */
  | { kind: "main"; windowId: string }
  /** The two panes trade sides. */
  | { kind: "swap" };

/**
 * What dropping tab `dragged` on `side` means. A pane shows what is dropped on
 * it; a tab already on screen dropped on the other pane swaps the two, and
 * dropped where it already is does nothing.
 */
export function dropPlan(split: SplitState | null, mainWindow: string | null, dragged: string, side: Side): DropPlan {
  if (!split) {
    return dragged === mainWindow ? { kind: "none" } : { kind: "beside", windowId: dragged, side };
  }
  if (dragged === split.windowId) return side === split.side ? { kind: "none" } : { kind: "swap" };
  if (dragged === mainWindow) return side === split.side ? { kind: "swap" } : { kind: "none" };
  return side === split.side ? { kind: "beside", windowId: dragged, side } : { kind: "main", windowId: dragged };
}

/**
 * The split after a `state` push, or null when it has to go: the main pane
 * moved to another session, the beside window closed, or the main pane now
 * shows that same window (tmux keys can walk it there).
 */
export function splitAfter<T extends SplitState & { session: string }>(
  split: T,
  sessions: readonly SessionInfo[],
  current: string | null,
): T | null {
  if (current !== split.session) return null;
  const s = sessions.find((x) => x.name === current);
  if (!s) return null;
  const beside = s.windows.find((w) => w.id === split.windowId);
  if (!beside || beside.active) return null;
  return split;
}

// ---------------------------------------------------------------------------

export interface SplitElements {
  shell: HTMLElement;
  mainPane: HTMLElement;
  sidePane: HTMLElement;
  sideTerm: HTMLElement;
  divider: HTMLElement;
}

export interface SplitHost {
  wsUrl: string;
  /** Whether the screen has room for two terminals at all. */
  enabled(): boolean;
  /** Make the main pane show `id` (tmux select-window on the session). */
  selectMain(id: string): void;
  focusMain(): void;
  toast(message: string): void;
  /** The split opened, closed or moved: the tab strip marks the beside tab. */
  changed(): void;
}

export interface Split {
  readonly state: SplitState | null;
  open(session: string, windowId: string, side: Side): void;
  close(): void;
  render(sessions: SessionInfo[], current: string | null): void;
  focusSide(): void;
  /** Drag hooks for the tab strip: a tab dragged over the terminal. */
  over(windowId: string, x: number, y: number): boolean;
  leave(): void;
  drop(windowId: string, x: number, y: number): void;
}

const ICON = {
  zoom: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10,2.5 13.5,2.5 13.5,6"></polyline><polyline points="6,13.5 2.5,13.5 2.5,10"></polyline><line x1="13.5" y1="2.5" x2="9.5" y2="6.5"></line><line x1="2.5" y1="13.5" x2="6.5" y2="9.5"></line></svg>',
  unzoom: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="13.5,6 10,6 10,2.5"></polyline><polyline points="2.5,10 6,10 6,13.5"></polyline><line x1="10" y1="6" x2="14" y2="2"></line><line x1="6" y1="10" x2="2" y2="14"></line></svg>',
  close: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"></line><line x1="12" y1="4" x2="4" y2="12"></line></svg>',
  split: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"></rect><line x1="8" y1="2.5" x2="8" y2="13.5"></line></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

type Pane = "main" | "side";

/** A pane's header: what it shows, and its own zoom and close. */
function header(onZoom: () => void, onClose: () => void) {
  const head = el("div", "pane-head");
  const glyph = el("span", "glyph none");
  const label = el("span", "label");
  const zoom = el("button", "row-btn");
  zoom.type = "button";
  zoom.onclick = (e) => { e.stopPropagation(); onZoom(); };
  const close = el("button", "row-btn");
  close.type = "button";
  close.innerHTML = ICON.close;
  close.onclick = (e) => { e.stopPropagation(); onClose(); };
  head.append(glyph, label, el("span", "spacer"), zoom, close);
  return {
    head,
    paint(w: WindowInfo | undefined, zoomed: boolean) {
      const g = w ? windowGlyph(w) : "none";
      glyph.className = `glyph ${g}`;
      glyph.textContent = GLYPH[g];
      glyph.title = w ? agentTitle(w) : "";
      label.textContent = w ? tabLabel(w) : "";
      zoom.innerHTML = zoomed ? ICON.unzoom : ICON.zoom;
      const name = w ? tabLabel(w) : "this side";
      zoom.setAttribute("aria-label", zoomed ? "Show both sides" : `Zoom ${name}`);
      zoom.title = zoomed ? "Show both sides" : "Zoom";
      close.setAttribute("aria-label", `Close ${name}`);
      close.title = "Close this side";
    },
  };
}

export function createSplit(els: SplitElements, host: SplitHost): Split {
  let split: (SplitState & { session: string }) | null = null;
  let conn: Connection | null = null;
  let sessions: SessionInfo[] = [];
  let current: string | null = null;
  /** The left pane's share of the width. */
  let ratio = 0.5;
  let zoomed: Pane | null = null;
  let focused: Pane = "main";

  /**
   * Made on the first open, once its pane is on screen: xterm measures its
   * cells when it opens, and measured inside a hidden pane it sizes itself a few
   * rows taller than it draws -- which pushes tmux's status line off the bottom.
   */
  let sideTerm: TerminalView | null = null;
  const term = (): TerminalView =>
    (sideTerm ??= createTerminal(els.sideTerm, {
      onInput: (d) => conn?.sendInput(d),
      onResize: (cols, rows) => conn?.send({ t: "resize", cols, rows }),
    }));

  const mainHead = header(() => toggleZoom("main"), () => closeMain());
  const sideHead = header(() => toggleZoom("side"), () => close());
  els.mainPane.prepend(mainHead.head);
  els.sidePane.prepend(sideHead.head);

  const zone = el("div", "drop-zone");
  zone.hidden = true;
  els.shell.append(zone);
  const ghost = el("div", "drag-ghost");
  ghost.hidden = true;
  document.body.append(ghost);

  const windows = () => sessions.find((s) => s.name === current)?.windows ?? [];
  const mainWindow = () => windows().find((w) => w.active);

  function connect(session: string, windowId: string) {
    conn?.close();
    const t = term();
    t.reset();
    t.fit();
    const c = new Connection(host.wsUrl, {
      onOpen() {
        c.send({ t: "resize", cols: t.cols, rows: t.rows });
        c.send({ t: "attach-view", session, id: windowId });
      },
      onClose() {},
      onMessage(m) {
        if (m.t === "detached") close();
        else if (m.t === "error") host.toast(m.message);
      },
      onOutput: (b) => t.write(b),
    });
    conn = c;
    c.connect();
  }

  function layout() {
    const on = split !== null;
    els.shell.classList.toggle("split", on);
    els.shell.classList.toggle("beside-left", on && split!.side === "left");
    els.shell.classList.toggle("zoom-main", on && zoomed === "main");
    els.shell.classList.toggle("zoom-side", on && zoomed === "side");
    els.sidePane.hidden = !on;
    els.divider.hidden = !on;
    els.mainPane.classList.toggle("focused", on && focused === "main");
    els.sidePane.classList.toggle("focused", on && focused === "side");
    const left = on && split!.side === "left" ? els.sidePane : els.mainPane;
    const right = left === els.mainPane ? els.sidePane : els.mainPane;
    left.style.flex = on && !zoomed ? `0 0 ${(ratio * 100).toFixed(2)}%` : "";
    right.style.flex = "";
    els.divider.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    paintHeads();
  }

  function paintHeads() {
    if (!split) return;
    mainHead.paint(mainWindow(), zoomed === "main");
    sideHead.paint(windows().find((w) => w.id === split!.windowId), zoomed === "side");
  }

  function setFocused(p: Pane) {
    if (focused === p) return;
    focused = p;
    layout();
  }

  function open(session: string, windowId: string, side: Side) {
    if (!host.enabled()) return;
    const same = split && split.session === session && split.windowId === windowId;
    split = { session, windowId, side };
    zoomed = null;
    focused = "side";
    layout(); // the pane is on screen before its terminal is made or fitted
    if (!same) connect(session, windowId);
    host.changed();
    term().focus();
  }

  function close() {
    if (!split) return;
    split = null;
    zoomed = null;
    conn?.close();
    conn = null;
    sideTerm?.reset();
    focused = "main";
    layout();
    host.changed();
    host.focusMain();
  }

  /** Closing the main side keeps the other: the main pane takes over its window. */
  function closeMain() {
    if (!split) return;
    const keep = split.windowId;
    close();
    host.selectMain(keep);
  }

  function toggleZoom(p: Pane) {
    zoomed = zoomed === p ? null : p;
    layout();
    if (p === "side") term().focus();
    else host.focusMain();
  }

  els.mainPane.addEventListener("focusin", () => setFocused("main"));
  els.sidePane.addEventListener("focusin", () => setFocused("side"));

  // ---- the divider ----
  const setRatio = (r: number) => {
    ratio = Math.min(0.8, Math.max(0.2, r));
    layout();
  };
  els.divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { els.divider.setPointerCapture(e.pointerId); } catch { /* keep dragging */ }
    els.shell.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const r = els.shell.getBoundingClientRect();
      setRatio((ev.clientX - r.left) / r.width);
    };
    const up = () => {
      els.shell.classList.remove("resizing");
      els.divider.removeEventListener("pointermove", move);
      els.divider.removeEventListener("pointerup", up);
      els.divider.removeEventListener("pointercancel", up);
    };
    els.divider.addEventListener("pointermove", move);
    els.divider.addEventListener("pointerup", up);
    els.divider.addEventListener("pointercancel", up);
  });
  els.divider.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") setRatio(ratio - 0.02);
    else if (e.key === "ArrowRight") setRatio(ratio + 0.02);
    else if (e.key === "Home") setRatio(0.2);
    else if (e.key === "End") setRatio(0.8);
    else return;
    e.preventDefault();
  });

  // ---- a tab dragged over the terminal ----
  function planAt(windowId: string, x: number, y: number): { plan: DropPlan; side: Side } | null {
    if (!host.enabled() || !current) return null;
    const r = els.shell.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    const at = split && !zoomed ? ratio : 0.5;
    const side = dropSide(r, x, at);
    const plan = dropPlan(split, mainWindow()?.id ?? null, windowId, side);
    return plan.kind === "none" ? null : { plan, side };
  }

  function showZone(side: Side, plan: DropPlan, windowId: string) {
    const r = els.shell.getBoundingClientRect();
    const at = split && !zoomed ? ratio : 0.5;
    const cut = r.width * at;
    const inset = 8;
    zone.style.left = `${side === "left" ? inset : cut + inset / 2}px`;
    zone.style.width = `${(side === "left" ? cut : r.width - cut) - inset * 1.5}px`;
    const w = windows().find((x) => x.id === windowId);
    const verb = plan.kind === "swap" ? "Swap sides" : plan.kind === "main" ? "Show here" : "Open beside";
    const say = el("div", "say");
    say.innerHTML = ICON.split;
    say.append(el("span", "", verb));
    if (plan.kind !== "swap" && w) say.append(el("span", "sub", tabLabel(w)));
    zone.replaceChildren(say);
    zone.hidden = false;
  }

  function hideDrag() {
    zone.hidden = true;
    ghost.hidden = true;
  }

  return {
    get state() { return split ? { windowId: split.windowId, side: split.side } : null; },
    open,
    close,
    focusSide() {
      if (!split) return;
      setFocused("side");
      term().focus();
    },
    render(next, cur) {
      sessions = next;
      current = cur;
      if (split && !splitAfter(split, sessions, current)) close();
      else paintHeads();
    },
    over(windowId, x, y) {
      const hit = planAt(windowId, x, y);
      // Over the strip the reorder marker is the feedback; the ghost is only
      // for a drop the terminal would take.
      if (!hit) {
        hideDrag();
        return false;
      }
      const w = windows().find((v) => v.id === windowId);
      ghost.textContent = w ? tabLabel(w) : "";
      ghost.style.left = `${x + 14}px`;
      ghost.style.top = `${y + 10}px`;
      ghost.hidden = false;
      showZone(hit.side, hit.plan, windowId);
      return true;
    },
    leave: hideDrag,
    drop(windowId, x, y) {
      const hit = planAt(windowId, x, y);
      hideDrag();
      if (!hit || !current) return;
      const p = hit.plan;
      if (p.kind === "beside") open(current, p.windowId, p.side);
      else if (p.kind === "main") {
        host.selectMain(p.windowId);
        setFocused("main");
        host.focusMain();
      } else if (p.kind === "swap" && split) {
        split = { ...split, side: otherSide(split.side) };
        ratio = 1 - ratio;
        layout();
      }
    },
  };
}
