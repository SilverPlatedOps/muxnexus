/**
 * Every note, searchable: by the session and window it belongs to, or by what
 * it says. Read-only -- a note is written in its pane -- with a way back to the
 * window while it lives, a copy, and a delete.
 */
import type { NoteSummary } from "../shared/protocol";

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
  toast(message: string): void;
}

export interface Explorer {
  receive(notes: NoteSummary[]): void;
  /** A note went, here or on another device. */
  deleted(noteId: string): void;
}

export function openExplorer(host: HTMLElement, hooks: ExplorerHooks, onClose: () => void): Explorer {
  let all: NoteSummary[] | null = null;
  let selected: string | null = null;
  let confirming = false;

  const back = el("div", "modal-back");
  const box = el("div", "move explorer");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Notes");

  const head = el("div", "explorer-head");
  const search = el("input", "explorer-search");
  search.type = "search";
  search.placeholder = "Search notes by window or text";
  search.setAttribute("aria-label", "Search notes");
  search.spellcheck = false;
  const count = el("span", "explorer-count");
  const shut = el("button", "row-btn");
  shut.type = "button";
  shut.setAttribute("aria-label", "Close notes");
  shut.innerHTML = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"></line><line x1="12" y1="4" x2="4" y2="12"></line></svg>';
  head.append(search, count, shut);

  const body = el("div", "explorer-body");
  const list = el("div", "explorer-list");
  list.setAttribute("role", "listbox");
  const view = el("div", "explorer-view");
  body.append(list, view);
  box.append(head, body);
  back.append(box);

  const shown = () => (all ?? []).filter((n) => noteMatches(n, search.value));

  function paintList() {
    const notes = shown();
    if (selected && !notes.some((n) => n.noteId === selected)) selected = null;
    count.textContent = all === null ? "" : `${notes.length}`;
    list.replaceChildren();
    if (all === null) list.append(el("div", "explorer-empty", "Loading…"));
    else if (!all.length) list.append(el("div", "explorer-empty", "No notes yet. Open one from a window's tab menu or the ✎ button."));
    else if (!notes.length) list.append(el("div", "explorer-empty", "Nothing matches."));
    const now = Date.now();
    for (const n of notes) {
      const row = el("button", `explorer-row${n.noteId === selected ? " sel" : ""}`);
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(n.noteId === selected));
      const top = el("div", "explorer-row-top");
      const title = el("span", "explorer-title");
      title.append(highlighted(noteTitle(n), search.value));
      top.append(title);
      if (!n.live) top.append(el("span", "explorer-gone", "window closed"));
      top.append(el("span", "explorer-when", ago(n.updated, now)));
      const snip = el("div", "explorer-snip");
      snip.append(highlighted(excerpt(n.text, search.value), search.value));
      row.append(top, snip);
      row.onclick = () => {
        selected = n.noteId;
        confirming = false;
        paint();
      };
      list.append(row);
    }
  }

  function paintView() {
    const n = (all ?? []).find((x) => x.noteId === selected);
    box.classList.toggle("reading", !!n);
    view.replaceChildren();
    if (!n) {
      view.append(el("div", "explorer-empty", all?.length ? "Pick a note to read it." : ""));
      return;
    }
    const bar = el("div", "explorer-bar");
    const backBtn = el("button", "btn explorer-back", "‹ Notes");
    backBtn.type = "button";
    backBtn.onclick = () => { selected = null; paint(); };
    const title = el("span", "explorer-view-title", noteTitle(n));
    bar.append(backBtn, title, el("span", "spacer"));
    if (n.live) {
      const go = el("button", "btn", "Go to window");
      go.type = "button";
      go.onclick = () => { hooks.goTo(n.live!); close(); };
      bar.append(go);
    }
    const copy = el("button", "btn", "Copy");
    copy.type = "button";
    copy.onclick = () => {
      navigator.clipboard.writeText(n.text).then(
        () => hooks.toast("Note copied"),
        () => hooks.toast("Copy failed: select the text instead"),
      );
    };
    bar.append(copy);
    if (confirming) {
      const yes = el("button", "btn danger", "Delete");
      yes.type = "button";
      yes.onclick = () => hooks.remove(n.noteId);
      const no = el("button", "btn", "Cancel");
      no.type = "button";
      no.onclick = () => { confirming = false; paintView(); };
      bar.append(el("span", "explorer-ask", n.live ? "Delete? Its window starts a new note." : "Delete for good?"), yes, no);
    } else {
      const del = el("button", "btn", "Delete");
      del.type = "button";
      del.onclick = () => { confirming = true; paintView(); };
      bar.append(del);
    }
    const text = el("pre", "explorer-text");
    text.append(highlighted(n.text, search.value));
    view.append(bar, text);
  }

  function paint() {
    paintList();
    paintView();
  }

  function close() {
    back.remove();
    document.removeEventListener("keydown", esc);
    onClose();
  }
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (confirming) { confirming = false; paintView(); }
    else if (selected && box.classList.contains("reading") && window.matchMedia("(max-width: 720px)").matches) { selected = null; paint(); }
    else close();
  };
  search.oninput = () => paintList();
  search.onkeydown = (e) => {
    // Enter reads the first match: search, then the note, without the mouse.
    if (e.key === "Enter") {
      const first = shown()[0];
      if (first) { selected = first.noteId; confirming = false; paint(); }
    }
  };
  shut.onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener("keydown", esc);
  host.append(back);
  paint();
  search.focus();
  hooks.request();

  return {
    receive(notes) {
      all = notes;
      paint();
    },
    deleted(noteId) {
      if (!all) return;
      all = all.filter((n) => n.noteId !== noteId);
      if (selected === noteId) { selected = null; confirming = false; }
      paint();
    },
  };
}
