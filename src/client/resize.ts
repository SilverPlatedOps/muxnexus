/**
 * A side panel's width, dragged by a grip on its inner edge and remembered per
 * browser like the folded groups. The width is a CSS variable on the layout, so
 * the grid gives the terminal whatever is left.
 */

export function clampWidth(w: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, w)));
}

export interface ResizeOptions {
  grip: HTMLElement;
  panel: HTMLElement;
  /** The element carrying the variable. */
  host: HTMLElement;
  cssVar: string;
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  /** Which edge of the panel the grip is on: the sidebar's right, the notes panel's left. */
  edge: "left" | "right";
}

export function makeResizable(o: ResizeOptions): void {
  const read = (): number => {
    try {
      const v = Number(localStorage.getItem(o.storageKey));
      return v > 0 ? clampWidth(v, o.min, o.max) : o.fallback;
    } catch {
      return o.fallback;
    }
  };
  let width = read();
  const apply = () => {
    o.host.style.setProperty(o.cssVar, `${width}px`);
    o.grip.setAttribute("aria-valuenow", String(width));
  };
  const save = () => {
    try { localStorage.setItem(o.storageKey, String(width)); } catch { /* this browser forgets */ }
  };
  const set = (w: number) => {
    width = clampWidth(w, o.min, o.max);
    apply();
  };
  apply();
  o.grip.setAttribute("aria-valuemin", String(o.min));
  o.grip.setAttribute("aria-valuemax", String(o.max));

  o.grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { o.grip.setPointerCapture(e.pointerId); } catch { /* keep dragging */ }
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const r = o.panel.getBoundingClientRect();
      set(o.edge === "right" ? ev.clientX - r.left : r.right - ev.clientX);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      save();
      o.grip.removeEventListener("pointermove", move);
      o.grip.removeEventListener("pointerup", up);
      o.grip.removeEventListener("pointercancel", up);
    };
    o.grip.addEventListener("pointermove", move);
    o.grip.addEventListener("pointerup", up);
    o.grip.addEventListener("pointercancel", up);
  });
  o.grip.addEventListener("dblclick", () => { set(o.fallback); save(); });
  o.grip.addEventListener("keydown", (e) => {
    // Arrow keys move the edge the way it looks: right widens the sidebar, narrows the notes.
    const grow = o.edge === "right" ? 1 : -1;
    if (e.key === "ArrowLeft") set(width - 16 * grow);
    else if (e.key === "ArrowRight") set(width + 16 * grow);
    else return;
    e.preventDefault();
    save();
  });
}

/**
 * The system overview's share of the height it splits with the note, dragged
 * by a grip on its top edge. A share, not pixels, so a resized window keeps the
 * split; held under half, so the note always has the larger part.
 */
export const MAX_SHARE = 0.5;

/** The share a pointer at `y` asks for: its height above the area's foot. */
export function shareAt(y: number, top: number, bottom: number): number {
  return (bottom - y) / (bottom - top);
}

/**
 * Between the overview's line (`floor` px) and half, and no more than the
 * overview has to show (`natural` px), so the share kept is the one seen.
 */
export function clampShare(share: number, area: number, natural: number, floor: number): number {
  const hi = Math.min(MAX_SHARE, natural / area);
  const lo = Math.min(floor / area, hi);
  return Math.round(Math.max(lo, Math.min(hi, share)) * 1000) / 1000;
}

export function storedShare(raw: string | null, fallback: number): number {
  const v = Number(raw);
  return v > 0 ? Math.min(MAX_SHARE, v) : fallback;
}

export interface SplitOptions {
  grip: HTMLElement;
  /** The overview, which carries the variable. */
  panel: HTMLElement;
  /** The height it splits with the note, in the viewport. */
  area: () => { top: number; bottom: number };
  /** Its height if it were not held to its share. */
  natural: () => number;
  floor: number;
  cssVar: string;
  storageKey: string;
  fallback: number;
}

export function makeSplit(o: SplitOptions): void {
  let share = o.fallback;
  try { share = storedShare(localStorage.getItem(o.storageKey), o.fallback); } catch { /* the default */ }
  const apply = () => {
    o.panel.style.setProperty(o.cssVar, String(share));
    o.grip.setAttribute("aria-valuenow", String(Math.round(share * 100)));
  };
  const save = () => {
    try { localStorage.setItem(o.storageKey, String(share)); } catch { /* this browser forgets */ }
  };
  const set = (s: number) => {
    const a = o.area();
    share = clampShare(s, a.bottom - a.top, o.natural(), o.floor);
    apply();
  };
  apply();
  o.grip.setAttribute("aria-valuemin", "0");
  o.grip.setAttribute("aria-valuemax", String(MAX_SHARE * 100));

  o.grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { o.grip.setPointerCapture(e.pointerId); } catch { /* keep dragging */ }
    document.body.classList.add("resizing-row");
    const move = (ev: PointerEvent) => {
      const a = o.area();
      set(shareAt(ev.clientY, a.top, a.bottom));
    };
    const up = () => {
      document.body.classList.remove("resizing-row");
      save();
      o.grip.removeEventListener("pointermove", move);
      o.grip.removeEventListener("pointerup", up);
      o.grip.removeEventListener("pointercancel", up);
    };
    o.grip.addEventListener("pointermove", move);
    o.grip.addEventListener("pointerup", up);
    o.grip.addEventListener("pointercancel", up);
  });
  o.grip.addEventListener("dblclick", () => { share = o.fallback; apply(); save(); });
  o.grip.addEventListener("keydown", (e) => {
    // Up raises the edge, so the overview grows.
    if (e.key === "ArrowUp") set(share + 0.05);
    else if (e.key === "ArrowDown") set(share - 0.05);
    else return;
    e.preventDefault();
    save();
  });
}
