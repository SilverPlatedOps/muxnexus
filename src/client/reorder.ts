/**
 * Reordering by dragging, for the sidebar's sessions and the tab strip's tabs.
 *
 * Pointer Events rather than HTML5 drag-and-drop: the latter does not work on
 * iOS, and this has to work from an iPad. On touch the drag arms on a long press
 * so it does not fight the page's own scrolling; with a mouse it arms as soon as
 * the pointer has moved far enough to mean it.
 *
 * A whole row drags, not a grip on it. The row's body is a button whose click
 * attaches or selects and whose double-click renames; the travel a mouse drag
 * needs before arming is what keeps a click a click, and the click the browser
 * fires after a drag is swallowed so dropping a row does not also open it.
 * Only the row's real controls -- its rename field, its menu button, the menu's
 * own buttons -- never start a drag.
 */

/**
 * Whether the row menus also offer Move up/down and Move left/right. Off while
 * dragging covers it -- a long press arms it on touch too -- and kept rather
 * than deleted, in case a keyboard-only way to reorder is wanted back.
 */
export const MENU_REORDER = false;

export interface Rect {
  top: number;
  height: number;
}

/**
 * Where a pointer at `y` would insert, as an index into `rects` (0..n). A row is
 * passed once the pointer is beyond its midpoint, which is what makes the gap
 * open under the cursor rather than a row ahead of it.
 */
export function dropIndex(rects: readonly Rect[], y: number): number {
  let i = 0;
  for (const r of rects) {
    if (y <= r.top + r.height / 2) break;
    i++;
  }
  return i;
}

/**
 * `items` with the entry at `from` moved so it sits at `to`, where `to` is an
 * insertion point in the *original* list. Removing the item first shifts every
 * later index down by one, which is why dropping at `from + 1` is a no-op rather
 * than a swap.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}

/**
 * `incoming` rearranged to the order the user just dragged into, while the
 * server catches up. A session that appeared since goes to the end; one that
 * disappeared is dropped. Without this a `state` already in flight when the drag
 * finished snaps the list back to the old order for one frame.
 */
export function applyPendingOrder<T>(
  incoming: readonly T[],
  pending: readonly string[] | null,
  key: (item: T) => string = (item) => (item as { name: string }).name,
): T[] {
  if (!pending) return [...incoming];
  const left = new Map(incoming.map((s) => [key(s), s]));
  const out: T[] = [];
  for (const name of pending) {
    const hit = left.get(name);
    if (hit) { out.push(hit); left.delete(name); }
  }
  return [...out, ...left.values()];
}

/** Whether the server's order now matches what we asked for, ignoring comings and goings. */
export function orderSatisfied<T>(
  incoming: readonly T[],
  pending: readonly string[],
  key: (item: T) => string = (item) => (item as { name: string }).name,
): boolean {
  const got = incoming.map(key).filter((n) => pending.includes(n));
  const want = pending.filter((n) => incoming.some((s) => key(s) === n));
  return got.length === want.length && got.every((n, i) => n === want[i]);
}

export interface ReorderOptions {
  /** Rows that may be dragged, in their current visual order. */
  rows(): HTMLElement[];
  /** Called with the new order, as indices into the list `rows()` returned. */
  commit(order: number[]): void;
  /** Long-press before a touch drag arms, in ms. */
  holdMs?: number;
  /** Pointer travel before a mouse drag arms, in px. */
  slopPx?: number;
  /** "y" for a stacked list (the sidebar), "x" for a strip (the tabs). */
  axis?: "x" | "y";
  /** Somewhere outside the list a row can also be dropped on, instead of reordered. */
  outside?: OutsideDrop;
}

/**
 * A drop target beyond the list -- the terminal, for a tab opened beside it.
 * Pointer capture keeps the drag's moves coming once it leaves the list, so the
 * list asks the target first and only reorders when it declines.
 */
export interface OutsideDrop {
  /** The pointer is at x, y mid-drag of row `from`: true to take the drop instead of reordering. */
  over(from: number, x: number, y: number): boolean;
  /** The target stopped being under the pointer, or the drag ended without it. */
  leave(): void;
  /** Row `from` was released at x, y while `over` held it. */
  drop(from: number, x: number, y: number): void;
}

const HOLD_MS = 350;
const SLOP_PX = 5;

/**
 * Make a container's rows draggable. Returns a teardown function.
 *
 * The DOM work is deliberately thin: everything that decides *what the new order
 * is* lives in `dropIndex` and `moveItem` above, which are covered by tests.
 */
export function makeReorderable(container: HTMLElement, opts: ReorderOptions): () => void {
  const holdMs = opts.holdMs ?? HOLD_MS;
  const slopPx = opts.slopPx ?? SLOP_PX;
  const horizontal = opts.axis === "x";

  let from = -1;
  let armed = false;
  let startPos = 0;
  let startX = 0;
  let startY = 0;
  /** The outside target has taken this drag, so a release drops there. */
  let claimed = false;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let marker: HTMLElement | null = null;
  let dragged: HTMLElement | null = null;

  const pos = (e: PointerEvent) => (horizontal ? e.clientX : e.clientY);
  // Travel before a drag means it. Along the list's axis only, unless there is
  // somewhere else to drop: a tab dragged straight down onto the terminal
  // barely moves along the strip, and would otherwise never arm.
  const travel = (e: PointerEvent) =>
    opts.outside ? Math.hypot(e.clientX - startX, e.clientY - startY) : Math.abs(pos(e) - startPos);

  /** Row boxes in the axis we care about, relative to the container's scroll box. */
  function rects(): Rect[] {
    const base = container.getBoundingClientRect();
    return opts.rows().map((r) => {
      const b = r.getBoundingClientRect();
      return horizontal
        ? { top: b.left - base.left, height: b.width }
        : { top: b.top - base.top, height: b.height };
    });
  }

  function clear() {
    clearTimeout(holdTimer);
    if (claimed) opts.outside?.leave();
    claimed = false;
    marker?.remove();
    marker = null;
    dragged?.classList.remove("dragging");
    dragged = null;
    container.classList.remove("reordering");
    armed = false;
    from = -1;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", clear);
  }

  function showMarker(at: number) {
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "drop-marker";
      container.append(marker);
    }
    const all = rects();
    const edge = at < all.length ? all[at].top : (all.length ? all[all.length - 1].top + all[all.length - 1].height : 0);
    // rects() are measured from the container's visible edge; the marker is laid
    // out from its scrolled content, which the tab strip usually is.
    const base = edge + (horizontal ? container.scrollLeft : container.scrollTop);
    if (horizontal) {
      marker.style.left = `${base}px`;
      marker.style.top = "";
    } else {
      marker.style.top = `${base}px`;
      marker.style.left = "";
    }
  }

  /**
   * Eat the click the browser fires after a drag ends, wherever it lands:
   * pointer capture on the container can retarget it. Whichever comes first
   * clears it -- the click itself, the next pointerdown, or a short wait for
   * a drop that produced no click at all.
   */
  function swallowNextClick() {
    const off = () => {
      document.removeEventListener("click", eat, true);
      document.removeEventListener("pointerdown", off, true);
      clearTimeout(timer);
    };
    const eat = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
      off();
    };
    const timer = setTimeout(off, 200);
    document.addEventListener("click", eat, true);
    document.addEventListener("pointerdown", off, true);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rows = opts.rows();
    const row = rows.find((r) => r.contains(e.target as Node));
    if (!row) return;
    // The row's controls keep their own press: the rename field selects text,
    // the icon buttons and the menu's buttons act. The row's body is a button
    // too, but its click is a tap, and the slop below tells a tap from a drag.
    if ((e.target as HTMLElement).closest("input, .row-btn, .btn")) return;
    from = rows.indexOf(row);
    dragged = row;
    startPos = pos(e);
    startX = e.clientX;
    startY = e.clientY;
    armed = false;
    // On the document, not the list: capture only starts once the drag arms,
    // and a quick flick's first move can already be off a 34px strip -- the
    // list would never hear of it, and the drag would never start.
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", clear);
    if (e.pointerType === "touch") {
      holdTimer = setTimeout(() => {
        armed = true;
        container.classList.add("reordering");
        row.classList.add("dragging");
        showMarker(from);
      }, holdMs);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (from < 0) return;
    if (!armed) {
      if (e.pointerType === "touch") {
        // Moved before the hold elapsed: this is a scroll, not a drag.
        if (travel(e) > slopPx) clear();
        return;
      }
      if (travel(e) <= slopPx) return;
      armed = true;
      container.classList.add("reordering");
      dragged?.classList.add("dragging");
      // Throws if the pointer is already gone (released between frames, or a
      // synthetic event). Capture is a nicety; losing it must not abort the drag.
      try { container.setPointerCapture?.(e.pointerId); } catch { /* keep dragging */ }
    }
    e.preventDefault();
    if (opts.outside?.over(from, e.clientX, e.clientY)) {
      claimed = true;
      marker?.remove();
      marker = null;
      return;
    }
    if (claimed) {
      claimed = false;
      opts.outside?.leave();
    }
    const base = container.getBoundingClientRect();
    showMarker(dropIndex(rects(), pos(e) - (horizontal ? base.left : base.top)));
  }

  function onPointerUp(e: PointerEvent) {
    if (from < 0) return;
    if (!armed) return clear();
    // Armed at all, moved or not: a long press that went nowhere still ends
    // with a click, and that press was not a tap either.
    swallowNextClick();
    if (claimed) {
      const row = from;
      claimed = false; // dropped, not abandoned: no leave()
      clear();
      opts.outside?.drop(row, e.clientX, e.clientY);
      return;
    }
    const base = container.getBoundingClientRect();
    const to = dropIndex(rects(), pos(e) - (horizontal ? base.left : base.top));
    const n = opts.rows().length;
    const order = moveItem([...Array(n).keys()], from, to);
    const moved = order.some((v, i) => v !== i);
    clear();
    if (moved) opts.commit(order);
  }

  // Pointer events cannot stop a touch from turning into a scroll; only a
  // non-passive touchmove can. The finger has not moved during the hold, so
  // nothing is scrolling yet, and refusing the first move keeps it that way.
  // Before the hold elapses the move is left alone, and it is a scroll.
  function onTouchMove(e: TouchEvent) {
    if (armed) e.preventDefault();
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("touchmove", onTouchMove, { passive: false });

  return () => {
    container.removeEventListener("pointerdown", onPointerDown);
    clear();
    container.removeEventListener("touchmove", onTouchMove);
    clear();
  };
}
