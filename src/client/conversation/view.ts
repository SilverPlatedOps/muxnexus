// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { SEARCH_LIMITS, type AgentKind } from "../../shared/chat";
import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import type { AgentInfo, ClientMessage, ServerMessage, SessionInfo, WindowInfo } from "../../shared/protocol";
import { formatElapsed, GLYPH, GLYPH_TITLE, needsYouCount, nextAttention, profileBadge, windowGlyph } from "../agent";
import { workingDots } from "../chat/activity";
import { renderMarkdown } from "../chat/markdown";
import { badgesShown } from "../display";
import { markdownPath } from "../file-links";
import { isArchived, visualOrder } from "../groups";
import { sessionLabel, tabLabel } from "../labels";
import { openMenu } from "../popover";
import { createScreen, createWaitingCard } from "./card";
import { isImagePath, linkedPath, MAX_ATTACHMENTS, sentFiles, thumbnails, uploadFile, type Attachment } from "./attach";
import { SAFE_LINK } from "../live-markdown";
import {
  clipAround, composedAs, type Composed, CONV_ERROR, hitShown, linkRows, mergeItems, pageFor, readForShown, sendAs, stepLine, stuckToBottom, workingLine, writtenElsewhere,
} from "./model";

/**
 * One tab's agent as a conversation, for a phone or an iPad: what it said and
 * did, newest at the bottom, and a text box that reaches its prompt (or, while
 * the agent waits on a dialog, the card that answers it). Everything
 * comes from the `conv*` messages; nothing here attaches, selects a window or
 * resizes, so the desk's terminal never changes because the phone looked.
 */

export interface ConversationDeps {
  send(m: ClientMessage): void;
  toast(m: string): void;
  /** A Markdown file an agent linked to, as its `/file?` address: read in the reader, full screen. */
  openFile(path: string): void;
  /** Go to the next workspace waiting on the user, as ⌘J does. */
  nextWaiting(): void;
  /** The tab's note, opened as the desk opens it. */
  openNote(windowId: string): void;
  /** The accounts in the quota panel's order, which picks each account badge's colour (as the tabs get them). */
  profiles(): string[];
}

export interface ConversationView {
  /** Show `windowId` of `session`; the same tab again changes nothing. */
  open(session: string, windowId: string): void;
  close(): void;
  /** True for a conversation message (handled here), false for anything else. */
  onMessage(m: ServerMessage): boolean;
  /** Every `state`: the header's state, badge and Next waiting count. */
  render(sessions: SessionInfo[]): void;
  /**
   * A note's text into the text box of `windowId`'s conversation, after what is
   * there, to be read and sent as any message is. Not done when that tab isn't
   * the one shown, or has no conversation to send to.
   */
  compose(windowId: string, text: string): "composed" | "not-shown" | "nothing-to-send-to";
}

/** How much of a step's input or output is shown behind the tap: the server sends them whole. */
const CLIP = 4000;
/** Scrolled this close to the top, the page before is asked for. */
const NEAR_TOP = 240;
/** How often the header's and the working line's durations are brought up to date. */
const TICK_MS = 15_000;
/** After a page that didn't join what is shown (a failed read), wait this long before asking again. */
const RETRY_MS = 3000;
/** The longest message the server takes (server.ts `isText`): one longer is refused with no `conv-result`. */
const MAX_TEXT = 100_000;
/** A send with no answer by then is given up, so Send comes back whatever happened to it. */
const SEND_GIVE_UP_MS = 15_000;

const DOTS = '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.2"></circle><circle cx="8" cy="8" r="1.2"></circle><circle cx="12" cy="8" r="1.2"></circle></svg>';
/** A paperclip: attach a photo or a file. */
const PAPERCLIP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"></path></svg>';
const PLAY = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3v10l8-5z"></path></svg>';

type Step = Extract<ConvItem, { kind: "step" }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

const clip = (s: string) => clipAround(s, CLIP).text;

/** How long a step took: "8s", "1m12s", "2h05". Blank under a second, or when a time can't be read. */
function took(from: string, to: string): string {
  const secs = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  if (!(secs >= 1)) return "";
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${String(secs % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

/** The header's words for what the agent is doing, with how long where that changes what you do. */
function stateWords(a: AgentInfo | undefined, now: number): string {
  const since = (words: string, at: string | undefined) => {
    const e = formatElapsed(at, now);
    return e ? `${words} · ${e}` : words;
  };
  if (!a) return "";
  if (a.state === "input") return since("Waiting for you", a.waitingSince ?? a.since);
  if (a.state === "running") return since("Working", a.turnStartedAt ?? a.since);
  return "Idle";
}

export function createConversationView(host: HTMLElement, deps: ConversationDeps): ConversationView {
  // ---- what is shown ----
  let session: string | null = null;
  let windowId: string | null = null;
  let sessions: SessionInfo[] = [];
  /** The tab's agent as the last `conv` said: undefined until one comes, null for none. */
  let agent: AgentKind | null | undefined;
  /** What a message is bound to: the `conv`'s conversation. Null: nothing to send to yet. */
  let conversation: string | null = null;
  let items: ConvItem[] = [];
  /** Results whose step is on a page not loaded yet: applied when that page comes. */
  let orphans: StepResult[] = [];
  /** Byte offset of the oldest row shown: an older page is asked for before it. */
  let start = 0;
  /** The `conv-more` out, by its request id: one at a time. */
  let asking: string | null = null;
  let retryAt = 0;
  /** The `conv-around` out (its id) for this item (a search hit for `find`): its page replaces the list instead of joining it. */
  let aroundFor: { req: string; id: string; find: string } | null = null;
  /** The list shows a page found by search, not the newest: new items are not appended, and Back to latest is offered. */
  let detached = false;
  let card: Card | null = null;
  let screen = false;
  let working = false;
  /**
   * A send waiting for its `conv-result`, in the tab shown, the conversation it went to, and the attachments it took:
   * Send stays off, so a double tap pastes once.
   */
  let pending: { req: string; text: string; to: string; files: number[]; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A stop waiting for its `conv-result`. */
  let stopping: string | null = null;
  /** What the text box holds, and the conversation it was written for. */
  let composed: Composed = { text: "", for: null };
  /** What was typed in each tab and not sent, with the conversation it was for: switching tabs keeps it. */
  const typed = new Map<string, Composed>();
  /** The files attached in each tab and not sent yet, uploading or uploaded: switching tabs keeps them. */
  const attachedIn = new Map<string, Attachment[]>();
  let attachSeq = 0;
  /** Send was pressed on words written for the conversation before: the line over the box asks before they go to this one. */
  let confirming = false;
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  // ---- the screen ----
  const head = el("header", "conv-head");
  const state = el("div", "conv-state");
  const stateGlyph = el("span", "glyph none");
  const stateText = el("span", "conv-state-text");
  const badge = el("span", "pbadge");
  badge.hidden = true;
  state.append(stateGlyph, stateText, badge);
  const nextBtn = button("conv-next");
  nextBtn.title = "Go to the next workspace waiting on you";
  const nextCount = el("span", "conv-next-count");
  nextBtn.innerHTML = PLAY;
  nextBtn.append(el("span", "conv-next-label", "Next waiting"), nextCount);
  nextBtn.onclick = () => deps.nextWaiting();
  const menuBtn = button("conv-menu");
  menuBtn.innerHTML = DOTS;
  menuBtn.setAttribute("aria-label", "This conversation: Screen, Links, Search, Note");
  menuBtn.title = "Screen, Links, Search, Note";
  head.append(state, nextBtn, menuBtn);

  const body = el("div", "conv-body");
  const older = button("conv-older");
  const list = el("div", "conv-list");
  const workingEl = el("div", "conv-working");
  workingEl.setAttribute("role", "status");
  const workingText = el("span", "conv-working-text");
  workingEl.append(workingDots(), workingText);
  const empty = el("div", "conv-empty");
  body.append(older, list, workingEl, empty);
  const newBtn = button("conv-new", "New messages ↓");
  newBtn.hidden = true;
  /** The tab's terminal, read-only, over the list: from `⋯`, the card's offer, or in place of a tab with no agent. */
  const screenView = createScreen({ send: (m) => deps.send(m), toast: (m) => deps.toast(m), windowId: () => windowId });
  const backBtn = button("conv-new conv-back", "Back to latest ↓");
  backBtn.hidden = true;

  // Links and Search share one sheet over the list.
  const sheet = el("section", "conv-sheet");
  sheet.hidden = true;
  const sheetBar = el("div", "conv-sheet-bar");
  const sheetTitle = el("div", "conv-sheet-title");
  const sheetClose = button("conv-sheet-btn", "Close");
  sheetBar.append(sheetTitle, sheetClose);
  const linksPane = el("div", "conv-sheet-pane");
  const searchPane = el("div", "conv-sheet-pane");
  const sheetBody = el("div", "conv-sheet-body");
  sheetBody.append(linksPane, searchPane);
  sheet.append(sheetBar, sheetBody);
  const main = el("div", "conv-main");
  main.append(body, newBtn, backBtn, screenView.el, sheet);

  /** Where the text box sits: the waiting card takes its place. */
  const slot = el("div", "conv-slot");
  const draftEl = el("div", "conv-draft");
  draftEl.hidden = true;
  const waiting = createWaitingCard({
    send: (m) => deps.send(m),
    toast: (m) => deps.toast(m),
    target: () => (windowId && conversation ? { windowId, conversation } : null),
    openScreen: () => screenView.open(false),
  });
  /** Over the box while its words were written for the conversation the tab held before (a /clear, a resume at the desk). */
  const boundEl = el("div", "conv-bound");
  boundEl.hidden = true;
  const boundYes = button("conv-bound-yes", "Send it to the new conversation?");
  boundEl.append(el("span", "conv-bound-text", "Written for the previous conversation in this tab."), boundYes);
  const compose = el("div", "conv-compose");
  const input = el("textarea", "conv-input");
  input.rows = 1;
  input.placeholder = "Message";
  // No enterkeyhint "send": on touch Enter makes a new line, and Send is the button.
  input.setAttribute("aria-label", "Message the agent");
  const stopBtn = button("conv-stop", "Stop");
  stopBtn.title = "Interrupt the agent (Esc at the desk)";
  const sendBtn = button("conv-send", "Send");
  const attachBtn = button("conv-attach");
  attachBtn.innerHTML = PAPERCLIP;
  attachBtn.setAttribute("aria-label", "Attach a photo or a file");
  attachBtn.title = "Attach a photo or a file";
  // No `accept`: a phone then offers its photos, its camera and its files.
  const picker = el("input", "conv-picker");
  picker.type = "file";
  picker.multiple = true;
  picker.hidden = true;
  compose.append(attachBtn, input, stopBtn, sendBtn, picker);
  /** The files attached to the next message, over the text box. */
  const tray = el("div", "conv-tray");
  tray.hidden = true;
  slot.append(draftEl, boundEl, waiting.el, tray, compose);
  host.replaceChildren(head, main, slot);

  // ---- the header ----
  const shownSession = (): SessionInfo | undefined =>
    sessions.find((s) => s.name === session) ?? sessions.find((s) => s.windows.some((w) => w.id === windowId));
  const shownWindow = (): WindowInfo | undefined => shownSession()?.windows.find((w) => w.id === windowId);

  function paintHead() {
    const w = shownWindow();
    const g = w ? windowGlyph(w) : "none";
    stateGlyph.className = `glyph ${g}`;
    stateGlyph.textContent = GLYPH[g];
    stateGlyph.title = GLYPH_TITLE[g];
    stateText.textContent = agent === null ? "No agent" : stateWords(w?.agent, Date.now());
    const profile = w?.agent?.profile;
    badge.hidden = !profile || !badgesShown();
    if (profile && !badge.hidden) {
      const b = profileBadge(profile, deps.profiles());
      badge.className = `pbadge${b.slot === null ? "" : ` p${b.slot}`}`;
      badge.textContent = b.initial;
      badge.title = `${b.profile} profile`;
    }
    // Archived workspaces ask for nothing: the sidebar's count, without the one on screen.
    const live = sessions.filter((s) => !isArchived(s, sessionLabel(s)));
    const here = shownSession()?.name ?? session;
    const n = needsYouCount(live.filter((s) => s.name !== here));
    nextCount.textContent = String(n);
    nextCount.hidden = n === 0;
    nextBtn.disabled = nextAttention(visualOrder(live, sessionLabel), here) === null;
    nextBtn.setAttribute("aria-label", n > 0 ? `Next waiting (${n} waiting for you)` : "Next waiting");
  }

  menuBtn.onclick = () => {
    if (!windowId) return;
    const w = shownWindow();
    const s = shownSession();
    openMenu(menuBtn, {
      title: w ? tabLabel(w) : "Conversation",
      sub: s ? sessionLabel(s) : "",
      sections: [
        [
          { action: "screen", label: "Screen", hint: "the terminal, read-only" },
          { action: "links", label: "Links" },
          { action: "search", label: "Search" },
        ],
        [{ action: "note", label: "Note" }],
      ],
    }, (action) => {
      if (action === "screen") showScreen();
      else if (action === "links") showLinks();
      else if (action === "search") showSearch();
      else if (action === "note" && windowId) deps.openNote(windowId);
    });
  };

  function showScreen() {
    // A tab with no agent already shows it: read it again.
    screenView.open(screenView.state() === "fixed");
  }

  // ---- Links and Search ----
  function openSheet(title: string, pane: HTMLElement) {
    sheetTitle.textContent = title;
    linksPane.hidden = pane !== linksPane;
    searchPane.hidden = pane !== searchPane;
    sheet.hidden = false;
  }
  const closeSheet = () => { sheet.hidden = true; };
  sheetClose.onclick = closeSheet;

  /** Copies `text`: the clipboard API where the page may use it, else a hidden text box (plain http has no `navigator.clipboard`). */
  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Refused: try the text box.
    }
    const box = el("textarea");
    box.value = text;
    box.readOnly = true;
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(box);
    box.select();
    box.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }

  const sheetNote = (text: string) => el("div", "conv-sheet-note", text);

  let linksReq: string | null = null;

  function showLinks() {
    if (!windowId) return;
    linksReq = `links-${++seq}`;
    linksPane.replaceChildren(sheetNote("Reading links…"));
    openSheet("Links", linksPane);
    deps.send({ t: "conv-links", req: linksReq, windowId });
  }

  function drawLinks(links: { url: string; pr: boolean }[]) {
    const rows = linkRows(links);
    if (rows.length === 0) {
      linksPane.replaceChildren(sheetNote("No links in this conversation"));
      return;
    }
    linksPane.replaceChildren(...rows.map((r) => {
      const row = el("div", `conv-link${r.pr ? " pr" : ""}`);
      const label = el("div", "conv-link-label", r.label);
      const full = el("div", "conv-link-url", r.url);
      const open = button("conv-sheet-btn", "Open");
      open.onclick = () => {
        // Only a web address leaves for a new tab; the address came from the conversation.
        if (/^https?:\/\//i.test(r.url) && SAFE_LINK.test(r.url)) window.open(r.url, "_blank", "noopener");
        else deps.toast("Not a web address");
      };
      const copy = button("conv-sheet-btn", "Copy");
      copy.onclick = () => { void copyText(r.url).then((ok) => deps.toast(ok ? "Copied" : "Couldn't copy")); };
      const buttons = el("div", "conv-link-buttons");
      buttons.append(open, copy);
      row.append(label, full, buttons);
      return row;
    }));
  }

  const searchForm = el("form", "conv-search-form");
  const searchInput = el("input", "conv-search-input");
  searchInput.type = "search";
  searchInput.placeholder = "Search this conversation";
  searchInput.maxLength = SEARCH_LIMITS.query;
  searchInput.setAttribute("enterkeyhint", "search");
  searchInput.setAttribute("aria-label", "Search this conversation");
  searchInput.autocomplete = "off";
  const searchGo = button("conv-sheet-btn", "Search");
  searchGo.type = "submit";
  searchForm.append(searchInput, searchGo);
  const searchNote = sheetNote("");
  searchNote.hidden = true;
  const searchHits = el("div", "conv-hits");
  const searchMore = button("conv-sheet-btn conv-hits-more", "Older matches");
  searchMore.hidden = true;
  searchPane.append(searchForm, searchNote, searchHits, searchMore);
  /** The search out, and the cursor its older matches continue from. */
  let searchReq: { req: string; more: boolean } | null = null;
  let searchNext: number | undefined;
  let searchedFor = "";

  function showSearch() {
    openSheet("Search", searchPane);
    searchInput.focus();
  }

  function runSearch(more: boolean) {
    const query = more ? searchedFor : searchInput.value.trim();
    if (!windowId || !query) return;
    searchedFor = query;
    const req = `search-${++seq}`;
    searchReq = { req, more };
    searchNote.textContent = "Searching…";
    searchNote.hidden = false;
    searchMore.disabled = true;
    if (!more) {
      searchHits.replaceChildren();
      searchMore.hidden = true;
    }
    deps.send({ t: "conv-search", req, windowId, query, ...(more && searchNext !== undefined ? { cursor: searchNext } : {}) });
  }
  searchForm.onsubmit = (e) => {
    e.preventDefault();
    searchInput.blur();
    runSearch(false);
  };
  searchMore.onclick = () => runSearch(true);

  function drawHits(m: Extract<ServerMessage, { t: "conv-search-result" }>) {
    searchNext = m.next;
    const find = searchedFor;
    searchHits.append(...m.hits.map((h) => {
      const row = button("conv-hit-row", h.snippet);
      row.onclick = () => goTo(h.id, h.offset, find);
      return row;
    }));
    const any = searchHits.childElementCount > 0;
    // A long conversation is searched a stretch at a time: none found yet is not none at all.
    searchNote.textContent = any ? "" : m.next !== undefined ? `No matches for "${searchedFor}" in the latest part` : `No matches for "${searchedFor}"`;
    searchNote.hidden = any;
    searchMore.hidden = m.next === undefined;
    searchMore.disabled = false;
  }

  /**
   * Shows the item a search hit for `find` names: scrolled to if it is on screen with the match, else the page around
   * it replaces the list (a step listed without the result the match is in, too).
   */
  function goTo(id: string, offset: number, find: string) {
    if (!windowId) return;
    closeSheet();
    // A jump tapped while another is out replaces it, one to a hit already on screen too: the earlier one's page, if
    // it comes, is dropped rather than shown over this one.
    aroundFor = null;
    if (hitShown(drawn.get(id)?.item, find)) {
      reveal(id, find);
      return;
    }
    const req = `around-${++seq}`;
    aroundFor = { req, id, find };
    deps.send({ t: "conv-around", req, windowId, offset });
  }

  let hitTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Scrolls item `id` to the middle of the list and marks it for a moment; false when it isn't listed. A step is
   * opened, its input and output shown around `find` (a window of them, for a match past the clip), and the match
   * scrolled to.
   */
  function reveal(id: string, find?: string): boolean {
    const shown = drawn.get(id);
    if (!shown) return false;
    const e = shown.el;
    let target: HTMLElement = e;
    // A step that sent files is drawn with them, its own row first.
    const step = e instanceof HTMLDetailsElement ? e : e.querySelector<HTMLDetailsElement>(":scope > details.conv-step");
    if (find && shown.item.kind === "step" && step) {
      step.querySelector(":scope > .conv-step-body")?.remove();
      step.append(stepBody(shown.item, find));
      step.open = true;
      const match = step.querySelector<HTMLElement>(".conv-match");
      const pre = match?.closest<HTMLElement>(".conv-pre");
      if (match && pre) {
        // The output scrolls in its own box: the match to its middle first.
        pre.scrollTop += match.getBoundingClientRect().top - pre.getBoundingClientRect().top - pre.clientHeight / 2;
        target = pre;
      }
    }
    const room = body.clientHeight - target.offsetHeight;
    body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - Math.max(0, room) / 2;
    list.querySelector(".conv-found")?.classList.remove("conv-found");
    e.classList.add("conv-found");
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => e.classList.remove("conv-found"), 2400);
    return true;
  }

  backBtn.onclick = () => {
    if (!windowId) return;
    backBtn.disabled = true;
    // Opened again for the same tab, the newest page replaces everything shown (a `conv`).
    deps.send({ t: "conv-open", windowId });
  };

  /** Back to the newest page and the live list: a tab switch, a close, or a `conv`. */
  function attached() {
    detached = false;
    aroundFor = null;
    backBtn.hidden = true;
    backBtn.disabled = false;
  }

  function resetSheet() {
    closeSheet();
    linksReq = null;
    searchReq = null;
    searchNext = undefined;
    searchedFor = "";
    searchInput.value = "";
    searchHits.replaceChildren();
    searchNote.hidden = true;
    searchMore.hidden = true;
  }

  // ---- the items ----
  /** A step's input or output: from the start, or around `find` (a search's match), the match marked. Text, never markup. */
  function stepPre(text: string, find?: string): HTMLPreElement {
    const { text: shown, at } = clipAround(text, CLIP, find);
    const pre = el("pre", "conv-pre");
    if (at === undefined || !find) pre.textContent = shown;
    else pre.append(shown.slice(0, at), el("mark", "conv-match", shown.slice(at, at + find.length)), shown.slice(at + find.length));
    return pre;
  }

  function stepBody(it: Step, find?: string): HTMLElement {
    const box = el("div", "conv-step-body");
    // A step listed from its result alone (its call too far back to read) has no input to show.
    if (it.input) box.append(el("div", "conv-step-label", "Input"), stepPre(it.input, find));
    if (it.result) {
      box.append(el("div", "conv-step-label", it.result.ok ? "Output" : "Output · failed"));
      box.append(it.result.output ? stepPre(it.result.output, find) : el("pre", "conv-pre", "(no output)"));
    } else box.append(el("div", "conv-step-label", "No result yet"));
    return box;
  }

  function stepEl(it: Step): HTMLElement {
    const d = el("details", `conv-item conv-step ${it.result ? (it.result.ok ? "ok" : "failed") : "pending"}`);
    const line = el("summary", "conv-step-line");
    line.append(el("span", "conv-step-mark", it.result ? (it.result.ok ? "✓" : "✗") : "·"), el("span", "conv-step-text", stepLine(it)));
    const time = it.result ? took(it.at, it.result.at) : "";
    if (time) line.append(el("span", "conv-step-time", time));
    d.append(line);
    // Built on the first open: a long conversation holds hundreds of steps nobody opens.
    d.addEventListener("toggle", () => { if (d.open && d.childElementCount === 1) d.append(stepBody(it)); });
    return d;
  }

  function itemEl(it: ConvItem): HTMLElement {
    let e: HTMLElement;
    switch (it.kind) {
      case "you":
        e = el("div", "conv-item conv-you");
        if (it.queued) e.append(el("div", "conv-meta", "queued"));
        e.append(el("div", "conv-bubble", it.text));
        break;
      case "peer":
        e = el("div", "conv-item conv-peer");
        e.append(el("div", "conv-meta", `from @${it.from}`), el("div", "conv-bubble", it.text));
        break;
      case "agent": {
        e = el("div", "conv-item conv-agent");
        const b = el("div", "conv-bubble");
        b.append(renderMarkdown(it.text, windowId ?? undefined));
        // The images the reply links to, shown under it: a path on the agent's machine, read through this server.
        const linked = [...b.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => linkedPath(a.getAttribute("href") ?? "") ?? "");
        const thumbs = thumbnails(linked.filter(isImagePath), windowId);
        if (thumbs) b.append(thumbs);
        e.append(b);
        break;
      }
      case "step": {
        const sent = sentFiles(it);
        const thumbs = sent.length > 0 ? thumbnails(sent, windowId) : null;
        if (thumbs) {
          // Files the agent sent the user: the pictures stay in sight, the step under them as any other.
          e = el("div", "conv-item conv-sent");
          e.append(stepEl(it), thumbs);
        } else e = stepEl(it);
        break;
      }
      case "images":
        e = el("div", "conv-item conv-you conv-images");
        e.append(thumbnails(it.paths, windowId) ?? el("div", "conv-meta", `${it.paths.length} image${it.paths.length === 1 ? "" : "s"}`));
        break;
      case "notice":
        e = el("div", "conv-item conv-notice", it.text);
        break;
    }
    e.dataset.id = it.id;
    return e;
  }

  /** What each listed item was drawn from: an item that changed (a step's result came) is drawn again. */
  const drawn = new Map<string, { item: ConvItem; el: HTMLElement }>();

  /** Shows `next`, new items going at the end or the top; returns how many were new. */
  function paintItems(next: ConvItem[], where: "append" | "prepend" | "all"): number {
    if (where === "all") {
      drawn.clear();
      list.replaceChildren();
    }
    const fresh: HTMLElement[] = [];
    for (const it of next) {
      const had = drawn.get(it.id);
      if (!had) {
        const e = itemEl(it);
        drawn.set(it.id, { item: it, el: e });
        fresh.push(e);
      } else if (had.item !== it) {
        const e = itemEl(it);
        if (had.el instanceof HTMLDetailsElement && had.el.open && e instanceof HTMLDetailsElement) e.open = true;
        had.el.replaceWith(e);
        drawn.set(it.id, { item: it, el: e });
      }
    }
    if (where === "prepend") list.prepend(...fresh);
    else list.append(...fresh);
    items = next;
    return fresh.length;
  }

  /** Results still waiting for their step, once `incoming` is merged. */
  function keepOrphans(incoming: (ConvItem | StepResult)[]) {
    const steps = new Set(items.flatMap((i) => (i.kind === "step" ? [i.id] : [])));
    const results = incoming.filter((i): i is StepResult => i.kind === "step-result");
    orphans = [...orphans, ...results].filter((r) => !steps.has(r.id));
  }

  const atEnd = () => stuckToBottom(body.scrollTop, body.scrollHeight, body.clientHeight);
  /** A scroll to the end asked for while the list had no height (a chat over it): done once it has one. */
  let endWhenShown = false;
  const toEnd = () => {
    if (body.clientHeight === 0) endWhenShown = true;
    else body.scrollTop = body.scrollHeight;
  };

  function paintBody() {
    // A tab with no agent shows its Screen in place of all this.
    const none = agent === null;
    list.hidden = none;
    empty.hidden = none || !(agent === undefined || items.length === 0);
    empty.textContent = agent === undefined ? "Loading…" : "Nothing said yet";
    older.hidden = none || agent === undefined || (start === 0 && items.length === 0);
    older.disabled = asking !== null || start === 0;
    older.textContent = asking !== null ? "Loading earlier messages…" : start > 0 ? "Show earlier messages" : "Start of the conversation";
  }

  function paintWorking() {
    const stuck = atEnd();
    const on = working && !!agent && !detached;
    workingEl.hidden = !on;
    if (on) workingText.textContent = workingLine(items, Date.now()) ?? "Working";
    if (stuck && !detached) toEnd();
  }

  /** The page before what is shown, when the reader is near the top or the list doesn't fill the screen. */
  function fill(force = false) {
    if (!windowId || !agent || asking !== null || start <= 0 || Date.now() < retryAt) return;
    // Hidden, everything reads 0 and "near the top": it would page through the whole file.
    if (body.clientHeight === 0) return;
    if (!force && body.scrollTop > NEAR_TOP && body.scrollHeight > body.clientHeight) return;
    asking = `more-${++seq}`;
    paintBody();
    deps.send({ t: "conv-more", req: asking, windowId, before: start });
  }

  body.addEventListener("scroll", () => {
    if (atEnd()) newBtn.hidden = true;
    fill();
  }, { passive: true });
  older.onclick = () => fill(true);
  new ResizeObserver(() => {
    if (body.clientHeight === 0) return;
    if (endWhenShown) {
      endWhenShown = false;
      toEnd();
    }
    fill();
  }).observe(body);
  newBtn.onclick = () => {
    toEnd();
    newBtn.hidden = true;
  };
  // A Markdown file an agent linked to opens in the reader; anything else in a new tab.
  list.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const href = a?.getAttribute("href");
    if (!href || !markdownPath(href)) return;
    e.preventDefault();
    deps.openFile(href);
  });

  // ---- the text box ----
  /** Typed digits would pick options: while a dialog is up, the card stands in for the text box. */
  const asked = () => !!card || screen;

  function paintSlot() {
    // A tab with no agent has nothing to type to: its Screen's keys are the way in.
    slot.hidden = agent === null && !asked();
    compose.hidden = asked() || agent === null;
    input.disabled = !conversation;
    input.placeholder = conversation || agent === undefined ? "Message" : "Nothing to send to yet";
    // A Stop names the conversation it is for; with none to name, only a fresh Codex's "none yet" binds it.
    stopBtn.hidden = !working || asked() || (!conversation && agent !== "codex");
    stopBtn.disabled = stopping !== null;
    const files = attachedNow();
    const uploading = files.some((f) => !f.name);
    sendBtn.disabled = !conversation || pending !== null || uploading || (input.value.trim() === "" && files.length === 0);
    attachBtn.disabled = !conversation || pending !== null || files.length >= MAX_ATTACHMENTS;
    tray.hidden = compose.hidden || files.length === 0;
    const elsewhere = writtenElsewhere(composed, conversation);
    if (!elsewhere) confirming = false;
    boundEl.hidden = !elsewhere || compose.hidden;
    boundYes.hidden = !confirming;
    boundYes.disabled = pending !== null;
  }

  function grow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight + 2, 180)}px`;
  }

  /** Forget the send in flight: answered, given up, or for a tab no longer shown. */
  function dropPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  /**
   * Send pressed: the words go to the conversation they were written for. Written for the one before (the tab
   * now holds another), they wait for the user to say they're for this one.
   */
  function send(text: string) {
    if (!windowId || !conversation || pending || asked()) return;
    // Files alone go to the conversation shown: there are no words written for another.
    if (text.trim() === "") {
      if (attachedNow().length > 0) sendTo(text, conversation);
      return;
    }
    const how = sendAs({ text, for: composed.for }, conversation);
    if (!how) return;
    if ("ask" in how) {
      confirming = true;
      paintSlot();
      return;
    }
    sendTo(text, how.send);
  }

  /**
   * `text` as a message to conversation `to`: the one it was written for, never just whichever the tab shows.
   * `replace`: the desk's draft to clear first, as the server fingerprinted it when it was shown.
   */
  function sendTo(text: string, to: string, replace?: string) {
    const files = attachedNow();
    if (!windowId || pending || asked() || (text.trim() === "" && files.length === 0) || files.some((f) => !f.name)) return;
    if (text.length > MAX_TEXT) {
      deps.toast(`Too long to send: ${text.length} characters, ${MAX_TEXT} at most`);
      return;
    }
    const req = `send-${++seq}`;
    const timer = setTimeout(() => {
      if (pending?.req !== req) return;
      pending = null;
      paintSlot();
    }, SEND_GIVE_UP_MS);
    pending = { req, text, to, files: files.map((f) => f.id), timer };
    draftEl.hidden = true;
    const attachments = files.map((f) => f.name!);
    deps.send({ t: "conv-send", req, windowId, conversation: to, text, ...(replace !== undefined ? { replace } : {}), ...(attachments.length > 0 ? { attachments } : {}) });
    paintSlot();
  }

  boundYes.onclick = () => {
    if (!conversation || !confirming) return;
    // Only now are the words for the conversation the tab holds.
    composed = { ...composed, for: conversation };
    if (windowId) typed.set(windowId, composed);
    confirming = false;
    send(input.value);
  };

  /**
   * The desk's prompt holds text: show it, and let the user replace it or keep it. The words stay for conversation
   * `to`, and Replace clears only this draft (`print`): one changed at the desk since comes back to be shown instead.
   */
  function showDraft(draft: string, text: string, to: string, print: string) {
    const replace = button("conv-draft-replace", "Replace it");
    const cancel = button("conv-draft-cancel", "Cancel");
    replace.onclick = () => sendTo(text, to, print);
    cancel.onclick = () => { draftEl.hidden = true; };
    const buttons = el("div", "conv-draft-buttons");
    buttons.append(replace, cancel);
    // No text: the prompt couldn't be read, and may hold some.
    const said = draft
      ? [el("div", "conv-draft-text", "The desk's prompt already holds this, unsent:"), el("pre", "conv-pre", clip(draft))]
      : [el("div", "conv-draft-text", "The desk's prompt may hold unsent text that can't be read here.")];
    draftEl.replaceChildren(...said, buttons);
    draftEl.hidden = false;
  }

  /** What the text box holds now, typed or put there (a note): kept for the tab, and the buttons painted. */
  function setTyped(text: string) {
    if (input.value !== text) input.value = text;
    composed = composedAs(composed, input.value, conversation);
    if (windowId) typed.set(windowId, composed);
    grow();
    paintSlot();
  }
  input.addEventListener("input", () => setTyped(input.value));

  // ---- attachments ----
  /** The files attached in the tab shown. */
  const attachedNow = (): Attachment[] => (windowId ? attachedIn.get(windowId) ?? [] : []);

  /** `files` as the tab's attachments: kept for the tab, and the tray and buttons painted if it is shown. */
  function setAttached(tab: string, files: Attachment[]) {
    if (files.length > 0) attachedIn.set(tab, files);
    else attachedIn.delete(tab);
    if (tab !== windowId) return;
    paintTray();
    paintSlot();
  }

  function paintTray() {
    tray.replaceChildren(...attachedNow().map((f) => {
      const chip = el("div", `conv-chip${f.name ? "" : " uploading"}`);
      const shown = f.image && f.path ? thumbnails([f.path])?.firstElementChild : null;
      if (shown) chip.append(shown);
      chip.append(el("span", "conv-chip-name", f.name ? f.label : `Uploading ${f.label}…`));
      const drop = button("conv-chip-drop", "✕");
      drop.setAttribute("aria-label", `Remove ${f.label}`);
      drop.onclick = () => {
        if (windowId) setAttached(windowId, attachedNow().filter((x) => x.id !== f.id));
      };
      chip.append(drop);
      return chip;
    }));
  }

  /** Uploads each file picked, for the tab shown when it was picked: each shows in the tray while it goes. */
  function attach(picked: File[]) {
    const tab = windowId;
    if (!tab) return;
    const room = MAX_ATTACHMENTS - (attachedIn.get(tab)?.length ?? 0);
    if (picked.length > room) deps.toast(`A message takes ${MAX_ATTACHMENTS} files at most`);
    for (const file of picked.slice(0, Math.max(0, room))) {
      const id = ++attachSeq;
      setAttached(tab, [...(attachedIn.get(tab) ?? []), { id, label: file.name || "file", image: file.type.startsWith("image/") }]);
      uploadFile(file).then(
        (up) => {
          // Removed while it uploaded: not attached after all.
          const now = attachedIn.get(tab) ?? [];
          if (now.some((f) => f.id === id)) setAttached(tab, now.map((f) => (f.id === id ? { ...f, ...up } : f)));
        },
        (err: Error) => {
          setAttached(tab, (attachedIn.get(tab) ?? []).filter((f) => f.id !== id));
          deps.toast(err.message);
        },
      );
    }
  }
  attachBtn.onclick = () => picker.click();
  picker.addEventListener("change", () => {
    attach([...(picker.files ?? [])]);
    // The same file picked again is a change too.
    picker.value = "";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    // ⌘ or Ctrl+Enter sends anywhere. A bare Enter sends only without a touch screen: on one it is the only newline key.
    if (e.metaKey || e.ctrlKey || (!e.shiftKey && navigator.maxTouchPoints === 0)) {
      e.preventDefault();
      send(input.value);
    }
  });
  sendBtn.onclick = () => send(input.value);
  stopBtn.onclick = () => {
    if (!windowId || (!conversation && agent !== "codex") || stopping) return;
    stopping = `stop-${++seq}`;
    deps.send({ t: "conv-stop", windowId, conversation, req: stopping });
    paintSlot();
  };

  // ---- messages ----
  function loaded(m: Extract<ServerMessage, { t: "conv" }>) {
    agent = m.agent;
    // A yes asked for under another conversation is no yes for this one, and its search, links and waiting card
    // (with its field and armed state) are not this one's: the new conversation's card follows.
    if (m.conversation !== conversation) {
      confirming = false;
      resetSheet();
      waiting.reset();
      card = null;
      screen = false;
      working = false;
    }
    conversation = m.conversation;
    start = m.start;
    asking = null;
    retryAt = 0;
    orphans = [];
    attached();
    paintItems(mergeItems([], m.items, "append"), "all");
    keepOrphans(m.items);
    // A tab with no agent is its screen; one that has gained an agent is its conversation again.
    if (agent === null) screenView.open(true);
    else if (screenView.state() === "fixed") screenView.close();
    // A draft shown was for the conversation before.
    draftEl.hidden = true;
    newBtn.hidden = true;
    paintHead();
    paintBody();
    paintSlot();
    paintWorking();
    toEnd();
    fill();
  }

  function appended(incoming: (ConvItem | StepResult)[]) {
    const stuck = atEnd();
    const added = paintItems(mergeItems(items, incoming, "append"), "append");
    keepOrphans(incoming);
    paintBody();
    paintWorking();
    if (stuck) toEnd();
    else if (added > 0) newBtn.hidden = false;
  }

  /** The page around a search hit replaces the list; what follows the page is not loaded, so the list stops being live. */
  function around(m: Extract<ServerMessage, { t: "conv-page" }>, want: { id: string; find: string }) {
    // A failed read answers with nothing and 0 to 0: the list stays as it was.
    if (m.items.length === 0 && m.start === 0 && m.end === 0) {
      deps.toast("Couldn't load that part of the conversation");
      return;
    }
    orphans = [];
    asking = null;
    retryAt = 0;
    detached = true;
    paintItems(mergeItems([], m.items, "append"), "all");
    keepOrphans(m.items);
    start = m.start;
    newBtn.hidden = true;
    backBtn.hidden = false;
    paintBody();
    paintWorking();
    if (!reveal(want.id, want.find)) deps.toast("That message is no longer in the conversation");
  }

  function page(m: Extract<ServerMessage, { t: "conv-page" }>) {
    // Each page names the request it answers: one no longer out (a jump replaced by a later tap) is dropped.
    const which = pageFor(m, { more: asking, around: aroundFor?.req ?? null, start });
    if (which === "around") {
      const want = aroundFor!;
      aroundFor = null;
      around(m, want);
      return;
    }
    if (which !== "more") return;
    asking = null;
    // Only the page that ends where the shown items begin; anything else (a failed read) is dropped.
    if (m.end !== start || m.start > start) {
      retryAt = Date.now() + RETRY_MS;
      paintBody();
      return;
    }
    const height = body.scrollHeight;
    const top = body.scrollTop;
    const incoming = [...m.items, ...orphans];
    paintItems(mergeItems(items, incoming, "prepend"), "prepend");
    orphans = [];
    keepOrphans(incoming);
    start = m.start;
    // The rows read stay where they were (iOS Safari has no scroll anchoring).
    body.scrollTop = top + (body.scrollHeight - height);
    paintBody();
    fill();
  }

  function result(m: Extract<ServerMessage, { t: "conv-result" }>) {
    if (pending && m.req === pending.req) {
      const sent = pending;
      dropPending();
      if (m.ok) {
        if (input.value === sent.text) setTyped("");
        if (windowId) setAttached(windowId, attachedNow().filter((f) => !sent.files.includes(f.id)));
      } else if (m.draft !== undefined) showDraft(m.draft, sent.text, sent.to, m.draftFingerprint ?? "unknown");
      else if (m.error) deps.toast(CONV_ERROR[m.error]);
      // Neither: the action threw, and an `error` message says why.
      paintSlot();
    } else if (stopping !== null && m.req === stopping) {
      stopping = null;
      if (!m.ok && m.error) deps.toast(CONV_ERROR[m.error]);
      paintSlot();
    }
  }

  function onMessage(m: ServerMessage): boolean {
    switch (m.t) {
      case "conv":
        if (m.windowId === windowId) loaded(m);
        return true;
      case "conv-items":
        if (m.windowId === windowId && agent && !detached) appended(m.items);
        return true;
      case "conv-page":
        // Read for a conversation no longer shown (a /clear meanwhile): dropped, as the `conv` for the new one resets the list.
        if (readForShown(m, { windowId, conversation }) && agent) page(m);
        return true;
      case "conv-card":
        // Read for the conversation shown: one for the conversation before (or after: its `conv` comes first) is dropped.
        if (readForShown(m, { windowId, conversation })) {
          // The card is taller than the text box it replaces: a reader at the end stays there.
          const stuck = atEnd();
          card = m.card;
          screen = m.screen;
          working = m.working;
          waiting.show(card, screen, agent, m.conversation);
          // A dialog is up: the desk's draft and its Replace are for later.
          if (asked()) draftEl.hidden = true;
          paintSlot();
          paintWorking();
          if (stuck && !detached) toEnd();
        }
        return true;
      case "conv-result":
        if (!waiting.result(m)) result(m);
        return true;
      case "conv-screen-result":
        screenView.result(m);
        return true;
      case "conv-search-result":
        if (searchReq?.req === m.req && readForShown(m, { windowId, conversation })) {
          searchReq = null;
          drawHits(m);
        }
        return true;
      case "conv-links-result":
        if (linksReq === m.req && readForShown(m, { windowId, conversation })) {
          linksReq = null;
          drawLinks(m.links);
        }
        return true;
      default:
        return false;
    }
  }

  return {
    open(nextSession, nextWindow) {
      if (nextWindow === windowId) {
        session = nextSession;
        paintHead();
        return;
      }
      session = nextSession;
      windowId = nextWindow;
      agent = undefined;
      conversation = null;
      items = [];
      orphans = [];
      start = 0;
      asking = null;
      retryAt = 0;
      attached();
      resetSheet();
      card = null;
      screen = false;
      working = false;
      stopping = null;
      dropPending();
      waiting.reset();
      screenView.close();
      drawn.clear();
      list.replaceChildren();
      draftEl.hidden = true;
      newBtn.hidden = true;
      composed = typed.get(nextWindow) ?? { text: "", for: null };
      input.value = composed.text;
      confirming = false;
      paintTray();
      grow();
      paintHead();
      paintBody();
      paintSlot();
      paintWorking();
      clearInterval(timer);
      timer = setInterval(() => { paintHead(); paintWorking(); }, TICK_MS);
      deps.send({ t: "conv-open", windowId: nextWindow });
    },
    close() {
      if (windowId) deps.send({ t: "conv-close" });
      clearInterval(timer);
      timer = undefined;
      session = windowId = null;
      agent = undefined;
      conversation = null;
      items = [];
      orphans = [];
      dropPending();
      stopping = null;
      attached();
      resetSheet();
      waiting.reset();
      screenView.close();
      drawn.clear();
      list.replaceChildren();
    },
    onMessage,
    render(next) {
      sessions = next;
      if (windowId) paintHead();
    },
    compose(target, text) {
      if (target !== windowId || agent === undefined) return "not-shown";
      if (!agent || !conversation) return "nothing-to-send-to";
      setTyped(input.value.trim() === "" ? text : `${input.value.replace(/\s+$/, "")}\n${text}`);
      return "composed";
    },
  };
}
