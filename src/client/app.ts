import { createSidebar, sessionLabel } from "./sidebar";
import { visualOrder } from "./groups";
import { splitCategory } from "../shared/category";
import { createTabs } from "./tabs";
import { Connection } from "./socket";
import { createTerminal } from "./terminal";
import { applyPendingOrder, orderSatisfied } from "./reorder";
import { renderUsage } from "./usage";
import { GLYPH, GLYPH_TITLE, needsYouCount, nextAttention, sessionGlyph } from "./agent";
import type { SessionInfo } from "../shared/protocol";

const SESSION_KEY = "muxnexus.session";
const PHONE = "(max-width: 720px)";

const layout = document.getElementById("layout")!;
const overlay = document.getElementById("overlay")!;
const sessionsEl = document.getElementById("sessions")!;
const footEl = document.getElementById("side-foot")!;
const usageEl = document.getElementById("usage")!;
const topbar = document.getElementById("topbar")!;
const chipDot = document.getElementById("chip-dot")!;
const chipName = document.getElementById("chip-name")!;
const connDot = document.getElementById("conn")!;
const statusEl = document.getElementById("status")!;
const statusText = document.getElementById("status-text")!;
const retryBtn = document.getElementById("retry")!;
const emptyEl = document.getElementById("empty")!;
const emptyNew = document.getElementById("empty-new")!;
const wrapEl = document.getElementById("wrap")!;
const tabsEl = document.getElementById("tabs")!;
const termEl = document.getElementById("terminal")!;
const collapseBtn = document.getElementById("collapse")!;
const expandBtn = document.getElementById("expand")!;
const hamburger = document.getElementById("hamburger")!;
const drawerClose = document.getElementById("drawer-close")!;
const findEl = document.getElementById("find")!;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count")!;
const findPrevBtn = document.getElementById("find-prev")!;
const findNextBtn = document.getElementById("find-next")!;
const findCloseBtn = document.getElementById("find-close")!;

let desired: string | null = localStorage.getItem(SESSION_KEY);
let current: string | null = null;
let sessions: SessionInfo[] = [];
let countdown: ReturnType<typeof setInterval> | undefined;
/** The order the user just dragged into, held until the server confirms it. */
let pendingOrder: string[] | null = null;
let pendingUntil = 0;
/**
 * Same idea for the tab strip. Keyed by tmux window id, not index: the server
 * reorders with swap-window, which moves windows between indices, so the order
 * we asked for would never look satisfied if we compared positions.
 */
let pendingTabs: { session: string; ids: string[] } | null = null;
let pendingTabsUntil = 0;
const PENDING_MS = 5000;
const winKey = (w: { id: string }) => w.id;

const term = createTerminal(termEl, {
  onInput: (d) => conn.sendInput(d),
  onResize: (cols, rows) => conn.send({ t: "resize", cols, rows }),
});

function onPhone(): boolean {
  return window.matchMedia(PHONE).matches;
}

function setDrawer(open: boolean) {
  layout.classList.toggle("drawer-open", open);
  overlay.hidden = !open;
}

function showTerminal(on: boolean) {
  wrapEl.hidden = !on;
  topbar.hidden = !on;
  emptyEl.hidden = on;
  if (!on) closeFind();
  if (on) {
    term.fit();
    term.focus();
  }
}

/** The attached session, as one chip. Its windows are the tab strip. */
function updateChip() {
  const session = sessions.find((s) => s.name === current);
  // The whole name, tag included: the sidebar row drops the tag under its
  // group's header, and up here there is no header to carry it.
  const label = session ? sessionLabel(session) : current ?? "";
  const cat = splitCategory(label);
  if (cat && cat.rest !== cat.category) {
    const tag = document.createElement("span");
    tag.className = "chip-tag";
    tag.textContent = `[${cat.category}] `;
    chipName.replaceChildren(tag, cat.rest);
  } else {
    chipName.textContent = label;
  }
  // The chip says only that the session you are looking at is waiting on you.
  // Its other states are already on the tabs right under it, and with the
  // drawer closed the hamburger's count covers every other session; the red is
  // kept here because a tab that needs you can be scrolled out of the strip.
  const glyph = session ? sessionGlyph(session.windows) : "none";
  chipDot.hidden = glyph !== "input";
  chipDot.className = `glyph ${glyph}`;
  chipDot.textContent = GLYPH[glyph];
  chipDot.title = GLYPH_TITLE[glyph];
}

/**
 * How many sessions are blocked, on the hamburger. With the drawer closed --
 * most of the time on a phone -- this is the only thing on screen that can say
 * something elsewhere needs you.
 */
function updateAttention() {
  const n = needsYouCount(sessions);
  hamburger.dataset.count = n > 0 ? String(n) : "";
  hamburger.setAttribute(
    "aria-label",
    n > 0 ? `Show sessions (${n} waiting for you)` : "Show sessions",
  );
}

/**
 * Move the rows now and tell the server after. The server answers in tens of
 * milliseconds -- it re-polls straight after writing -- but a `state` already in
 * flight when the drag ended still carries the old order, and applying it would
 * snap the list back for a frame. So the wanted order is held until a `state`
 * agrees with it, or until PENDING_MS passes and the server's truth wins.
 */
function reorderSessions(names: string[]) {
  pendingOrder = names;
  pendingUntil = Date.now() + PENDING_MS;
  sessions = applyPendingOrder(sessions, names);
  paintAll();
  conn.send({ t: "reorder-sessions", names });
}

function reorderWindows(ids: string[]) {
  if (!current) return;
  pendingTabs = { session: current, ids };
  pendingTabsUntil = Date.now() + PENDING_MS;
  sessions = withTabOrder(sessions);
  paintAll();
  conn.send({ t: "reorder-windows", session: current, ids });
}

/** The pending tab order applied to whichever session it was made for. */
function withTabOrder(list: SessionInfo[]): SessionInfo[] {
  const p = pendingTabs;
  if (!p) return list;
  return list.map((s) => (s.name === p.session ? { ...s, windows: applyPendingOrder(s.windows, p.ids, winKey) } : s));
}

function paintAll() {
  sidebar.render(sessions, current);
  tabs.render(sessions, current);
  updateChip();
  updateAttention();
}

// ---- find in scrollback ----

function paintFind(s: { total: number; index: number }) {
  findCount.textContent = findInput.value === "" ? "" : s.total === 0 ? "0" : `${s.index}/${s.total}`;
  findCount.classList.toggle("none", findInput.value !== "" && s.total === 0);
}

function openFind() {
  findEl.hidden = false;
  findInput.focus();
  findInput.select();
  paintFind(term.search(findInput.value));
}

function closeFind() {
  if (findEl.hidden) return;
  findEl.hidden = true;
  term.clearSearch();
  term.focus();
}

// ---- connection status ----

function showReconnect(nextMs: number) {
  connDot.classList.add("down");
  connDot.title = "Reconnecting";
  statusEl.hidden = false;
  let left = Math.max(1, Math.round(nextMs / 1000));
  const paint = () => { statusText.textContent = `Reconnecting · ${left}s`; };
  paint();
  clearInterval(countdown);
  countdown = setInterval(() => {
    left = Math.max(0, left - 1);
    paint();
  }, 1000);
}

function hideReconnect() {
  clearInterval(countdown);
  connDot.classList.remove("down");
  connDot.title = "Connected";
  statusEl.hidden = true;
}

function attach(session: string) {
  desired = session;
  localStorage.setItem(SESSION_KEY, session);
  if (onPhone()) setDrawer(false);
  if (session === current) return;
  showTerminal(true);
  conn.send({ t: "resize", cols: term.cols, rows: term.rows });
  conn.send({ t: "attach", session });
}

const sidebar = createSidebar(sessionsEl, layout, {
  attach,
  newSession: (name) => conn.send({ t: "new-session", name }),
  killSession: (session) => conn.send({ t: "kill-session", session }),
  renameSession: (session, name) => conn.send({ t: "rename-session", session, name }),
  reorderSessions,
}, footEl);

const tabs = createTabs(tabsEl, {
  selectWindow: (id) => { if (current) conn.send({ t: "select-window", session: current, id }); },
  newWindow: () => { if (current) conn.send({ t: "new-window", session: current }); },
  renameWindow: (id, name) => { if (current) conn.send({ t: "rename-window", session: current, id, name }); },
  killWindow: (id) => { if (current) conn.send({ t: "kill-window", session: current, id }); },
  reorderWindows,
});

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const conn = new Connection(wsUrl, {
  onOpen() {
    hideReconnect();
    if (desired) attach(desired);
    else conn.send({ t: "resize", cols: term.cols, rows: term.rows });
  },
  onClose(nextDelayMs) {
    showReconnect(nextDelayMs);
    // The server-side attachment is gone with the socket; clear `current` so
    // the reconnect's onOpen re-sends `attach` instead of treating it as a
    // same-session no-op (attach()'s current === session guard).
    current = null;
  },
  onMessage(m) {
    switch (m.t) {
      case "state": {
        if (pendingOrder && (orderSatisfied(m.sessions, pendingOrder) || Date.now() > pendingUntil)) {
          pendingOrder = null;
        }
        const p = pendingTabs;
        if (p) {
          const live = m.sessions.find((s) => s.name === p.session);
          if (!live || orderSatisfied(live.windows, p.ids, winKey) || Date.now() > pendingTabsUntil) {
            pendingTabs = null;
          }
        }
        sessions = withTabOrder(applyPendingOrder(m.sessions, pendingOrder));
        paintAll();
        break;
      }
      case "usage":
        // The badge switch lives in the panel; the tabs wear the badges.
        renderUsage(usageEl, m.sources, Date.now(), () => tabs.render(sessions, current));
        // Claude's accounts, in the panel's order; opencode is not one.
        tabs.setProfiles(m.sources.filter((s) => s.id !== "opencode").map((s) => s.label));
        break;
      case "attached":
        current = m.session;
        term.reset();
        showTerminal(true);
        paintAll();
        break;
      case "renamed":
        // Same terminal, new name: follow it without re-attaching, which would
        // reset the screen for nothing.
        if (desired === current) {
          desired = m.session;
          localStorage.setItem(SESSION_KEY, m.session);
        }
        current = m.session;
        paintAll();
        break;
      case "detached":
        current = null;
        desired = null;
        localStorage.removeItem(SESSION_KEY);
        showTerminal(false);
        paintAll();
        break;
      case "error":
        sidebar.toast(m.message);
        break;
    }
  },
  onOutput: (b) => term.write(b),
});

collapseBtn.onclick = () => {
  sidebar.toggle();
  term.fit();
};
expandBtn.onclick = () => {
  sidebar.toggle();
  term.fit();
};
hamburger.onclick = () => setDrawer(true);
drawerClose.onclick = () => setDrawer(false);
overlay.onclick = () => setDrawer(false);
emptyNew.onclick = () => {
  if (onPhone()) setDrawer(true);
  sidebar.startNewSession();
};
retryBtn.onclick = () => conn.retryNow();

findInput.oninput = () => paintFind(term.search(findInput.value));
findInput.onkeydown = (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); paintFind(e.shiftKey ? term.findPrev() : term.findNext()); }
  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
};
findPrevBtn.onclick = () => paintFind(term.findPrev());
findNextBtn.onclick = () => paintFind(term.findNext());
findCloseBtn.onclick = () => closeFind();

// Every running arc turns in step: each is pinned to the page's clock as it
// starts. The tabs are rebuilt on every state push, which with agents running
// is often, and left alone each rebuild restarted its arcs from the top.
document.addEventListener("animationstart", (e) => {
  if (e.animationName !== "spin") return;
  for (const a of (e.target as Element).getAnimations({ subtree: true })) {
    if (a instanceof CSSAnimation && a.animationName === "spin") a.startTime = 0;
  }
});

document.addEventListener("keydown", (e) => {
  if (!e.metaKey) return;
  if (e.key === "b") {
    e.preventDefault();
    sidebar.toggle();
    term.fit();
  } else if (e.key === "f" && !wrapEl.hidden) {
    e.preventDefault();
    openFind();
  } else if (e.key === "j" || (e.shiftKey && e.key === "J")) {
    // Jump to whatever wants you next. ⌘⇧J as well, in case iPad Safari keeps
    // ⌘J for itself -- it costs one clause and saves finding out the hard way.
    // In the order the sidebar draws, so ⌘J walks down the list you can see.
    const next = nextAttention(visualOrder(sessions, sessionLabel), current);
    if (!next) return;
    e.preventDefault();
    attach(next);
  }
});

conn.connect();
