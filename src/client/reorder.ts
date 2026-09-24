/**
 * Reordering by dragging, for the sidebar's sessions and the tab strip's tabs.
 *
 * Pointer Events rather than HTML5 drag-and-drop: the latter does not work on
 * iOS, and this has to work from an iPad. On touch the drag arms on a long press
 * so it does not fight the page's own scrolling; with a mouse it arms as soon as
 * the pointer has moved far enough to mean it.
 */

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
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let marker: HTMLElement | null = null;
  let dragged: HTMLElement | null = null;

  const pos = (e: PointerEvent) => (horizontal ? e.clientX : e.clientY);

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
    marker?.remove();
    marker = null;
    dragged?.classList.remove("dragging");
    dragged = null;
    container.classList.remove("reordering");
    armed = false;
    from = -1;
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

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const rows = opts.rows();
    const row = rows.find((r) => r.contains(e.target as Node));
    if (!row) return;
    // Buttons inside a row keep working; only the row's own body starts a drag.
    if ((e.target as HTMLElement).closest("button, input") && e.pointerType !== "touch") return;
    from = rows.indexOf(row);
    dragged = row;
    startPos = pos(e);
    armed = false;
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
        if (Math.abs(pos(e) - startPos) > slopPx) clear();
        return;
      }
      if (Math.abs(pos(e) - startPos) <= slopPx) return;
      armed = true;
      container.classList.add("reordering");
      dragged?.classList.add("dragging");
      // Throws if the pointer is already gone (released between frames, or a
      // synthetic event). Capture is a nicety; losing it must not abort the drag.
      try { container.setPointerCapture?.(e.pointerId); } catch { /* keep dragging */ }
    }
    e.preventDefault();
    const base = container.getBoundingClientRect();
    showMarker(dropIndex(rects(), pos(e) - (horizontal ? base.left : base.top)));
  }

  function onPointerUp(e: PointerEvent) {
    if (from < 0) return;
    if (!armed) return clear();
    const base = container.getBoundingClientRect();
    const to = dropIndex(rects(), pos(e) - (horizontal ? base.left : base.top));
    const n = opts.rows().length;
    const order = moveItem([...Array(n).keys()], from, to);
    const moved = order.some((v, i) => v !== i);
    clear();
    if (moved) opts.commit(order);
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", clear);

  return () => {
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", clear);
    clear();
  };
}
