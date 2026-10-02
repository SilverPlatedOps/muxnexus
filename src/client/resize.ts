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
