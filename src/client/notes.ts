/**
 * A window's note, in a pane beside the terminals: somewhere to think and draft
 * the next prompt. It belongs to the terminal pane that last had the keys, so
 * clicking into the note never changes whose note it is.
 *
 * The text lives on the server (`note-open` / `note-save`), so every device sees
 * one note. Its place on screen -- which side, how wide -- is this browser's.
 */
import type { ClientMessage, ServerMessage, WindowInfo } from "../shared/protocol";
import { tabLabel } from "./labels";

export type NoteSide = "left" | "right";

/** A save this long after the last keystroke. */
const SAVE_MS = 500;
const MIN_NOTE = 240;
/** What the terminals keep, at least, beside an open note. */
const MIN_TERMS = 320;
const KEY = "muxnexus.note";

/** Width of the note for a pointer at `x`, kept to what leaves the terminals room. */
export function noteWidth(rect: { left: number; width: number }, x: number, side: NoteSide): number {
  const w = side === "right" ? rect.left + rect.width - x : x - rect.left;
  return Math.round(Math.max(MIN_NOTE, Math.min(rect.width - MIN_TERMS, w)));
}

/**
 * Whether another device's save may replace what this editor shows. Never while
 * it is being typed in or holds an edit not yet sent: last write wins on disk,
 * not inside the box under your cursor.
 */
export function takesRemote(editing: { focused: boolean; dirty: boolean }): boolean {
  return !editing.focused && !editing.dirty;
}

export interface NoteElements {
  panes: HTMLElement;
  pane: HTMLElement;
  divider: HTMLElement;
  text: HTMLTextAreaElement;
  button: HTMLElement;
}

export interface NotesHost {
  send(m: ClientMessage): boolean;
  session(): string | null;
  /** The window whose note this is: the one in the terminal pane that last had focus. */
  owner(): WindowInfo | undefined;
  phone(): boolean;
  focusTerminal(): void;
}

export interface Notes {
  readonly open: boolean;
  toggle(): void;
  show(): void;
  /** The owner may have changed: a state push, a focus move. */
  sync(): void;
  receive(m: Extract<ServerMessage, { t: "note" }>): void;
  /** A note was deleted: if it is the one shown, its window starts a new one. */
  deleted(noteId: string): void;
  /** The socket is back: send what it missed, or ask again for what never came. */
  reconnected(): void;
}

const ICON = {
  zoom: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10,2.5 13.5,2.5 13.5,6"></polyline><polyline points="6,13.5 2.5,13.5 2.5,10"></polyline><line x1="13.5" y1="2.5" x2="9.5" y2="6.5"></line><line x1="2.5" y1="13.5" x2="6.5" y2="9.5"></line></svg>',
  unzoom: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="13.5,6 10,6 10,2.5"></polyline><polyline points="2.5,10 6,10 6,13.5"></polyline><line x1="10" y1="6" x2="14" y2="2"></line><line x1="6" y1="10" x2="2" y2="14"></line></svg>',
  close: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"></line><line x1="12" y1="4" x2="4" y2="12"></line></svg>',
  swap: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="11,2.5 13.5,5 11,7.5"></polyline><line x1="13.5" y1="5" x2="3" y2="5"></line><polyline points="5,8.5 2.5,11 5,13.5"></polyline><line x1="2.5" y1="11" x2="13" y2="11"></line></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "row-btn");
  b.type = "button";
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

function load(): { side: NoteSide; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { side: v.side === "left" ? "left" : "right", width: Number.isFinite(v.width) ? v.width : 420 };
  } catch {
    return { side: "right", width: 420 };
  }
}

export function createNotes(els: NoteElements, host: NotesHost): Notes {
  let open = false;
  let zoomed = false;
  let { side, width } = load();

  /** The window shown, and its note's id once the server has answered for it. */
  let windowId: string | null = null;
  let noteId: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const remember = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ side, width })); } catch { /* this browser forgets */ }
  };

  // ---- the header ----
  const head = el("div", "pane-head note-head");
  const mark = el("span", "glyph note-glyph", "✎");
  const label = el("span", "label");
  const swap = iconButton(ICON.swap, "Move to the other side", () => {
    side = side === "left" ? "right" : "left";
    remember();
    layout();
  });
  const zoom = iconButton(ICON.zoom, "Zoom", () => { zoomed = !zoomed; layout(); });
  const close = iconButton(ICON.close, "Close note", () => hide());
  head.append(mark, label, el("span", "spacer"), swap, zoom, close);
  els.pane.prepend(head);

  const zone = el("div", "drop-zone");
  zone.hidden = true;
  els.panes.append(zone);

  function layout() {
    const full = open && (zoomed || host.phone());
    els.pane.hidden = !open;
    els.divider.hidden = !open || full;
    els.panes.classList.toggle("note-open", open);
    els.panes.classList.toggle("note-left", side === "left");
    els.panes.classList.toggle("note-full", full);
    els.pane.style.flex = full ? "1 1 0" : `0 0 ${width}px`;
    els.button.classList.toggle("on", open);
    els.button.setAttribute("aria-pressed", String(open));
    zoom.innerHTML = zoomed ? ICON.unzoom : ICON.zoom;
    zoom.title = zoomed ? "Show the terminals too" : "Zoom";
    swap.hidden = full;
    zoom.hidden = host.phone();
  }

  function paintHead() {
    const w = host.owner();
    label.textContent = w ? tabLabel(w) : "";
    els.pane.setAttribute("aria-label", w ? `Note for ${tabLabel(w)}` : "Note");
  }

  function flush() {
    clearTimeout(timer);
    if (!dirty || !noteId) return;
    if (host.send({ t: "note-save", noteId, text: els.text.value })) dirty = false;
  }

  function sync() {
    if (!open) return;
    paintHead();
    const w = host.owner();
    const id = w?.id ?? null;
    if (id === windowId) return;
    // The old note's edit goes out under the old note's id before anything of
    // the new one arrives: a late save must never land on the wrong window.
    flush();
    windowId = id;
    noteId = null;
    dirty = false;
    els.text.value = "";
    els.text.readOnly = true;
    els.text.placeholder = id ? "Loading…" : "No window";
    const session = host.session();
    if (id && session) host.send({ t: "note-open", session, id });
  }

  function show() {
    if (!open) {
      open = true;
      layout();
      sync();
    }
    els.text.focus();
  }

  function hide() {
    if (!open) return;
    flush();
    open = false;
    zoomed = false;
    windowId = null;
    noteId = null;
    layout();
    host.focusTerminal();
  }

  els.text.addEventListener("input", () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_MS);
  });
  els.text.addEventListener("blur", flush);
  // iPad Safari drops a background tab without warning: save on the way out.
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  // ---- resizing ----
  els.divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { els.divider.setPointerCapture(e.pointerId); } catch { /* keep dragging */ }
    els.panes.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      width = noteWidth(els.panes.getBoundingClientRect(), ev.clientX, side);
      layout();
    };
    const up = () => {
      els.panes.classList.remove("resizing");
      remember();
      els.divider.removeEventListener("pointermove", move);
      els.divider.removeEventListener("pointerup", up);
      els.divider.removeEventListener("pointercancel", up);
    };
    els.divider.addEventListener("pointermove", move);
    els.divider.addEventListener("pointerup", up);
    els.divider.addEventListener("pointercancel", up);
  });

  // ---- dragging the header to the other side ----
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button") || host.phone() || zoomed) return;
    e.preventDefault(); // no text selection riding along
    try { head.setPointerCapture(e.pointerId); } catch { /* still tracked while over the header */ }
    const startX = e.clientX;
    let armed = false;
    const target = (x: number): NoteSide => {
      const r = els.panes.getBoundingClientRect();
      return x < r.left + r.width / 2 ? "left" : "right";
    };
    const move = (ev: PointerEvent) => {
      if (!armed && Math.abs(ev.clientX - startX) < 8) return;
      if (!armed) {
        armed = true;
        els.panes.classList.add("note-dragging");
      }
      const to = target(ev.clientX);
      const r = els.panes.getBoundingClientRect();
      zone.style.left = to === "left" ? "8px" : `${r.width / 2 + 4}px`;
      zone.style.width = `${r.width / 2 - 12}px`;
      zone.replaceChildren(Object.assign(el("div", "say"), { textContent: to === side ? "Keep here" : "Move note here" }));
      zone.hidden = false;
    };
    const up = (ev: PointerEvent) => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      zone.hidden = true;
      els.panes.classList.remove("note-dragging");
      if (!armed || ev.type === "pointercancel") return;
      side = target(ev.clientX);
      remember();
      layout();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });

  els.button.onclick = () => (open ? hide() : show());
  layout();

  return {
    get open() { return open; },
    deleted(id) {
      if (!open || id !== noteId) return;
      clearTimeout(timer);
      dirty = false;
      windowId = null;
      sync();
    },
    reconnected() {
      if (!open) return;
      if (noteId) return flush();
      windowId = null;
      sync();
    },
    toggle: () => (open ? hide() : show()),
    show,
    sync,
    receive(m) {
      if (m.windowId !== undefined) {
        // The answer to an open: only for the window still shown.
        if (m.windowId !== windowId || noteId !== null) return;
        noteId = m.noteId;
        els.text.value = m.text;
        els.text.readOnly = false;
        els.text.placeholder = "Thoughts, the next prompt…";
        dirty = false;
        return;
      }
      if (m.noteId !== noteId) return;
      if (takesRemote({ focused: document.activeElement === els.text, dirty })) els.text.value = m.text;
    },
  };
}
