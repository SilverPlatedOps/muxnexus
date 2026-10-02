/**
 * The notes panel, down the right of the page: "This window", the note of the
 * window in the terminal pane that last had the keys, and "All notes", every
 * note searchable (explorer.ts). Clicking into the panel never changes whose
 * note "This window" shows.
 *
 * The text lives on the server (`note-open` / `note-save`), so every device sees
 * one note. Whether the panel is open, on which tab, and how wide, is this
 * browser's.
 */
import type { ClientMessage, NoteSummary, ServerMessage, WindowInfo } from "../shared/protocol";
import { createExplorer } from "./explorer";

export type NotesTab = "window" | "all";

/** A save this long after the last keystroke. */
const SAVE_MS = 500;
const KEY = "muxnexus.notes-panel";

/**
 * Whether another device's save may replace what this editor shows. Never while
 * it is being typed in or holds an edit not yet sent: last write wins on disk,
 * not inside the box under your cursor.
 */
export function takesRemote(editing: { focused: boolean; dirty: boolean }): boolean {
  return !editing.focused && !editing.dirty;
}

export interface NoteElements {
  layout: HTMLElement;
  panel: HTMLElement;
  /** The top bar's toggle. */
  button: HTMLElement;
  tabWindow: HTMLElement;
  tabAll: HTMLElement;
  close: HTMLElement;
  windowView: HTMLElement;
  heading: HTMLElement;
  text: HTMLTextAreaElement;
  allView: HTMLElement;
}

export interface NotesHost {
  send(m: ClientMessage): boolean;
  session(): string | null;
  /** The window whose note this is: the one in the terminal pane that last had focus. */
  owner(): WindowInfo | undefined;
  /** How that window is named, `session › window`. */
  ownerPlace(): string;
  phone(): boolean;
  focusTerminal(): void;
  toast(message: string): void;
  goTo(live: NonNullable<NoteSummary["live"]>): void;
}

export interface Notes {
  readonly open: boolean;
  readonly tab: NotesTab;
  toggle(): void;
  show(tab: NotesTab): void;
  /** The owner may have changed: a state push, a focus move. */
  sync(): void;
  receive(m: Extract<ServerMessage, { t: "note" }>): void;
  list(notes: NoteSummary[]): void;
  /** A note was deleted: if it is the one shown, its window starts a new one. */
  deleted(noteId: string): void;
  /** The socket is back: send what it missed, or ask again for what never came. */
  reconnected(): void;
}

function load(): { open: boolean; tab: NotesTab } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { open: v.open === true, tab: v.tab === "all" ? "all" : "window" };
  } catch {
    return { open: false, tab: "window" };
  }
}

export function createNotes(els: NoteElements, host: NotesHost): Notes {
  let { open, tab } = load();
  // A phone opens on the terminal: the panel there covers it.
  if (host.phone()) open = false;

  /** The window shown in "This window", and its note's id once the server has answered for it. */
  let windowId: string | null = null;
  let noteId: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const remember = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ open, tab })); } catch { /* this browser forgets */ }
  };

  const explorer = createExplorer(els.allView, {
    request: () => host.send({ t: "notes-list" }),
    goTo: (live) => host.goTo(live),
    remove: (id) => host.send({ t: "note-delete", noteId: id }),
    save: (id, text) => {
      if (!host.send({ t: "note-save", noteId: id, text })) return false;
      // The server echoes a save to every other browser, not back to this one.
      if (id === noteId && !dirty) els.text.value = text;
      return true;
    },
    toast: host.toast,
    currentNote: () => noteId,
    openCurrent: () => show("window"),
  });

  function layout() {
    els.panel.hidden = !open;
    els.layout.classList.toggle("notes-open", open);
    els.button.classList.toggle("on", open);
    els.button.setAttribute("aria-pressed", String(open));
    els.windowView.hidden = tab !== "window";
    els.allView.hidden = tab !== "all";
    els.tabWindow.classList.toggle("on", tab === "window");
    els.tabAll.classList.toggle("on", tab === "all");
    els.tabWindow.setAttribute("aria-selected", String(tab === "window"));
    els.tabAll.setAttribute("aria-selected", String(tab === "all"));
  }

  function flush() {
    clearTimeout(timer);
    if (!dirty || !noteId) return;
    if (host.send({ t: "note-save", noteId, text: els.text.value })) dirty = false;
  }

  function sync() {
    if (!open) return;
    const w = host.owner();
    els.heading.textContent = w ? `✎ ${host.ownerPlace()}` : "";
    els.heading.title = els.heading.textContent;
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

  function show(next: NotesTab, focus = true) {
    if (tab === "all" && next !== "all") explorer.flush();
    open = true;
    tab = next;
    remember();
    layout();
    sync();
    if (tab === "all") explorer.activate(focus);
    else if (focus) els.text.focus();
  }

  function hide() {
    if (!open) return;
    flush();
    explorer.flush();
    open = false;
    windowId = null;
    noteId = null;
    remember();
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
  const away = () => { flush(); explorer.flush(); };
  window.addEventListener("pagehide", away);
  document.addEventListener("visibilitychange", () => { if (document.hidden) away(); });

  els.tabWindow.onclick = () => show("window");
  els.tabAll.onclick = () => show("all", false);
  els.close.onclick = () => hide();
  els.button.onclick = () => (open ? hide() : show(tab));
  layout();
  if (open && tab === "all") explorer.activate(false);

  return {
    get open() { return open; },
    get tab() { return tab; },
    toggle: () => (open ? hide() : show(tab)),
    show: (t) => show(t),
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
      explorer.updated(m.noteId, m.text, m.updated);
      if (m.noteId !== noteId) return;
      if (takesRemote({ focused: document.activeElement === els.text, dirty })) els.text.value = m.text;
    },
    list: (notes) => explorer.receive(notes),
    deleted(id) {
      explorer.deleted(id);
      if (!open || id !== noteId) return;
      clearTimeout(timer);
      dirty = false;
      windowId = null;
      sync();
    },
    reconnected() {
      if (!open) return;
      if (tab === "all") explorer.activate(false);
      if (noteId) return flush();
      windowId = null;
      sync();
    },
  };
}
