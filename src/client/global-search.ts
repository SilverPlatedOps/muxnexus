import type { NoteSummary, SessionInfo } from "../shared/protocol";
import { sessionLabel, tabLabel } from "./labels";
import { excerpt } from "./explorer";
import { queryWords } from "./find";

export type GlobalHit =
  | { kind: "workspace"; key: string; title: string; detail: string; session: string }
  | { kind: "tab"; key: string; title: string; detail: string; session: string; windowId: string }
  | { kind: "note"; key: string; title: string; detail: string; noteId: string };

/** Search display names, repository paths and note contents without changing scoped searches. */
export function globalHits(sessions: readonly SessionInfo[], notes: readonly NoteSummary[], query: string): GlobalHit[] {
  const words = queryWords(query);
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const hits: GlobalHit[] = [];
  for (const s of sessions) {
    const title = sessionLabel(s);
    if (matches(`${title} ${s.name}`)) hits.push({ kind: "workspace", key: `workspace:${s.id}`, title, detail: `${s.windows.length} tab${s.windows.length === 1 ? "" : "s"}`, session: s.name });
    for (const w of s.windows) {
      const name = tabLabel(w);
      const folder = w.agent?.checkout ?? "";
      if (matches(`${title} ${s.name} ${name} ${folder}`)) hits.push({ kind: "tab", key: `tab:${s.id}:${w.id}`, title: name, detail: `${title}${folder ? ` · ${folder}` : ""}`, session: s.name, windowId: w.id });
    }
  }
  for (const n of notes) {
    const title = `${n.session} › ${n.window}`;
    if (matches(`${title} ${n.text}`)) hits.push({ kind: "note", key: `note:${n.noteId}`, title, detail: excerpt(n.text, query), noteId: n.noteId });
  }
  const order = { workspace: 0, tab: 1, note: 2 };
  return hits.sort((a, b) => order[a.kind] - order[b.kind]);
}

export interface GlobalSearchHost {
  sessions(): readonly SessionInfo[];
  requestNotes(): boolean;
  open(hit: GlobalHit): void;
}

/** Native modal supplies focus containment; only the input owns arrow-key selection. */
export function createGlobalSearch(host: GlobalSearchHost) {
  let notes: NoteSummary[] = [];
  let loading = false;
  let available = true;
  let hits: GlobalHit[] = [];
  let selected = 0;
  let previous: HTMLElement | null = null;
  const dialog = document.createElement("dialog");
  dialog.className = "global-search";
  dialog.setAttribute("aria-labelledby", "global-search-title");
  const head = document.createElement("div");
  head.className = "global-search-head";
  const title = document.createElement("h2");
  title.id = "global-search-title";
  title.textContent = "Search everything";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn";
  close.textContent = "Close";
  close.onclick = () => dismiss();
  head.append(title, close);
  const input = document.createElement("input");
  input.type = "search";
  input.className = "global-search-input";
  input.placeholder = "Workspaces, tabs and note text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Search workspaces, tabs and notes");
  input.setAttribute("aria-controls", "global-search-results");
  input.setAttribute("aria-autocomplete", "list");
  const list = document.createElement("div");
  list.id = "global-search-results";
  list.className = "global-search-results";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Search results");
  const status = document.createElement("p");
  status.className = "global-search-help";
  status.setAttribute("role", "status");
  const help = document.createElement("p");
  help.className = "global-search-help";
  help.textContent = "↑ ↓ to choose · Enter to open · Esc to close · ⌘⇧K";
  dialog.append(head, input, status, list, help);
  document.body.append(dialog);

  function dismiss(restore = true) {
    dialog.close();
    input.setAttribute("aria-expanded", "false");
    if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
  }

  function choose(index: number) {
    const hit = hits[index];
    if (!hit) return;
    dismiss(false);
    host.open(hit);
  }

  function select(index: number) {
    selected = Math.max(0, Math.min(hits.length - 1, index));
    const options = list.querySelectorAll<HTMLElement>("[role=option]");
    options.forEach((row, i) => row.setAttribute("aria-selected", String(i === selected)));
    const row = options[selected];
    if (row) {
      input.setAttribute("aria-activedescendant", row.id);
      row.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }

  function paint() {
    if (!dialog.open) return;
    const oldKey = hits[selected]?.key;
    hits = globalHits(host.sessions(), notes, input.value);
    list.replaceChildren();
    let group = "";
    hits.forEach((hit, i) => {
      if (group !== hit.kind) {
        group = hit.kind;
        const heading = document.createElement("div");
        heading.className = "global-search-group";
        heading.setAttribute("role", "presentation");
        heading.textContent = { workspace: "Workspaces", tab: "Tabs", note: "Notes" }[hit.kind];
        list.append(heading);
      }
      const row = document.createElement("button");
      row.type = "button";
      row.tabIndex = -1;
      row.id = `global-search-hit-${i}`;
      row.className = "global-search-hit";
      row.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "global-search-name";
      name.textContent = hit.title;
      const detail = document.createElement("span");
      detail.className = "global-search-detail";
      detail.textContent = hit.detail;
      row.append(name, detail);
      row.onmousedown = (e) => e.preventDefault();
      row.onclick = () => choose(i);
      list.append(row);
    });
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${loading ? " · Loading notes…" : !available ? " · Notes unavailable: reconnect and reopen search" : !hits.length ? " · No matches" : ""}`;
    select(Math.max(0, hits.findIndex((h) => h.key === oldKey)));
  }

  input.oninput = () => { selected = 0; hits = []; paint(); };
  dialog.addEventListener("keydown", (e) => {
    // No key, including Escape, may fall through into the terminal.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); dismiss(); }
    else if (e.target === input && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault(); select(selected + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.target === input && e.key === "Enter") { e.preventDefault(); choose(selected); }
  });
  dialog.addEventListener("cancel", (e) => { e.preventDefault(); dismiss(); });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dismiss();
  } });

  return {
    open() {
      if (dialog.open || document.querySelector(".modal-back, .chat-modal-back, dialog[open]")) return;
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      input.value = "";
      selected = 0;
      hits = [];
      notes = [];
      dialog.showModal();
      input.setAttribute("aria-expanded", "true");
      available = host.requestNotes();
      loading = available;
      paint();
      input.focus();
    },
    receive(next: NoteSummary[]) { notes = next; loading = false; available = true; paint(); },
    refresh: paint,
    deleted(id: string) { notes = notes.filter((n) => n.noteId !== id); paint(); },
    update(id: string, text: string, updated: string) {
      const note = notes.find((n) => n.noteId === id);
      if (note) { note.text = text; note.updated = updated; paint(); }
    },
    disconnected() { loading = false; available = false; paint(); },
  };
}
