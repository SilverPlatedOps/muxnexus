// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { Card, ConvError, ConvItem, StepResult } from "../../shared/conversation";
import type { AgentInfo, ClientMessage, ServerMessage, SessionInfo, WindowInfo } from "../../shared/protocol";
import { formatElapsed, GLYPH, GLYPH_TITLE, needsYouCount, nextAttention, profileBadge, windowGlyph } from "../agent";
import { workingDots } from "../chat/activity";
import { renderMarkdown } from "../chat/markdown";
import { badgesShown } from "../display";
import { markdownPath } from "../file-links";
import { isArchived, visualOrder } from "../groups";
import { sessionLabel, tabLabel } from "../labels";
import { openMenu } from "../popover";
import { mergeItems, stuckToBottom, workingLine } from "./model";

/**
 * One tab's agent as a conversation, for a phone or an iPad: what it said and
 * did, newest at the bottom, and a text box that reaches its prompt. Everything
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
}

/** Each refusal in a sentence the user can act on. */
export const CONV_ERROR: Record<ConvError, string> = {
  "another-conversation": "This tab now holds another conversation",
  "prompt-changed": "This prompt changed: refresh",
  waiting: "The agent is waiting on a prompt: answer it first",
  "no-agent": "No agent in this tab",
  working: "The agent is busy; try Replace once it's idle",
};

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

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}\n… ${s.length - CLIP} more characters` : s);

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
  /** A `conv-more` is out: one at a time. */
  let asking = false;
  let retryAt = 0;
  let card: Card | null = null;
  let screen = false;
  let working = false;
  /** A send waiting for its `conv-result`, in the tab shown: Send stays off, so a double tap pastes once. */
  let pending: { req: string; text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** A stop waiting for its `conv-result`. */
  let stopping: string | null = null;
  /** What was typed in each tab and not sent: switching tabs keeps it. */
  const typed = new Map<string, string>();
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
  const main = el("div", "conv-main");
  main.append(body, newBtn);

  /** Where the text box sits: the waiting card takes its place. */
  const slot = el("div", "conv-slot");
  const draftEl = el("div", "conv-draft");
  draftEl.hidden = true;
  const locked = el("div", "conv-locked");
  locked.hidden = true;
  const compose = el("div", "conv-compose");
  const input = el("textarea", "conv-input");
  input.rows = 1;
  input.placeholder = "Message";
  input.setAttribute("enterkeyhint", "send");
  input.setAttribute("aria-label", "Message the agent");
  const stopBtn = button("conv-stop", "Stop");
  stopBtn.title = "Interrupt the agent (Esc at the desk)";
  const sendBtn = button("conv-send", "Send");
  compose.append(input, stopBtn, sendBtn);
  slot.append(draftEl, locked, compose);
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

  // Screen, Links and Search: the waiting card's and search's work (their own sheets).
  function showScreen() { deps.toast("Screen isn't available yet"); }
  function showLinks() { deps.toast("Links aren't available yet"); }
  function showSearch() { deps.toast("Search isn't available yet"); }

  // ---- the items ----
  function stepBody(it: Step): HTMLElement {
    const box = el("div", "conv-step-body");
    box.append(el("div", "conv-step-label", "Input"), el("pre", "conv-pre", clip(it.input)));
    if (it.result) box.append(el("div", "conv-step-label", it.result.ok ? "Output" : "Output · failed"), el("pre", "conv-pre", clip(it.result.output) || "(no output)"));
    else box.append(el("div", "conv-step-label", "No result yet"));
    return box;
  }

  function stepEl(it: Step): HTMLElement {
    const d = el("details", `conv-item conv-step ${it.result ? (it.result.ok ? "ok" : "failed") : "pending"}`);
    const line = el("summary", "conv-step-line");
    line.append(el("span", "conv-step-mark", it.result ? (it.result.ok ? "✓" : "✗") : "·"), el("span", "conv-step-text", it.summary));
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
        e.append(b);
        break;
      }
      case "step":
        e = stepEl(it);
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
    const none = agent === null;
    list.hidden = none;
    empty.hidden = !(none || agent === undefined || items.length === 0);
    empty.textContent = none ? "No agent in this tab" : agent === undefined ? "Loading…" : "Nothing said yet";
    older.hidden = none || agent === undefined || (start === 0 && items.length === 0);
    older.disabled = asking || start === 0;
    older.textContent = asking ? "Loading earlier messages…" : start > 0 ? "Show earlier messages" : "Start of the conversation";
  }

  function paintWorking() {
    const stuck = atEnd();
    const on = working && !!agent;
    workingEl.hidden = !on;
    if (on) workingText.textContent = workingLine(items, Date.now()) ?? "Working";
    if (stuck) toEnd();
  }

  /** The page before what is shown, when the reader is near the top or the list doesn't fill the screen. */
  function fill(force = false) {
    if (!windowId || !agent || asking || start <= 0 || Date.now() < retryAt) return;
    // Hidden, everything reads 0 and "near the top": it would page through the whole file.
    if (body.clientHeight === 0) return;
    if (!force && body.scrollTop > NEAR_TOP && body.scrollHeight > body.clientHeight) return;
    asking = true;
    paintBody();
    deps.send({ t: "conv-more", windowId, before: start });
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
  function paintSlot() {
    const asked = !!card || screen;
    locked.hidden = !asked;
    locked.textContent = card ? "The agent is asking you something at the desk" : "The agent is waiting on something only its screen shows";
    compose.hidden = asked || agent === null;
    input.disabled = !conversation;
    input.placeholder = conversation || agent === undefined ? "Message" : "Nothing to send to yet";
    stopBtn.hidden = !working || asked;
    stopBtn.disabled = stopping !== null;
    sendBtn.disabled = !conversation || pending !== null || input.value.trim() === "";
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

  function send(text: string, replace = false) {
    if (!windowId || !conversation || pending || text.trim() === "") return;
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
    pending = { req, text, timer };
    draftEl.hidden = true;
    deps.send({ t: "conv-send", req, windowId, conversation, text, ...(replace ? { replace: true } : {}) });
    paintSlot();
  }

  /** The desk's prompt holds text: show it, and let the user replace it or keep it. */
  function showDraft(draft: string, text: string) {
    const replace = button("conv-draft-replace", "Replace it");
    const cancel = button("conv-draft-cancel", "Cancel");
    replace.onclick = () => send(text, true);
    cancel.onclick = () => { draftEl.hidden = true; };
    const buttons = el("div", "conv-draft-buttons");
    buttons.append(replace, cancel);
    draftEl.replaceChildren(el("div", "conv-draft-text", "The desk's prompt already holds this, unsent:"), el("pre", "conv-pre", clip(draft) || " "), buttons);
    draftEl.hidden = false;
  }

  input.addEventListener("input", () => {
    if (windowId) typed.set(windowId, input.value);
    grow();
    paintSlot();
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
    if (!windowId || stopping) return;
    stopping = `stop-${++seq}`;
    deps.send({ t: "conv-stop", windowId, req: stopping });
    paintSlot();
  };

  // ---- messages ----
  function loaded(m: Extract<ServerMessage, { t: "conv" }>) {
    agent = m.agent;
    conversation = m.conversation;
    start = m.start;
    asking = false;
    retryAt = 0;
    orphans = [];
    paintItems(mergeItems([], m.items, "append"), "all");
    keepOrphans(m.items);
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

  function page(m: Extract<ServerMessage, { t: "conv-page" }>) {
    asking = false;
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
        if (windowId && typed.get(windowId) === sent.text) typed.delete(windowId);
        if (input.value === sent.text) {
          input.value = "";
          grow();
        }
      } else if (m.draft !== undefined) showDraft(m.draft, sent.text);
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
        if (m.windowId === windowId && agent) appended(m.items);
        return true;
      case "conv-page":
        if (m.windowId === windowId && agent) page(m);
        return true;
      case "conv-card":
        if (m.windowId === windowId) {
          card = m.card;
          screen = m.screen;
          working = m.working;
          paintSlot();
          paintWorking();
        }
        return true;
      case "conv-result":
        result(m);
        return true;
      case "conv-search-result":
      case "conv-links-result":
      case "conv-screen-result":
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
      asking = false;
      retryAt = 0;
      card = null;
      screen = false;
      working = false;
      stopping = null;
      dropPending();
      drawn.clear();
      list.replaceChildren();
      draftEl.hidden = true;
      newBtn.hidden = true;
      input.value = typed.get(nextWindow) ?? "";
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
      drawn.clear();
      list.replaceChildren();
    },
    onMessage,
    render(next) {
      sessions = next;
      if (windowId) paintHead();
    },
  };
}
