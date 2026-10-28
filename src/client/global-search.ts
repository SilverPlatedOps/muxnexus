import { SEARCH_LIMITS, type ChatSearchHit } from "../shared/chat";
import type { NoteSummary, ServerMessage, SessionInfo } from "../shared/protocol";
import { sessionLabel, tabLabel } from "./labels";
import { excerpt } from "./explorer";
import { queryWords } from "./find";

export type GlobalHit =
  | { kind: "workspace"; key: string; title: string; detail: string; session: string }
  | { kind: "tab"; key: string; title: string; detail: string; session: string; windowId: string }
  | { kind: "note"; key: string; title: string; detail: string; noteId: string }
  | { kind: "chat"; key: string; title: string; detail: string; chatId: string; messageId?: undefined }
  | { kind: "chat-note"; key: string; title: string; detail: string; chatId: string; messageId?: undefined }
  | { kind: "chat-message"; key: string; title: string; detail: string; chatId: string; messageId: number };

type ChatResult = Extract<ServerMessage, { t: "chat-search-result" }>;
/** Typing settles this long before the server is asked. */
const CHAT_DEBOUNCE_MS = 200;

/** A server chat hit as a row: what matched, then where and from whom; archived chats say so. */
export function chatHit(h: ChatSearchHit): GlobalHit {
  const where = `${h.archived ? "Archived · " : ""}${h.chatName}`;
  const when = h.at ? new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  if (h.kind === "chat") return { kind: "chat", key: `chat:${h.chatId}`, title: h.chatName, detail: h.archived ? "Archived chat" : "Chat", chatId: h.chatId };
  if (h.kind === "note") return { kind: "chat-note", key: `chat-note:${h.chatId}`, title: h.excerpt, detail: `${where} · your notes${when ? ` · ${when}` : ""}`, chatId: h.chatId };
  return { kind: "chat-message", key: `chat-message:${h.chatId}:${h.messageId}`, title: h.excerpt, detail: [where, h.from === "user" ? "you" : h.from, when].filter(Boolean).join(" · "), chatId: h.chatId, messageId: h.messageId! };
}

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
  const order: Record<GlobalHit["kind"], number> = { workspace: 0, tab: 1, note: 2, chat: 3, "chat-message": 4, "chat-note": 5 };
  return hits.sort((a, b) => order[a.kind] - order[b.kind]);
}

export interface GlobalSearchHost {
  sessions(): readonly SessionInfo[];
  requestNotes(): boolean;
  /** Ask the server for chat hits; false when it can't be sent. */
  searchChats(req: string, query: string, chatId?: string, cursor?: number): boolean;
  /** The chat in view, for This chat. */
  currentChat(): { id: string; name: string } | null;
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
  /** Everything, or one chat's messages and notes. */
  let scope: { id: string; name: string } | null = null;
  let chatHits: GlobalHit[] = [];
  let chatReq = "";
  let chatState: "idle" | "loading" | "error" = "idle";
  let chatError = "";
  let chatNext: number | undefined;
  let chatTimer: ReturnType<typeof setTimeout> | undefined;
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
  const scopes = document.createElement("div");
  scopes.className = "global-search-scopes";
  scopes.setAttribute("role", "radiogroup");
  scopes.setAttribute("aria-label", "Search in");
  const everywhere = document.createElement("button");
  everywhere.type = "button";
  everywhere.className = "seg";
  everywhere.textContent = "Everything";
  everywhere.setAttribute("role", "radio");
  everywhere.onclick = () => setScope(null);
  const here = document.createElement("button");
  here.type = "button";
  here.className = "seg";
  here.setAttribute("role", "radio");
  here.onclick = () => setScope(host.currentChat());
  scopes.append(everywhere, here);
  head.append(title, scopes, close);
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

  /** Chat hits for the box as it stands: the last answer is dropped at once, so a scope never shows another's results. */
  function askChats(cursor?: number) {
    clearTimeout(chatTimer);
    if (cursor === undefined) { chatHits = []; chatNext = undefined; }
    const query = input.value.trim().slice(0, SEARCH_LIMITS.query);
    if (!query) { chatReq = ""; chatState = "idle"; return; }
    chatReq = crypto.randomUUID();
    chatState = "loading";
    const req = chatReq;
    const send = () => {
      if (req !== chatReq) return;
      if (!host.searchChats(req, query, scope?.id, cursor)) { chatState = "error"; chatError = "not connected"; paint(); }
    };
    if (cursor === undefined) chatTimer = setTimeout(send, CHAT_DEBOUNCE_MS);
    else send();
  }

  function setScope(next: { id: string; name: string } | null) {
    scope = next;
    title.textContent = scope ? "Find in chat" : "Search everything";
    input.placeholder = scope ? `Messages and notes in ${scope.name}` : "Workspaces, tabs, notes and chats";
    const chat = host.currentChat();
    here.hidden = !chat;
    here.textContent = chat ? `This chat · ${chat.name}` : "";
    everywhere.setAttribute("aria-checked", String(!scope));
    here.setAttribute("aria-checked", String(!!scope));
    everywhere.classList.toggle("on", !scope);
    here.classList.toggle("on", !!scope);
    selected = 0;
    askChats();
    paint();
    input.focus();
  }

  function paint() {
    if (!dialog.open) return;
    const oldKey = hits[selected]?.key;
    hits = [...(scope ? [] : globalHits(host.sessions(), notes, input.value)), ...chatHits];
    list.replaceChildren();
    let group = "";
    hits.forEach((hit, i) => {
      if (group !== hit.kind) {
        group = hit.kind;
        const heading = document.createElement("div");
        heading.className = "global-search-group";
        heading.setAttribute("role", "presentation");
        heading.textContent = { workspace: "Workspaces", tab: "Tabs", note: "Notes", chat: "Chats", "chat-message": "Chat messages", "chat-note": "Chat notes" }[hit.kind];
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
    if (chatNext !== undefined) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "global-search-more";
      more.textContent = "More chat results";
      more.onmousedown = (e) => e.preventDefault();
      more.onclick = () => { askChats(chatNext); paint(); };
      list.append(more);
    }
    const chats = chatState === "loading" ? " · Searching chats…" : chatState === "error" ? ` · Chat search failed: ${chatError}` : "";
    const empty = !hits.length && chatState !== "loading" && input.value.trim() ? " · No matches" : "";
    status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"}${!scope && loading ? " · Loading notes…" : !scope && !available ? " · Notes unavailable: reconnect and reopen search" : ""}${chats}${empty}`;
    select(Math.max(0, hits.findIndex((h) => h.key === oldKey)));
  }

  input.oninput = () => { selected = 0; hits = []; askChats(); paint(); };
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
    /** `inChat`: Find in chat, scoped to the chat in view. */
    open(inChat = false) {
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
      setScope(inChat ? host.currentChat() : null);
    },
    /** A page of chat hits: only the answer to the latest ask counts. */
    chatResult(r: ChatResult) {
      if (r.req !== chatReq || !dialog.open) return;
      if (!r.ok) { chatState = "error"; chatError = r.error ?? "unknown error"; return paint(); }
      chatState = "idle";
      chatHits = [...chatHits, ...(r.hits ?? []).map(chatHit)];
      chatNext = r.next;
      paint();
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
