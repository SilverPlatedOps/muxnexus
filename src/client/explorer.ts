/**
 * Every note, searchable: by the session and window it belongs to, or by what
 * it says. The "All notes" side of the notes panel. A note picked here is edited
 * here as in "This window" -- saved the same way, yielding to another device's
 * save the same way -- with a way back to its window while it lives, a copy,
 * and a delete.
 */
import type { NoteSummary } from "../shared/protocol";
import { createNoteEditor } from "./note-editor";
import { takesRemote } from "./notes";

/** A save this long after the last keystroke, as in the note pane. */
const SAVE_MS = 500;

export const noteTitle = (n: Pick<NoteSummary, "session" | "window">): string =>
  [n.session, n.window].filter(Boolean).join(" › ") || "Untitled";

const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the query is somewhere in the title or the text, in any case. */
export function noteMatches(n: NoteSummary, query: string): boolean {
  const hay = `${noteTitle(n)}\n${n.text}`.toLowerCase();
  return words(query).every((w) => hay.includes(w));
}

/**
 * A line's worth of the text around the first word of the query found in it, or
 * its start when the match was only in the title. Whitespace folded, so a
 * snippet never breaks across the note's own lines.
 */
export function excerpt(text: string, query: string, radius = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const low = flat.toLowerCase();
  const at = words(query).map((w) => low.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, at + radius);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

/** How long ago, as the sidebar says it: `now`, `5m`, `3h`, `2d`, else the date. */
export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** `text` with each query word wrapped in <mark>. */
function highlighted(text: string, query: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const ws = words(query).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!ws.length) {
    f.append(text);
    return f;
  }
  const re = new RegExp(`(${ws.join("|")})`, "gi");
  let last = 0;
  for (const m of text.matchAll(re)) {
    f.append(text.slice(last, m.index), el("mark", "", m[0]));
    last = m.index! + m[0].length;
  }
  f.append(text.slice(last));
  return f;
}

export interface ExplorerHooks {
  /** Ask the server for the list; it arrives through `receive`. */
  request(): void;
  goTo(live: NonNullable<NoteSummary["live"]>): void;
  remove(noteId: string): void;
  /** Whether it went: an edit stays unsaved until one does. */
  save(noteId: string, text: string): boolean;
  toast(message: string): void;
  /** The note of the window on screen, which "This window" already edits. */
  currentNote(): string | null;
  /** Show that one where it already lives. */
  openCurrent(): void;
}

export interface Explorer {
  /** The tab came into view: fetch the list afresh, and focus the search if asked. */
  activate(focusSearch: boolean): void;
  /** Send any edit not yet saved: the tab is going out of view. */
  flush(): void;
  receive(notes: NoteSummary[]): void;
  /** A note went, here or on another device. */
  deleted(noteId: string): void;
  /** Another device saved a note. */
  updated(noteId: string, text: string, updated: string): void;
}

export function createExplorer(root: HTMLElement, hooks: ExplorerHooks): Explorer {
  let all: NoteSummary[] | null = null;
  let selected: string | null = null;
  let confirming = false;

  /** The note in the editor, and whether it holds an edit not yet sent. */
  let editingId: string | null = null;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const editor = createNoteEditor({
    label: "Note text",
    onEdit() {
      dirty = true;
      status.textContent = "Saving\u2026";
      const n = all?.find((x) => x.noteId === editingId);
      if (n) {
        n.text = editor.value;
        n.updated = new Date().toISOString();
      }
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_MS);
    },
    onBlur: () => flush(),
  });
  const status = el("span", "explorer-status");

  // One column: the search and its list, or the note picked from it.
  const listView = el("div", "explorer-listview");
  const search = el("input", "explorer-search");
  search.type = "search";
  search.placeholder = "Search by window or text";
  search.setAttribute("aria-label", "Search notes");
  search.spellcheck = false;
  const count = el("span", "explorer-count");
  const searchRow = el("div", "explorer-head");
  searchRow.append(search, count);
  const list = el("div", "explorer-list");
  list.setAttribute("role", "listbox");
  listView.append(searchRow, list);
  const view = el("div", "explorer-view");
  root.append(listView, view);

  const shown = () => (all ?? []).filter((n) => noteMatches(n, search.value));

  function pick(noteId: string) {
    flush();
    if (noteId === hooks.currentNote()) return hooks.openCurrent();
    selected = noteId;
    confirming = false;
    paint();
  }

  function paintList() {
    const notes = shown();
    count.textContent = all === null ? "" : `${notes.length}`;
    list.replaceChildren();
    if (all === null) list.append(el("div", "explorer-empty", "Loading…"));
    else if (!all.length) list.append(el("div", "explorer-empty", "No notes yet. Write one in \u201cThis window\u201d."));
    else if (!notes.length) list.append(el("div", "explorer-empty", "Nothing matches."));
    const now = Date.now();
    const here = hooks.currentNote();
    for (const n of notes) {
      const row = el("button", "explorer-row");
      row.type = "button";
      row.setAttribute("role", "option");
      const top = el("div", "explorer-row-top");
      const title = el("span", "explorer-title");
      title.append(highlighted(noteTitle(n), search.value));
      top.append(title);
      if (n.noteId === here) top.append(el("span", "explorer-tag here", "this window"));
      else if (!n.live) top.append(el("span", "explorer-tag", "window closed"));
      top.append(el("span", "explorer-when", ago(n.updated, now)));
      const snip = el("div", "explorer-snip");
      snip.append(highlighted(excerpt(n.text, search.value), search.value));
      row.append(top, snip);
      row.onclick = () => pick(n.noteId);
      list.append(row);
    }
  }

  function paintView() {
    const n = (all ?? []).find((x) => x.noteId === selected);
    root.classList.toggle("reading", !!n);
    view.replaceChildren();
    if (!n) {
      editingId = null;
      return;
    }
    if (n.noteId !== editingId) {
      editingId = n.noteId;
      editor.load(n.text);
      dirty = false;
      status.textContent = "";
    }
    const bar = el("div", "explorer-bar");
    const backBtn = el("button", "btn explorer-back", "\u2039 All notes");
    backBtn.type = "button";
    backBtn.onclick = () => { flush(); selected = null; paint(); };
    bar.append(backBtn, el("span", "spacer"), status);
    const title = el("div", "note-heading", noteTitle(n));
    title.title = noteTitle(n);
    const actions = el("div", "explorer-bar actions");
    if (n.live) {
      const go = el("button", "btn", "Go to window");
      go.type = "button";
      go.onclick = () => { flush(); hooks.goTo(n.live!); };
      actions.append(go);
    }
    const copy = el("button", "btn", "Copy");
    copy.type = "button";
    copy.onclick = () => {
      navigator.clipboard.writeText(editor.value).then(
        () => hooks.toast("Note copied"),
        () => hooks.toast("Copy failed: select the text instead"),
      );
    };
    actions.append(copy);
    if (confirming) {
      const yes = el("button", "btn danger", "Delete");
      yes.type = "button";
      yes.onclick = () => hooks.remove(n.noteId);
      const no = el("button", "btn", "Cancel");
      no.type = "button";
      no.onclick = () => { confirming = false; paintView(); };
      actions.append(el("span", "explorer-ask", n.live ? "Its window starts a new note." : "Delete for good?"), yes, no);
    } else {
      const del = el("button", "btn", "Delete");
      del.type = "button";
      del.onclick = () => { confirming = true; paintView(); };
      actions.append(del);
    }
    view.append(bar, title, actions, editor.el);
  }

  function flush() {
    clearTimeout(timer);
    if (!dirty || !editingId) return;
    if (hooks.save(editingId, editor.value)) {
      dirty = false;
      status.textContent = "Saved";
    } else {
      status.textContent = "Not saved: reconnecting";
    }
  }


  function paint() {
    paintList();
    paintView();
  }

  search.oninput = () => paintList();
  search.onkeydown = (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      paintList();
      return;
    }
    // Enter reads the first match: search, then the note, without the mouse.
    if (e.key !== "Enter") return;
    const first = shown()[0];
    if (!first) return;
    // Focus moves to the note mid-keystroke: the Enter must not follow it in.
    e.preventDefault();
    const w = words(search.value)[0];
    pick(first.noteId);
    if (selected !== first.noteId) return; // it was this window's: shown there
    // Straight into the text, at the first word searched for.
    const at = w ? editor.value.toLowerCase().indexOf(w) : -1;
    editor.focus();
    if (at >= 0) editor.select(at, at + w.length);
  };
  paint();

  return {
    activate(focusSearch) {
      hooks.request();
      if (focusSearch) {
        flush();
        selected = null;
        paint();
        search.focus();
        search.select();
      }
    },
    flush,
    receive(notes) {
      all = notes;
      // The note open here may have gone while the list was away.
      if (selected && !notes.some((n) => n.noteId === selected) && !dirty) selected = null;
      paint();
    },
    deleted(noteId) {
      if (!all) return;
      all = all.filter((n) => n.noteId !== noteId);
      if (selected === noteId) { selected = null; confirming = false; }
      if (editingId === noteId) { clearTimeout(timer); dirty = false; editingId = null; }
      paint();
    },
    updated(noteId, text, updated) {
      const n = all?.find((x) => x.noteId === noteId);
      if (!n) return; // a note new since the list was read: it shows next time
      const mine = noteId === editingId;
      if (mine && !takesRemote({ focused: editor.focused, dirty })) return;
      n.text = text;
      n.updated = updated;
      if (mine) editor.replace(text);
      paintList();
    },
  };
}
