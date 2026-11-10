// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { type Chat, type ChatMember, type ChatSummary } from "../../shared/chat";
import type { ChatMemberLive, ClientMessage, SessionInfo } from "../../shared/protocol";
import { GLYPH } from "../agent";
import { Connection } from "../socket";
import { createTerminal, type TerminalView } from "../terminal";
import {
  chatRows,
  chatsAsking,
  composerState,
  heldCount,
  memberColour,
  memberStatus,
  mentionChoices,
  messageRows,
  parseCap,
  canOpen,
  creditsText,
  firstChatHit,
  replyQuote,
  nearAgent,
  prefill,
  prefillChips,
  prefillKey,
  retryStaged,
  shutdownList,
  sideTab,
  tabChats,
  type ChatRow,
  type Row,
  type SideTab,
  type StagedAgent,
  withChips,
} from "./model";
import { inlineEdit } from "../inline-edit";
import { chatMenu, memberMenu, type AgentTarget, type MenuAction } from "../menus";
import { onContextMenu, openMenu, type Anchor } from "../popover";
import { openPicker } from "./picker";
import { renderMarkdown } from "./markdown";
import { createChatNotes } from "./notes";
import { makeResizable } from "../resize";
import { createChatContext } from "./context";
import { chatRules } from "../../shared/chat-rules";
import { createChatActivity, workingDots } from "./activity";
import { agentMark } from "./logos";

/**
 * The chat UI: the Chats tab's list, and a chat in the main area with a
 * member's terminal beside it when you pick one. The room is the server's;
 * this draws what it sends and sends what you do.
 */

export interface ChatHost {
  send(m: ClientMessage): boolean;
  wsUrl: string;
  sessions(): SessionInfo[];
  /** Claude profiles as the quota panel names them, for starting an agent. */
  profiles(): string[];
  currentSession(): string | null;
  /** Leave the chat for a member's tab in its workspace, as the normal view shows it. */
  openWorkspace(session: string, windowId: string): void;
  /** The chat came or went: the main area repaints. */
  changed(): void;
  toast(message: string): void;
  onPhone(): boolean;
  /** Find in this chat: the search, scoped to it. */
  find(): void;
  /** A member's tab as an agent menu sees it, and what its items do; null when the tab is gone. */
  agentFor(windowId: string): { target: AgentTarget; pick: (action: MenuAction) => void } | null;
  /** Show this member's tab note in the right panel, in place of the chat's own panel (null: nobody to show). */
  showAgentNote(windowId: string | null): void;
  /** Whether the right panel is showing a member's note now. */
  agentNoteShowing(): boolean;
  /** The chat's panel opened: the right side holds one panel, so a note there gives way. */
  dockOpened(): void;
}

export interface ChatEls {
  tabsBar: HTMLElement;
  tabChats: HTMLButtonElement;
  tabWorkspaces: HTMLButtonElement;
  tabDot: HTMLElement;
  sessions: HTMLElement;
  list: HTMLElement;
  main: HTMLElement;
  back: HTMLButtonElement;
  search: HTMLInputElement;
}

const TAB_KEY = "muxnexus.sideTab";
const OPEN_KEY = "muxnexus.chat";
/** Whether the open chat was in view, rather than left for a workspace: a reload comes back to it. */
const SHOWING_KEY = "muxnexus.chatShowing";
const STATE_KEY = "muxnexus.chatState";


function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(cls: string, text: string, title?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string | null) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* private window */ }
  },
};

/** Per chat: the member beside it, the scroll position, the unsent draft. */
interface Remembered { member?: string; draft?: string; chips?: string[]; scroll?: number; details?: boolean; notes?: boolean; replyTo?: number; offered?: string }
function remembered(id: string): Remembered {
  try { return (JSON.parse(store.get(STATE_KEY) ?? "{}") as Record<string, Remembered>)[id] ?? {}; } catch { return {}; }
}
function remember(id: string, patch: Remembered) {
  let all: Record<string, Remembered> = {};
  try { all = JSON.parse(store.get(STATE_KEY) ?? "{}"); } catch { /* start over */ }
  all[id] = { ...all[id], ...patch };
  store.set(STATE_KEY, JSON.stringify(all));
}

export function createChatUI(els: ChatEls, host: ChatHost) {
  let tab: SideTab = sideTab(store.get(TAB_KEY));
  let chats: ChatSummary[] = [];
  let openId: string | null = store.get(OPEN_KEY);
  /** Showing in the main area, as opposed to open but left for a member's tab. */
  let showing = false;
  let chat: Chat | null = null;
  let agents: Record<string, ChatMemberLive> = {};
  let menu: HTMLElement | null = null;

  // ---- the sidebar tab ------------------------------------------------------

  function setTab(t: SideTab) {
    tab = t;
    store.set(TAB_KEY, t);
    els.tabChats.classList.toggle("on", t === "chats");
    els.tabWorkspaces.classList.toggle("on", t === "workspaces");
    els.tabChats.setAttribute("aria-selected", String(t === "chats"));
    els.tabWorkspaces.setAttribute("aria-selected", String(t === "workspaces"));
    els.sessions.hidden = t !== "workspaces";
    els.list.hidden = t !== "chats";
    els.search.placeholder = t === "chats" ? "Filter chats" : "Filter workspaces and tabs";
    els.search.setAttribute("aria-label", t === "chats" ? "Filter chats" : "Filter workspaces and tabs");
    paintList();
  }
  els.tabChats.onclick = () => setTab("chats");
  els.tabWorkspaces.onclick = () => setTab("workspaces");
  els.search.addEventListener("input", () => { if (tab === "chats") paintList(); });
  els.search.addEventListener("keydown", (e) => {
    if (tab !== "chats" || e.key !== "Enter") return;
    e.preventDefault();
    const id = firstChatHit(chats, els.search.value);
    if (id) open(id);
  });

  const sidebarRows = new Map<string, HTMLButtonElement>();
  function paintList() {
    els.tabDot.hidden = !chats.some((c) => c.glyph === "input" && !c.archived);
    if (tab !== "chats") return;
    const { active, archived } = chatRows(chats, els.search.value);
    const head = el("div", "chats-head");
    head.append(el("span", "chats-count", `${active.length} chat${active.length === 1 ? "" : "s"}`));
    const add = btn("chats-new", "+ New chat", "Start a chat between agents");
    add.onclick = () => newChat();
    head.append(add);
    const rows = active.map((c) => row(c));
    const nodes: HTMLElement[] = [head, ...rows];
    if (!active.length) nodes.push(el("div", "chats-empty", els.search.value ? "No chat matches." : "No chats yet. Start one, and add the agents you want talking."));
    if (archived.length) {
      const folded = store.get("muxnexus.chatsArchived") !== "open";
      const h = btn("cat-head chats-archived", `${folded ? "▸" : "▾"} Archived`);
      h.append(el("span", "cat-count", String(archived.length)));
      h.onclick = () => { store.set("muxnexus.chatsArchived", folded ? "open" : null); paintList(); };
      nodes.push(h);
      if (!folded) nodes.push(...archived.map((c) => row(c)));
    }
    for (const id of sidebarRows.keys()) if (!chats.some((c) => c.id === id)) sidebarRows.delete(id);
    let cursor = els.list.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else els.list.insertBefore(node, cursor);
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }

  function row(c: ChatRow) {
    const r = sidebarRows.get(c.id) ?? btn("", "");
    sidebarRows.set(c.id, r);
    r.className = `row chat-row${c.id === openId && showing ? " current" : ""}${c.archived ? " archived" : ""}`;
    const glyph = c.glyph === "paused" ? el("span", "glyph paused", "‖") : el("span", `glyph ${c.glyph}`, GLYPH[c.glyph as keyof typeof GLYPH] ?? "");
    glyph.title = { input: "asking you", running: "agents working", unread: "new messages", seen: "quiet", paused: "paused: your turn" }[c.glyph];
    if (r.dataset.content !== `${c.glyph}:${c.name}`) { r.replaceChildren(glyph, el("span", "label", c.name)); r.dataset.content = `${c.glyph}:${c.name}`; }
    r.title = "Double-click to rename";
    r.onclick = (e) => { if (e.detail > 1 || (openId === c.id && showing)) return; open(c.id); if (host.onPhone()) document.getElementById("drawer-close")?.click(); };
    r.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); renameRow(r, c.id, c.name); };
    if (!r.dataset.menu) {
      r.dataset.menu = "1";
      onContextMenu(r, (at) => { const now = chats.find((x) => x.id === c.id); if (now) chatMenuAt(at, now, () => renameRow(r, now.id, now.name)); });
    }
    return r;
  }

  // ---- opening and leaving ----------------------------------------------------

  function open(id: string | null) {
    if (openId && openId !== id) saveDraft();
    openId = id;
    showing = id !== null;
    store.set(OPEN_KEY, id);
    store.set(SHOWING_KEY, id ? "1" : null);
    chat = null;
    agents = {};
    host.send({ t: "chat-open", id });
    els.back.hidden = true;
    if (!id) closeSide();
    paintList();
    host.changed();
    paintChat();
  }

  /** The message the next post answers: kept with the draft, so a switch or a reload keeps the link. */
  let replying: number | null = null;
  function setReplying(id: number | null) {
    replying = id;
    if (chat) remember(chat.id, { replyTo: id ?? undefined });
  }
  /** Reply to a line: the box says so, and an agent's line puts that agent among the recipients. */
  function startReply(id: number, from: string) {
    if (!chat) return;
    setReplying(id);
    const m = chat.members.find((x) => x.handle === from && x.kind !== "user" && !x.left);
    if (m && !chips.includes(m.handle)) chips.push(m.handle);
    // Saved with the link, so a reload brings back who it was for, not only what it answers.
    remember(chat.id, { chips });
    paintCompose();
    input.focus();
  }
  /** A search result to show once its chat has loaded: a message to scroll to, or the notes. */
  let revealing: { chatId: string; messageId?: number; notes?: boolean } | null = null;
  function applyReveal() {
    if (!revealing || !chat || chat.id !== revealing.chatId) return;
    const r = revealing;
    revealing = null;
    if (r.notes) { setNotesTab(true); setDetails(true); return; }
    if (r.messageId === undefined) return;
    const row = lines.querySelector<HTMLElement>(`.chat-message[data-message-id="${r.messageId}"]`);
    if (!row) { host.toast("That message is no longer in the chat."); return; }
    row.scrollIntoView({ block: "center" });
    row.classList.remove("chat-hit");
    void row.offsetWidth;
    row.classList.add("chat-hit");
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove("chat-hit"), 2600);
  }
  /** Open a chat at a search result. The chat already open isn't reloaded, so its draft stays. */
  function reveal(target: { chatId: string; messageId?: number; notes?: boolean }) {
    revealing = target;
    setTab("chats");
    if (openId === target.chatId && showing && chat) applyReveal();
    else open(target.chatId);
  }

  /** You clicked a workspace: the chat stays open on the server side for the way back. */
  function leaveForWorkspace() {
    if (!showing) return;
    saveDraft();
    showing = false;
    store.set(SHOWING_KEY, null);
    closeSide();
    paintList();
    host.changed();
  }

  function expandTo(handle: string) {
    const m = chat?.members.find((x) => x.handle === handle);
    const session = agents[handle]?.session ?? m?.session;
    if (!m?.windowId || !session || !chat) return;
    const name = chat.name;
    leaveForWorkspace();
    host.openWorkspace(session, m.windowId);
    els.back.textContent = `← Back to ${name}`;
    els.back.hidden = false;
  }
  els.back.onclick = () => { if (openId) open(openId); };

  // ---- the chat view --------------------------------------------------------

  const wrap = el("div", "chat-wrap");
  const pane = el("section", "chat-pane");
  const head = el("header", "chat-head");
  const context = createChatContext((m) => host.send(m));
  const agentBar = el("nav", "chat-agent-bar");
  agentBar.setAttribute("aria-label", "Agent terminals");
  /**
   * The right side: one dock, one view at a time -- an agent's terminal, the
   * chat's setup (mode, brief, handoff, rounds, members), or the user's notes --
   * so the conversation is never squeezed between two panels.
   */
  const dock = el("aside", "chat-dock");
  dock.id = "chat-dock";
  dock.setAttribute("aria-label", "Terminal and chat details");
  dock.hidden = true;
  const details = el("div", "chat-details");
  details.id = "chat-details";
  details.hidden = true;
  const dockClose = btn("icon-btn chat-dock-close", "✕", "Close this panel");
  dockClose.onclick = () => {
    if (dockView === "terminal") { closeSide(); if (chat) remember(chat.id, { member: undefined }); paintChat(); }
    else setDetails(false);
  };
  dock.addEventListener("keydown", (e) => {
    if (dockView !== "details") return;
    if (e.key !== "Escape" || (e.target as HTMLElement).closest("dialog")) return;
    e.stopPropagation();
    setDetails(false);
    head.querySelector<HTMLElement>(".chat-details-toggle")?.focus();
  });
  const detailsMembers = el("section", "chat-details-members");
  const notes = createChatNotes((m) => host.send(m), (text) => context.shareBrief(text));
  const dockTabs = el("div", "chat-details-tabs");
  dockTabs.setAttribute("role", "tablist");
  dockTabs.setAttribute("aria-label", "Terminal and chat details");
  /** The open terminal's tab: there only while one is open. */
  const termTab = btn("chat-details-tab chat-dock-term", "", "The agent terminal open beside the chat");
  termTab.setAttribute("role", "tab");
  termTab.hidden = true;
  termTab.onclick = () => { setDock("terminal"); paintChat(); };
  const setup = el("div", "chat-details-setup");
  setup.id = "chat-details-setup";
  setup.setAttribute("role", "tabpanel");
  /** Settings' own top and bottom: what the header's ⋯ used to hold (name, max replies; rules, archive, delete). */
  const basics = el("section", "chat-settings-basics");
  const ends = el("section", "chat-settings-ends");
  setup.append(basics, context.el, detailsMembers, ends);
  let capInput: HTMLInputElement | null = null;
  notes.el.id = "chat-details-notes";
  notes.el.setAttribute("role", "tabpanel");
  const tabBtns = ([["Settings", setup], ["Chat notes", notes.el]] as const).map(([label, panel], i) => {
    const b = btn("chat-details-tab", label, label === "Chat notes" ? "Your own notes on this chat; agents never get them" : "Name, max agent replies, mode, brief, rounds, members");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", panel.id);
    b.onclick = () => { setNotesTab(i === 1); setDetails(true); };
    return b;
  });
  /** A member's tab note, shown in the same right panel (the app's note editor takes the dock's place). */
  const agentNoteTab = btn("chat-details-tab", "Agent note", "The note of the member you picked (⌘⇧E)");
  agentNoteTab.setAttribute("role", "tab");
  agentNoteTab.onclick = () => showAgentNote();
  dockTabs.append(...tabBtns, agentNoteTab, termTab, el("span", "sp"), dockClose);
  // Arrow keys move between the tabs there are.
  dockTabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = [termTab, ...tabBtns].filter((b) => !b.hidden);
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = tabs[(at + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    next.click();
    next.focus();
  });
  const detailsGrip = el("div", "grip chat-details-grip");
  detailsGrip.setAttribute("role", "separator");
  detailsGrip.setAttribute("aria-orientation", "vertical");
  detailsGrip.setAttribute("aria-label", "Resize chat details");
  detailsGrip.tabIndex = 0;
  details.append(setup, notes.el);
  let detailsOpen = false;
  let notesTab = false;
  let dockView: "terminal" | "details" | null = null;
  function paintTabs() {
    const sel = [dockView === "terminal", dockView === "details" && !notesTab, dockView === "details" && notesTab];
    [termTab, ...tabBtns].forEach((b, i) => { b.setAttribute("aria-selected", String(sel[i])); b.tabIndex = sel[i] ? 0 : -1; b.classList.toggle("on", sel[i]!); });
    dockClose.title = dockView === "terminal" ? "Close the terminal" : "Close chat details";
  }
  function setNotesTab(on: boolean) {
    notesTab = on;
    setup.hidden = on;
    notes.el.hidden = !on;
    if (chat) remember(chat.id, { notes: on });
    paintTabs();
  }
  function setDock(view: "terminal" | "details" | null) {
    dockView = view;
    detailsOpen = view === "details";
    if (chat) remember(chat.id, { details: detailsOpen });
    dock.hidden = !view;
    side.hidden = view !== "terminal";
    details.hidden = view !== "details";
    wrap.classList.toggle("dock-term", view === "terminal");
    wrap.classList.toggle("dock-details", view === "details");
    paintTabs();
    if (view === "terminal") requestAnimationFrame(() => sideView?.fit());
    if (view) host.dockOpened();
  }

  /** The member the right panel is about: the one whose terminal is open, else whoever posted last. */
  function selectedMember(): ChatMember | undefined {
    if (!chat) return undefined;
    const agentsIn = chat.members.filter((m) => m.kind !== "user" && !m.left);
    if (sideHandle) return agentsIn.find((m) => m.handle === sideHandle);
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const hit = agentsIn.find((m) => m.handle === chat!.messages[i]!.from);
      if (hit) return hit;
    }
    return agentsIn[0];
  }

  function showAgentNote(m: ChatMember | undefined = selectedMember()) {
    setDock(null);
    paintChat();
    host.showAgentNote(m?.windowId ?? null);
  }
  const lines = el("div", "chat-lines");
  const strip = el("div", "chat-strip");
  const activity = createChatActivity();
  const compose = el("div", "chat-compose");
  const chipsEl = el("div", "chat-chips");
  const input = el("textarea", "chat-input");
  input.rows = 1;
  input.placeholder = "Message";
  input.setAttribute("aria-label", "Message the chat");
  const helper = el("span", "chat-helper");
  const suggest = el("div", "chat-suggest");
  suggest.hidden = true;
  /** The message the next post answers, shown above the box until it goes or is dropped. */
  const replyBar = el("div", "chat-reply-bar");
  replyBar.hidden = true;
  // Enter sends; the button is for the hand on the mouse (and says what Enter does).
  const sendBtn = btn("chat-send", "Send", "Send (Enter; Shift+Enter for a new line)");
  sendBtn.onclick = () => send();
  compose.append(replyBar, chipsEl, input, sendBtn, helper, suggest);
  const convo = el("div", "chat-convo");
  convo.append(lines, strip, activity.el, compose);
  const main = el("div", "chat-main");
  main.append(convo);
  /** The edge between the conversation and an agent's terminal: the conversation's width, dragged. */
  const paneGrip = el("div", "grip chat-pane-grip");
  paneGrip.setAttribute("role", "separator");
  paneGrip.setAttribute("aria-orientation", "vertical");
  paneGrip.setAttribute("aria-label", "Resize the chat beside the terminal");
  paneGrip.tabIndex = 0;
  pane.append(paneGrip);
  makeResizable({ grip: detailsGrip, panel: dock, host: wrap, cssVar: "--chat-details", storageKey: "muxnexus.chat-details-width", min: 240, max: 720, fallback: 300, edge: "left" });
  pane.append(head, main);
  const side = el("section", "chat-side");
  const sideHead = el("header", "chat-side-head");
  const sideTerm = el("div", "chat-term");
  side.append(sideHead, sideTerm);
  side.hidden = true;
  dock.append(detailsGrip, dockTabs, side, details);
  wrap.append(pane, dock);
  setNotesTab(false);
  els.main.append(wrap);
  makeResizable({ grip: paneGrip, panel: pane, host: wrap, cssVar: "--chat-pane", storageKey: "muxnexus.chat-pane-width", min: 420, max: 2400, fallback: 640, edge: "right" });

  /** Recipients picked as chips; the draft holds the rest. */
  let chips: string[] = [];
  /** Images pasted into the unsent message: saved on the server, named in the message when it goes. */
  let pasted: { name: string; path: string; url: string }[] = [];
  let uploading = 0;
  /** The agent the box last pre-filled: taken off, it isn't put back for the same agent. */
  let offered: string | null = null;
  /** Tab folds the user opened, by chat and message, so a repaint keeps them open. */
  const openTabs = new Set<string>();

  /** What the agent said in its tab that turn, folded under its line. */
  function tabFold(r: Row): HTMLElement | null {
    if (!r.tab || !chat) return null;
    const key = `${chat.id}#${r.id}`;
    const d = el("details", `chat-tab${r.tab.similar ? " similar" : ""}`);
    d.open = openTabs.has(key);
    d.ontoggle = () => { if (d.open) openTabs.add(key); else openTabs.delete(key); };
    const s = el("summary", "", `In its tab · ${r.tab.lines} line${r.tab.lines === 1 ? "" : "s"}${r.tab.similar ? " · much like the post" : ""}`);
    s.title = `Everything ${r.from} said in its own tab that turn, beside what it posted. Only you see this.`;
    const text = renderMarkdown(r.tab.text, chat.members.find((m) => m.handle === r.from)?.windowId);
    text.classList.add("chat-tab-text");
    d.append(s, text);
    return d;
  }

  const rowCache = new Map<string, { signature: string; node: HTMLElement }>();
  let headerSignature = "";
  let paintedChat: string | null = null;

  /** Details in the dock, or back to the terminal there was (or nothing). */
  function setDetails(on: boolean) {
    setDock(on ? "details" : sideHandle ? "terminal" : null);
    paintChat();
    if (on) (notesTab ? notes.focus() : tabBtns[0]!.focus({ preventScroll: true }));
  }

  /** Agents whose header switch can be seen whole: their state is there, so the activity row needn't repeat it. */
  function switchesInView(): Set<string> {
    const bar = agentBar.getBoundingClientRect();
    const out = new Set<string>();
    // Measured only when someone is working: the row shows nothing otherwise.
    if (!bar.width || !Object.values(agents).some((a) => a.state === "running")) return out;
    for (const b of agentBar.querySelectorAll<HTMLElement>(".chat-agent-switch")) {
      const r = b.getBoundingClientRect();
      if (r.left >= bar.left - 1 && r.right <= bar.right + 1 && b.dataset.handle) out.add(b.dataset.handle);
    }
    return out;
  }
  agentBar.addEventListener("scroll", () => activity.update(chat, agents, switchesInView()), { passive: true });
  // Dragging the dock changes what the bar shows without the window resizing.
  new ResizeObserver(() => activity.update(chat, agents, switchesInView())).observe(agentBar);

  function paintChat() {
    context.update(chat);
    notes.update(chat);
    if (!chat) {
      activity.update(null, agents);
      head.replaceChildren(el("span", "chat-name", openId ? "Loading…" : ""));
      lines.replaceChildren();
      agentBar.replaceChildren();
      rowCache.clear();
      headerSignature = "";
      strip.hidden = true;
      return;
    }
    const nextHeader = JSON.stringify([chat.id, chat.name, chat.mode, chat.round, chat.members, agents, sideHandle, sideWindow, sideOn, detailsOpen, notesTab, chat.cap, chat.archived]);
    if (headerSignature !== nextHeader) {
    headerSignature = nextHeader;
    const name = btn("chat-name", chat.name, "Double-click to rename (or use Rename in settings)");
    name.ondblclick = (e) => { e.preventDefault(); e.stopPropagation(); renameAt(name, chat!.id, chat!.name); };
    name.onclick = (e) => { if (e.detail === 0) { e.stopPropagation(); renameAt(name, chat!.id, chat!.name); } };
    const mode = chat.mode ? chat.mode[0]!.toUpperCase() + chat.mode.slice(1) : "General";
    const onSettings = detailsOpen && !notesTab;
    const detailsBtn = btn(`chat-details-toggle${onSettings ? " on" : ""}`, `Settings · ${mode}`, "Name, max agent replies, mode, brief, rounds, members");
    detailsBtn.setAttribute("aria-expanded", String(onSettings));
    detailsBtn.setAttribute("aria-controls", details.id);
    detailsBtn.onclick = () => { if (onSettings) setDetails(false); else { setNotesTab(false); setDetails(true); } };
    const onNotes = detailsOpen && notesTab;
    const notesBtn = btn(`chat-notes-toggle${onNotes ? " on" : ""}`, "Notes", "Your own notes on this chat");
    notesBtn.onclick = () => { if (onNotes) setDetails(false); else { setNotesTab(true); setDetails(true); } };
    const round = chat.round?.state === "open" ? btn("chat-round-pill", `Round ${chat.round.submitted.length}/${chat.round.participants.length}`, "Independent round open: peer answers withheld until all submit. Open details to reveal.") : null;
    if (round) round.onclick = () => setDetails(true);
    const find = btn("chat-find", "Find", "Find in this chat's messages and notes (⌘F)");
    find.onclick = () => host.find();
    const more = btn("chat-more icon-btn", "⋯", "Chat menu");
    more.onclick = (e) => {
      e.stopPropagation();
      const c = chats.find((x) => x.id === chat!.id);
      if (c) chatMenuAt(more, c, () => renameAt(name, c.id, c.name));
    };
    onContextMenu(name, (at) => { const c = chats.find((x) => x.id === chat!.id); if (c) chatMenuAt(at, c, () => renameAt(name, c.id, c.name)); });
    const narrowSwitch = el("div", "chat-switch");
    if (sideWindow) {
      const a = btn(`seg${sideOn ? "" : " on"}`, "Chat");
      const b = btn(`seg${sideOn ? " on" : ""}`, "Terminal");
      a.onclick = () => { sideOn = false; wrap.classList.remove("show-side"); paintChat(); };
      b.onclick = () => { sideOn = true; wrap.classList.add("show-side"); paintChat(); };
      narrowSwitch.append(a, b);
    }
    // On a phone the top bar's menu button is out of sight: the chat brings its own.
    const burger = btn("chat-burger icon-btn", "☰", "Show the sidebar");
    burger.onclick = () => document.getElementById("hamburger")?.click();
    head.replaceChildren(burger, name, agentBar, el("span", "sp"), narrowSwitch, ...(round ? [round] : []), notesBtn, find, detailsBtn, more);
    paintSettings();
    agentBar.replaceChildren();
    for (const m of chat.members) {
      if (m.kind === "user" || m.left) continue;
      const live = agents[m.handle];
      const credits = live?.online && live.limit ? creditsText(live.limit) : "";
      // Short on the switch; the time is in its tooltip and the member list.
      const state = credits ? "Out of credits" : live?.state === "input" ? "Needs you" : live?.state === "running" ? "Working" : live?.online ? "Idle" : "Offline";
      const selected = sideHandle === m.handle && !!sideWindow;
      const b = btn(`chat-agent-switch${selected ? " selected" : ""}`, "", `Open ${m.handle} terminal · ${credits || state}`);
      b.setAttribute("aria-pressed", String(selected));
      b.dataset.handle = m.handle;
      const stateEl = el("span", `chat-agent-state${credits ? " limited" : live?.state === "input" ? " needs-you" : live?.state === "running" ? " working" : ""}`, state);
      if (!credits && live?.state === "running") stateEl.prepend(workingDots());
      b.append(agentMark(m.kind, m.shape), el("span", "chat-agent-handle", m.handle), stateEl);
      b.disabled = !canOpen(m, live);
      if (b.disabled) b.title = memberStatus(chat, m, live).text;
      // One picked member for both views: the note when a note is showing, else the terminal.
      b.onclick = () => (host.agentNoteShowing() ? host.showAgentNote(m.windowId ?? null) : openSide(m.handle));
      onContextMenu(b, (at) => memberMenuAt(at, m));
      agentBar.append(b);
    }
    const roster = membersMenu();
    roster.classList.add("chat-details-roster");
    detailsMembers.replaceChildren(el("h3", "chat-details-label", "Members"), roster);
    }


    const atBottom = lines.scrollHeight - lines.scrollTop - lines.clientHeight < 24;
    const rows = messageRows(chat);
    const nodes: HTMLElement[] = [];
    activity.update(chat, agents, switchesInView());
    const present = new Set<string>();
    if (paintedChat !== chat.id) { rowCache.clear(); lines.replaceChildren(); }
    for (const r of rows) {
      const key = `${chat.id}#${r.id}`;
      present.add(key);
      const signature = JSON.stringify([r, chat.members.find((m) => m.handle === r.from)?.windowId]);
      const cached = rowCache.get(key);
      if (cached?.signature === signature) { nodes.push(cached.node); continue; }
      const group = el("article", "chat-message");
      group.dataset.messageId = String(r.id);
      const built: HTMLElement[] = [];
      if (r.kind === "system") {
        built.push(el("div", "chat-sys", r.text));
        const fold = tabFold(r);
        if (fold) built.push(fold);
        group.append(...built);
        rowCache.set(key, { signature, node: group }); nodes.push(group);
        continue;
      }
      const line = el("div", `chat-line${r.me ? " me" : ""}${r.turnStart ? " turn" : ""}`);
      const shape = r.me ? el("span", "chat-shape", r.shape) : agentMark(chat.members.find((m) => m.handle === r.from)?.kind ?? "", r.shape);
      const who = btn("chat-who", r.me ? "you" : r.from, r.me ? undefined : `${r.from}: open its terminal beside the chat`);
      if (r.colour) who.style.color = r.colour;
      if (!r.me) who.onclick = () => openSide(r.from);
      const body = el("div", "chat-body");
      const rendered = renderMarkdown(r.text, chat.members.find((m) => m.handle === r.from)?.windowId);
      if (r.text.length > 2400 || r.text.split("\n").length > 28) {
        const fold = el("details", "chat-long");
        const foldKey = `${key}:long`;
        fold.open = openTabs.has(foldKey);
        fold.ontoggle = () => { if (fold.open) openTabs.add(foldKey); else openTabs.delete(foldKey); };
        fold.append(el("summary", "", `Long answer · ${r.text.split("\n").length} lines`), rendered);
        body.append(fold);
      } else body.append(rendered);
      if (r.tick) {
        const t = el("span", `chat-tick${r.tick === "◷" ? " wait" : ""}`, r.tick);
        const m = chat.messages.find((x) => x.id === r.id)!;
        t.title = Object.entries(m.deliveries).map(([h, d]) => `${h}: ${d.state === "queued" && d.reason === "sent" ? "sent, not yet seen" : d.state}${d.reason && d.reason !== "sent" ? ` (${d.reason})` : ""}`).join("\n");
        body.append(t);
      }
      // Under the name, in the gutter: shown on hover or focus, it never covers the text.
      const whoCol = el("div", "chat-who-col");
      line.append(shape, whoCol, body);
      const reply = btn("chat-handoff-action chat-reply-action", "Reply", `Answer #${r.id}: your post links to it`);
      reply.onclick = () => startReply(r.id, r.from);
      const handoff = btn("chat-handoff-action", "Hand off", "Send this answer or selected text to another agent");
      handoff.onclick = () => {
        const selection = window.getSelection();
        const excerpt = selection && !selection.isCollapsed && selection.anchorNode && group.contains(selection.anchorNode) && selection.focusNode && group.contains(selection.focusNode) ? selection.toString() : r.text;
        context.handoff(excerpt, `Message #${r.id} from ${r.from}`);
      };
      whoCol.append(who, reply, handoff);
      if (r.replyTo) {
        const q = r.replyTo;
        const quote = btn("chat-reply-quote", "", `Go to #${q.id}`);
        quote.append(el("span", "chat-reply-label", `↪ #${q.id}${q.from ? ` ${q.from === "user" ? "you" : `@${q.from}`}` : ""}`), el("span", "chat-reply-text", q.text));
        quote.onclick = () => { if (chat) { revealing = { chatId: chat.id, messageId: q.id }; applyReveal(); } };
        body.prepend(quote);
      }
      built.push(line);
      const fold = tabFold(r);
      if (fold) built.push(fold);
      for (const x of r.exceptions) built.push(el("div", `chat-ex${x.startsWith("✕") ? " bad" : ""}`, x));
      group.append(...built);
      rowCache.set(key, { signature, node: group }); nodes.push(group);
    }
    if (!rows.some((r) => r.kind === "msg")) nodes.push(el("div", "chat-empty", "Nobody's been woken yet. Mention an agent to give it the first task."));
    for (const key of rowCache.keys()) if (!present.has(key)) rowCache.delete(key);
    // Reuse unchanged message nodes so polling cannot erase selection, copy feedback or open folds.
    let cursor = lines.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else lines.insertBefore(node, cursor);
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    if (atBottom || paintedChat !== chat.id) lines.scrollTop = lines.scrollHeight;
    paintedChat = chat.id;

    const held = heldCount(chat);
    if (chat.paused) {
      const why = chat.paused.reason === "cap" ? `after ${chat.cap} agent replies` : `by ${chat.paused.by ?? "an agent"}${chat.paused.detail ? `: ${chat.paused.detail}` : ""}`;
      strip.replaceChildren(el("b", "", "‖ Paused"), ` ${why}${held ? ` · ${held} held` : ""} · your next message ${held ? "releases them" : "resumes it"}`, el("span", "sp"));
      if (chat.paused.reason === "cap") {
        const limit = btn("chat-discard", "Change limit", "Max agent replies, in Settings");
        limit.onclick = () => { setNotesTab(false); setDetails(true); capInput?.focus(); };
        strip.append(limit);
      }
      if (held) {
        const d = btn("chat-discard", "Discard");
        d.onclick = () => host.send({ t: "chat-discard-held", id: chat!.id });
        strip.append(d);
      }
      strip.hidden = false;
    } else {
      strip.hidden = true;
    }
    paintCompose();
  }

  // ---- the message box --------------------------------------------------------

  function paintCompose() {
    if (!chat) return;
    replyBar.hidden = replying === null;
    if (replying !== null) {
      const q = replyQuote(chat, replying);
      const drop = btn("chat-chip-x", "✕", "Don't reply to it (Esc)");
      drop.onclick = () => { setReplying(null); paintCompose(); input.focus(); };
      replyBar.replaceChildren(el("span", "chat-reply-label", `Replying to #${q.id}${q.from ? ` ${q.from === "user" ? "you" : `@${q.from}`}` : ""}:`), el("span", "chat-reply-text", q.text), drop);
    }
    chipsEl.replaceChildren(...chips.map((h) => {
      const m = chat!.members.find((x) => x.handle === h);
      const c = el("span", "chat-chip");
      if (m) { c.append(agentMark(m.kind, m.shape)); c.style.color = memberColour(m) ?? ""; }
      c.append(`@${h}`);
      const x = btn("chat-chip-x", "✕", `Don't send to ${h}`);
      x.onclick = () => { chips = chips.filter((y) => y !== h); paintCompose(); input.focus(); };
      c.append(x);
      return c;
    }));
    chipsEl.append(...pasted.map((p) => {
      const t = el("span", "chat-thumb");
      const img = document.createElement("img");
      img.src = p.url; img.alt = "pasted image";
      const x = btn("chat-chip-x", "✕", "Don't send this image");
      x.onclick = () => { pasted = pasted.filter((y) => y !== p); paintCompose(); input.focus(); };
      t.append(img, x);
      return t;
    }), ...(uploading ? [el("span", "chat-thumb-wait", "Uploading…")] : []));
    const text = withChips(chat, chips, input.value);
    const st = composerState(chat, input.value.trim() || chips.length ? text : "");
    // The chips say who hears it; the box speaks up only when nobody will.
    helper.textContent = st.helper ?? "";
    helper.classList.toggle("none", st.helper !== null);
  }

  function send() {
    if (!chat) return;
    // A chip the text names as well posts one mention, not two.
    const typed = withChips(chat, chips, input.value);
    if (!input.value.trim() && !pasted.length) return;
    if (uploading) { host.toast("Wait for the image to finish uploading"); return; }
    // The path is what an agent opens; this chat shows it as the picture.
    const text = [typed, ...pasted.map((p) => `![pasted image](<${p.path}>)`)].filter(Boolean).join("\n\n");
    host.send({ t: "chat-post", id: chat.id, text, ...(replying !== null ? { replyTo: replying } : {}) });
    setReplying(null);
    input.value = "";
    pasted = [];
    // `offered` stays on the line last offered: that one isn't offered again, while a line
    // that came in as the user typed (never offered, the box being busy) is, now it's empty.
    chips = [];
    remember(chat.id, { draft: "", chips: [] });
    paintCompose();
    autosize();
  }

  async function attach(files: File[]) {
    const id = chat?.id;
    if (!id) return;
    for (const f of files) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { host.toast("Only png, jpeg, gif and webp images can be pasted"); continue; }
      uploading++; paintCompose();
      try {
        const res = await fetch(`/api/chat/image/${id}`, { method: "POST", headers: { "content-type": f.type }, body: f });
        const body = (await res.json().catch(() => null)) as { ok: boolean; name?: string; path?: string; url?: string; error?: string } | null;
        if (res.ok && body?.ok && body.name && body.path && body.url) { if (chat?.id === id) pasted.push({ name: body.name, path: body.path, url: body.url }); }
        else host.toast(body?.error ?? `Couldn't upload the image (${res.status})`);
      } catch {
        host.toast("Couldn't upload the image");
      } finally {
        uploading--; paintCompose();
      }
    }
  }
  const imagesIn = (dt: DataTransfer | null) => [...(dt?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  input.addEventListener("paste", (e) => {
    const files = imagesIn(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void attach(files);
  });
  compose.addEventListener("dragover", (e) => { if (imagesIn(e.dataTransfer).length || [...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault(); });
  compose.addEventListener("drop", (e) => {
    const files = imagesIn(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    void attach(files);
  });

  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  let choices: { handle: string; meta: string }[] = [];
  let choice = 0;
  function mentionQuery(): { start: number; query: string } | null {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
    const m = /(^|[\s(])@([A-Za-z0-9_-]*)$/.exec(upto);
    return m ? { start: upto.length - m[2]!.length - 1, query: m[2]! } : null;
  }
  function paintSuggest() {
    const q = chat ? mentionQuery() : null;
    choices = q && chat ? mentionChoices(chat, agents, q.query) : [];
    if (!choices.length) { suggest.hidden = true; return; }
    choice = Math.min(choice, choices.length - 1);
    suggest.replaceChildren(...choices.map((c, i) => {
      const r = btn(`chat-suggest-row${i === choice ? " on" : ""}`, "");
      const m = chat!.members.find((x) => x.handle === c.handle)!;
      r.append(agentMark(m.kind, m.shape), el("span", "h", `@${c.handle}`), el("span", "meta", c.meta));
      r.onmousedown = (e) => { e.preventDefault(); pick(c.handle); };
      return r;
    }), el("div", "chat-suggest-foot", "↑↓ choose · ↵ insert · a mention wakes that agent"));
    suggest.hidden = false;
  }
  function pick(handle: string) {
    const q = mentionQuery();
    if (!q) return;
    const caret = input.selectionStart ?? input.value.length;
    input.value = `${input.value.slice(0, q.start)}@${handle} ${input.value.slice(caret)}`;
    const at = q.start + handle.length + 2;
    input.setSelectionRange(at, at);
    suggest.hidden = true;
    paintCompose();
  }
  input.addEventListener("input", () => { choice = 0; paintSuggest(); paintCompose(); autosize(); if (chat) remember(chat.id, { draft: input.value }); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && replying !== null && suggest.hidden) { e.preventDefault(); setReplying(null); paintCompose(); return; }
    // ⌘ shortcuts (⌘J, ⌘K…) still work from the message box; plain keys stay in it.
    if (!e.metaKey) e.stopPropagation();
    if (!suggest.hidden && choices.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); choice = (choice + 1) % choices.length; paintSuggest(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); choice = (choice + choices.length - 1) % choices.length; paintSuggest(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(choices[choice]!.handle); return; }
      if (e.key === "Escape") { e.preventDefault(); suggest.hidden = true; return; }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0 && chips.length) { chips.pop(); paintCompose(); }
  });
  input.addEventListener("blur", () => setTimeout(() => { suggest.hidden = true; }, 100));

  function saveDraft() {
    if (chat) remember(chat.id, { draft: input.value, chips, scroll: lines.scrollTop, ...(sideHandle ? { member: sideHandle } : {}) });
  }

  // ---- the member's terminal beside the chat ----------------------------------

  let sideConn: Connection | null = null;
  let sideView: TerminalView | null = null;
  let sideWindow: string | null = null;
  let sideHandle: string | null = null;
  let sideOn = false;

  function openSide(handle: string) {
    const m = chat?.members.find((x) => x.handle === handle);
    const session = agents[handle]?.session ?? m?.session;
    if (!chat || !m) return;
    if (!canOpen(m, agents[handle]) || !session) {
      host.toast(m.left ? `${handle} has left` : m.windowId ? `${handle} is offline` : `${handle} has no tab: it didn't start`);
      return;
    }
    if (sideHandle === handle && sideWindow === m.windowId && sideConn) { sideOn = true; wrap.classList.add("show-side"); setDock("terminal"); paintChat(); sideView?.focus(); return; }
    sideHandle = handle;
    sideWindow = m.windowId ?? null;
    remember(chat.id, { member: handle });
    wrap.classList.add("has-side");
    sideOn = true;
    wrap.classList.add("show-side");
    termTab.hidden = false;
    termTab.replaceChildren(agentMark(m.kind, m.shape), ` ${handle}`);
    setDock("terminal");
    paintSideHead(m, session);
    sideView ??= createTerminal(sideTerm, {
      windowId: () => sideWindow ?? undefined,
      onInput: (d) => sideConn?.sendInput(d),
      onResize: (cols, rows) => sideConn?.send({ t: "resize", cols, rows }),
      onScroll: (lines) => sideConn?.send({ t: "scroll", lines }),
    });
    const t = sideView;
    t.reset();
    requestAnimationFrame(() => t.fit());
    sideConn?.close();
    const c = new Connection(host.wsUrl, {
      onOpen() {
        c.send({ t: "resize", cols: t.cols, rows: t.rows });
        c.send({ t: "attach-view", session, id: m.windowId! });
      },
      onClose() {},
      onMessage(msg) {
        if (msg.t === "detached") closeSide();
        else if (msg.t === "error") host.toast(msg.message);
      },
      onOutput: (b) => t.write(b),
    });
    sideConn = c;
    c.connect();
    paintChat();
  }

  function paintSideHead(m: ChatMember, session: string) {
    const who = btn("chat-side-who", "", "Show another member's terminal");
    // Role and folder say which agent this is; the tmux session's name can read like a chat's.
    const folder = m.folder?.split("/").filter(Boolean).pop();
    who.append(agentMark(m.kind, m.shape), ` ${[m.handle, m.role, folder].filter(Boolean).join(" · ")} ▾`);
    who.title = `Show another member's terminal · ${m.handle} runs in session ${session}${m.folder ? `, ${m.folder}` : ""}`;
    who.onclick = (e) => { e.stopPropagation(); toggleMenu(who, membersMenu(true)); };
    const expand = btn("chat-side-btn", "⤢ Expand", "Open this tab in its workspace");
    expand.onclick = () => expandTo(m.handle);
    sideHead.replaceChildren(who, el("span", "sp"), expand);
  }

  function closeSide() {
    sideConn?.close();
    sideConn = null;
    sideView?.dispose();
    sideView = null;
    sideWindow = null;
    sideHandle = null;
    termTab.hidden = true;
    wrap.classList.remove("has-side", "show-side");
    if (dockView === "terminal") setDock(null);
  }

  // ---- menus --------------------------------------------------------------------

  function toggleMenu(anchor: HTMLElement, content: HTMLElement) {
    const was = menu?.dataset.anchor === anchor.className;
    closeMenu();
    if (was) return;
    content.classList.add("chat-menu");
    content.dataset.anchor = anchor.className;
    // Fixed to the page, so a menu opened from the tab strip shows as one opened in the chat does.
    const r = anchor.getBoundingClientRect();
    content.style.top = `${r.bottom + 4}px`;
    content.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 400))}px`;
    document.body.append(content);
    menu = content;
  }
  function closeMenu() { menu?.remove(); menu = null; }

  /** A one-field form in place of the open menu: no native dialogs, which iPad Safari draws badly. */
  function ask(label: string, value: string, done: (v: string) => void, type: "text" | "number" = "text") {
    if (!menu) return;
    const form = el("form", "chat-ask");
    const i = el("input", "chat-ask-input");
    i.type = type;
    i.value = value;
    if (type === "number") { i.min = "0"; i.max = "50"; }
    i.setAttribute("aria-label", label);
    const ok = btn("chat-btn pri", "OK");
    ok.type = "submit";
    form.append(el("div", "chat-menu-title", label), i, ok);
    form.onsubmit = (e) => { e.preventDefault(); done(i.value); closeMenu(); };
    i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeMenu(); });
    menu.replaceChildren(form);
    i.focus();
    i.select();
  }

  function showRules() {
    const back = el("div", "chat-modal-back");
    const box = el("div", "chat-modal");
    const h = el("header", "chat-modal-head", "House rules");
    const x = btn("icon-btn", "✕");
    x.onclick = () => back.remove();
    h.append(el("span", "sp"), x);
    box.append(h, el("pre", "chat-rules", ["Standing rules (sent when joining or updated; older context is retrieved on demand):", "", ...chatRules(chat?.cap ?? 3, chat?.mode)].join("\n")));
    back.append(box);
    back.onclick = (e) => { if (e.target === back) back.remove(); };
    document.body.append(back);
  }
  document.addEventListener("click", (e) => { if (menu && !menu.contains(e.target as Node)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu) closeMenu(); });

  function membersMenu(pickOnly = false): HTMLElement {
    const box = el("div", "chat-members-menu");
    if (!chat) return box;
    for (const m of chat.members) {
      if (m.kind === "user" || m.left) continue;
      const live = agents[m.handle];
      const st = memberStatus(chat, m, live);
      const r = el("div", "chat-member");
      r.dataset.handle = m.handle;
      const shape = agentMark(m.kind, m.shape);
      const glyph = el("span", `glyph ${live?.state === "input" ? "input" : live?.state === "running" ? "running" : live?.online ? "seen" : "none"}`, live?.state === "input" ? "●" : live?.state === "running" ? "" : live?.online ? "○" : "·");
      const name = btn("chat-member-name", m.handle, "Open its terminal beside the chat");
      name.style.color = memberColour(m) ?? "";
      name.onclick = () => { closeMenu(); openSide(m.handle); };
      const meta = el("span", `chat-member-meta${st.alarm ? " alarm" : ""}`, pickOnly ? [m.kind === "codex" ? "Codex" : "Claude", live?.session ?? m.session, m.role].filter(Boolean).join(" · ") : `${[m.kind === "codex" ? "Codex" : "Claude", live?.session ?? m.session, m.role].filter(Boolean).join(" · ")} · ${st.text}`);
      r.append(shape, glyph, name, meta);
      if (!pickOnly) {
        if (st.fix === "open") {
          const b = btn("chat-fix", "Open terminal");
          b.onclick = () => { closeMenu(); openSide(m.handle); };
          r.append(b);
        } else if (st.fix === "reconnect") {
          const b = btn("chat-fix", "Reconnect", "Point it at the tab its conversation was resumed in");
          b.onclick = () => { closeMenu(); reconnect(m); };
          r.append(b);
        } else if (st.fix === "retry") {
          // Staged again in the picker, so a folder that was wrong can be put right first.
          const b = btn("chat-fix", "Retry…");
          b.onclick = () => {
            closeMenu();
            const sessions = host.sessions();
            addAgents(m.handle, [retryStaged(m, sessions, nearAgent(chat!, sessions)?.session ?? host.currentSession() ?? sessions[0]?.name ?? "")]);
          };
          r.append(b);
        }
        const dots = btn("chat-fix more", "⋯", "Menu (or right-click)");
        dots.onclick = (e) => { e.stopPropagation(); closeMenu(); memberMenuAt(dots, m); };
        onContextMenu(r, (at) => { closeMenu(); memberMenuAt(at, m); });
        r.append(dots);
      }
      box.append(r);
    }
    if (!pickOnly) {
      const add = btn("chat-member-add", "+ Add an agent");
      add.onclick = () => { closeMenu(); addAgents(); };
      box.append(el("div", "chat-sep"), add);
    }
    return box;
  }



  function reconnect(m: ChatMember) {
    // The server looks for the tab holding this member's conversation, of either kind.
    host.send({ t: "chat-reconnect", id: chat!.id, handle: m.handle });
  }



  /** Rename a chat in place on its row. */
  function renameRow(r: HTMLElement, id: string, name: string) {
    const label = r.querySelector<HTMLElement>(".label");
    if (!label) return;
    inlineEdit(label, {
      value: name,
      label: "Chat name",
      save: (n) => host.send({ t: "chat-settings", id, name: n }),
      // The row only redraws its content when that changes: make it.
      done: () => { r.dataset.content = ""; paintList(); },
    });
  }

  /** A chat row's menu (right-click). Delete's "also shut down" needs the chat's members, so only the open one has it. */
  function chatMenuAt(at: Anchor, c: ChatSummary, rename: () => void) {
    const isOpen = c.id === openId && chat?.id === c.id;
    const down = isOpen ? shutdownList(chat!, chats, agents).down : [];
    const shutdown = down.length ? `Also shut down ${down.join(", ")}: closes ${down.length === 1 ? "its tab" : "their tabs"}` : undefined;
    openMenu(at, chatMenu({ name: c.name, archived: c.archived, current: isOpen && showing, members: c.members, ...(shutdown ? { shutdown } : {}) }), (action, { option }) => {
      switch (action) {
        case "chat-open": return open(c.id);
        case "chat-notes":
        case "chat-settings":
          open(c.id);
          setNotesTab(action === "chat-notes");
          setDetails(true);
          return;
        case "chat-rename": return rename();
        case "chat-archive": return void host.send({ t: "chat-archive", id: c.id, archived: true });
        case "chat-reopen": return void host.send({ t: "chat-archive", id: c.id, archived: false });
        case "chat-delete": return void host.send({ t: "chat-delete", id: c.id, closeTabs: option });
        default: return;
      }
    });
  }

  /** A member's menu: what it does in this chat, then the same agent menu as everywhere. */
  function memberMenuAt(at: Anchor, m: ChatMember) {
    if (!chat) return;
    const id = chat.id;
    const a = m.windowId ? host.agentFor(m.windowId) : null;
    openMenu(at, memberMenu({ handle: m.handle, ...(m.role ? { role: m.role } : {}), present: a !== null, agent: a?.target ?? null }), (action) => {
      switch (action) {
        case "member-note": return a?.pick("note");
        case "member-terminal": return openSide(m.handle);
        case "change-role": return editRole(m);
        case "replace": return addAgents(m.handle);
        case "remove": return void host.send({ t: "chat-remove", id, handle: m.handle });
        case "reconnect": return reconnect(m);
        case "kill":
          host.send({ t: "chat-remove", id, handle: m.handle });
          return a?.pick("kill");
        default: return a?.pick(action);
      }
    });
  }

  /** The role, edited in place on the member's row in Setup (opened for it if need be). */
  function editRole(m: ChatMember) {
    if (!chat) return;
    const id = chat.id;
    setNotesTab(false);
    setDetails(true);
    const row = detailsMembers.querySelector<HTMLElement>(`.chat-member[data-handle="${CSS.escape(m.handle)}"]`);
    const meta = row?.querySelector<HTMLElement>(".chat-member-meta");
    if (!meta) return;
    inlineEdit(meta, {
      value: m.role ?? "",
      label: `Role for ${m.handle} (empty for none)`,
      allowEmpty: true,
      save: (r) => host.send({ t: "chat-role", id, handle: m.handle, role: r }),
      done: () => paintChat(),
    });
  }

  /** Name, Max agent replies (− n +), then after the members: House rules, Archive, Delete. */
  function paintSettings() {
    if (!chat) return;
    const c = chat;
    const nameRow = el("div", "chat-set-row");
    const nameVal = btn("chat-set-name", c.name, "Click to rename");
    nameVal.onclick = () => inlineEdit(nameVal, { value: c.name, label: "Chat name", save: (n) => host.send({ t: "chat-settings", id: c.id, name: n }), done: () => { headerSignature = ""; paintChat(); } });
    nameRow.append(el("span", "chat-set-label", "Name"), nameVal);

    const capRow = el("div", "chat-set-row chat-cap");
    const capText = el("span", "chat-set-label");
    capText.append(el("span", "chat-set-title", "Max agent replies"), el("span", "chat-set-note", c.cap ? `Waits for you after ${c.cap} in a row. 0 = never` : "Never waits for you"));
    const setCap = (n: number) => { const v = Math.max(0, Math.min(50, n)); if (v !== c.cap) host.send({ t: "chat-settings", id: c.id, cap: v }); };
    const dec = btn("chat-step", "−", "Fewer");
    dec.onclick = () => setCap(c.cap - 1);
    dec.disabled = c.cap <= 0;
    const val = el("input", "chat-step-value");
    val.type = "number"; val.min = "0"; val.max = "50"; val.value = String(c.cap);
    val.setAttribute("aria-label", "Max agent replies (0 = never wait)");
    val.onchange = () => { const n = parseCap(val.value); if (n !== null) setCap(n); else val.value = String(c.cap); };
    val.addEventListener("keydown", (e) => e.stopPropagation());
    capInput = val;
    const inc = btn("chat-step", "+", "More");
    inc.onclick = () => setCap(c.cap + 1);
    inc.disabled = c.cap >= 50;
    capRow.append(capText, dec, val, inc);
    basics.replaceChildren(nameRow, capRow);

    const rules = btn("chat-set-link", "House rules…", "The standing rules every agent here gets");
    rules.onclick = () => showRules();
    const archive = btn("chat-btn", c.archived ? "Reopen chat" : "Archive chat");
    archive.onclick = () => host.send({ t: "chat-archive", id: c.id, archived: !c.archived });
    const del = btn("chat-btn danger", "Delete chat…");
    const buttons = el("div", "chat-set-buttons");
    del.onclick = () => {
      // Asked here, in place: what goes, and whether its agents go too.
      const { down } = shutdownList(c, chats, agents);
      const box = el("div", "chat-set-confirm");
      box.append(el("div", "", `Delete "${c.name}" for good? Its messages go. Its agents keep running.`));
      let shut: HTMLInputElement | null = null;
      if (down.length) {
        const label = el("label", "chat-delete-shut");
        shut = el("input"); shut.type = "checkbox";
        label.append(shut, `Also shut down ${down.join(", ")}`);
        box.append(label);
      }
      const yes = btn("chat-btn danger", "Delete");
      yes.onclick = () => host.send({ t: "chat-delete", id: c.id, closeTabs: shut?.checked ?? false });
      const no = btn("chat-btn", "Cancel");
      no.onclick = () => { headerSignature = ""; paintChat(); };
      box.append(no, yes);
      buttons.replaceWith(box);
      no.focus();
    };
    buttons.append(archive, del);
    ends.replaceChildren(rules, buttons);
  }

  function renameAt(anchor: HTMLElement, id: string, name: string) {
    closeMenu();
    toggleMenu(anchor, el("div", "chat-settings-menu"));
    ask("Chat name", name, (n) => { if (n.trim()) host.send({ t: "chat-settings", id, name: n.trim() }); });
  }

  /** The name field, in place of the open menu (none open, as when the name was clicked again: nothing). */


  /** In place of the open menu: what Delete does, and whether its agents go too (off unless ticked). */


  // ---- new chat and adding ----------------------------------------------------

  function newChat(preselect?: string) {
    openPicker({
      mode: "create",
      sessions: host.sessions(),
      profiles: host.profiles(),
      inChat: new Set(),
      existing: [],
      ...(preselect ? { preselect } : {}),
      currentSession: host.currentSession(),
      submit: (r) => host.send({ t: "chat-create", ...(r.name ? { name: r.name } : {}), members: r.members, spawn: r.spawn }),
    });
  }

  function addAgents(replacing?: string, stage?: StagedAgent[]) {
    if (!chat) return;
    const id = chat.id;
    const sessions = host.sessions();
    openPicker({
      mode: "add",
      sessions,
      profiles: host.profiles(),
      inChat: new Set(chat.members.filter((m) => !m.left && m.windowId).map((m) => m.windowId!)),
      existing: chat.members,
      currentSession: host.currentSession(),
      near: nearAgent(chat, sessions),
      ...(stage ? { stage } : {}),
      submit: (r) => {
        host.send({ t: "chat-add", id, members: r.members, spawn: r.spawn });
        if (replacing) host.send({ t: "chat-remove", id, handle: replacing });
      },
    });
  }

  // ---- what the server sends ----------------------------------------------------

  return {
    failed(message: string) { context.failed(message); },
    notesResult: notes.result,
    reveal,
    /** The chat in view, for a search scoped to it. */
    current: () => (showing && chat ? { id: chat.id, name: chat.name } : null),
    setChats(list: ChatSummary[]) {
      chats = list;
      if (openId && !chats.some((c) => c.id === openId)) open(null);
      paintList();
    },
    setChat(c: Chat, a: Record<string, ChatMemberLive>) {
      if (c.id !== openId) return;
      const first = chat === null;
      if (chat && chat.id !== c.id) pasted = [];
      if (first) replying = null;
      chat = c;
      agents = a;
      if (first) {
        const r = remembered(c.id);
        input.value = r.draft ?? "";
        // Only to a line still in the chat: one deleted or never there drops the link, not the draft.
        replying = r.replyTo !== undefined && c.messages.some((m) => m.id === r.replyTo && !m.system && !m.auto) ? r.replyTo : null;
        // A line already answered, or whose chip was taken off, isn't offered again after a reload.
        const fresh = r.offered !== prefillKey(c);
        chips = (r.chips?.length ? r.chips : fresh ? [prefill(c)].filter((x): x is string => !!x) : []).filter((h) => c.members.some((m) => m.handle === h && !m.left));
        offered = prefillKey(c);
        if (fresh) remember(c.id, { offered: offered ?? undefined });
        setNotesTab(r.notes === true);
        autosize();
        if (r.member && showing && !host.onPhone()) openSide(r.member);
        if (r.details) setDock("details");
        else if (dockView === "details") setDock(sideHandle ? "terminal" : null);
      } else {
        const was = offered;
        ({ chips, offered } = prefillChips({ chips, draft: input.value, offered }, c));
        if (offered !== was) remember(c.id, { chips, offered: offered ?? undefined });
      }
      paintChat();
      applyReveal();
    },
    created(id: string) { setTab("chats"); open(id); },
    open,
    leaveForWorkspace,
    isShowing: () => showing,
    openId: () => openId,
    connected() {
      host.send({ t: "chats", on: true });
      if (openId) host.send({ t: "chat-open", id: openId });
      notes.reconnected();
    },
    asking: () => chatsAsking(chats, showing ? openId : null),
    tabChats: () => tabChats(chats),
    newChat,
    /** ⌘⇧E in a chat: the picked member's note. */
    agentNote: () => showAgentNote(),
    /** The right side gives way to a note: the chat's panel closes. */
    closeDock: () => { if (dockView) { setDock(null); paintChat(); } },
    /** The tab strip's chat mark: that agent's chats, and a way to start another with it. */
    tabMenu(anchor: HTMLElement, list: ChatSummary[], windowId: string) {
      const box = el("div", "chat-tab-menu");
      box.append(el("div", "chat-menu-title", list.length === 1 ? "In a chat" : `In ${list.length} chats`));
      for (const c of list) {
        const r = btn("chat-mi", "");
        const g = c.glyph === "paused" ? el("span", "glyph paused", "‖") : el("span", `glyph ${c.glyph}`, GLYPH[c.glyph as keyof typeof GLYPH] ?? "");
        r.append(g, ` ${c.name}`);
        r.onclick = () => { closeMenu(); setTab("chats"); open(c.id); };
        box.append(r);
      }
      const start = btn("chat-mi", "Start a chat with this agent");
      start.onclick = () => { closeMenu(); newChat(windowId); };
      box.append(el("div", "chat-sep"), start);
      toggleMenu(anchor, box);
    },
    setTab,
    tab: () => tab,
    focus: () => input.focus(),
    fit: () => sideView?.fit(),
    init() {
      setTab(tab);
      // Back where the page was: in the chat it showed.
      if (openId && store.get(SHOWING_KEY)) open(openId);
    },
  };
}

export type ChatUI = ReturnType<typeof createChatUI>;
