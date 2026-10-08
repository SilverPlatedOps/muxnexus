import { createSidebar, sessionLabel } from "./sidebar";
import { visualOrder } from "./groups";
import { splitCategory } from "../shared/category";
import { createTabs } from "./tabs";
import { openMove, targets } from "./move";
import { Connection } from "./socket";
import { createTerminal } from "./terminal";
import { createSplit } from "./split";
import { createNotes } from "./notes";
import { makeResizable } from "./resize";
import { windowPlace } from "./labels";
import { applyPendingOrder, orderSatisfied } from "./reorder";
import { badgedLabels, renderUsage } from "./usage";
import { openDisplay } from "./display";
import { GLYPH, GLYPH_TITLE, needsYouCount, nextAttention, sessionGlyph } from "./agent";
import type { SessionInfo, UsageSource, WindowInfo } from "../shared/protocol";

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
const displayBtn = document.getElementById("display")!;
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
  onScroll: (lines) => conn.send({ t: "scroll", lines }),
  onSearch: (s) => { if (!findEl.hidden) paintFind(s); },
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
  // While the main socket is reconnecting `current` is null for a moment; the
  // session it is re-attaching to is `desired`, and the split should outlive that.
  split.render(sessions, current ?? desired);
  notes.sync();
  updateChip();
  updateAttention();
}

// ---- find in scrollback ----

function paintFind(s: { total: number; index: number }) {
  findCount.textContent = findInput.value === "" ? "" : s.total === 0 ? "0" : s.index ? `${s.index}/${s.total}` : `${s.total}`;
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
  openWindow,
}, footEl, document.getElementById("side-search-input") as HTMLInputElement);

/** The last quota snapshot, so the account picker can list the same rows the panel shows. */
let usageSources: UsageSource[] = [];
/** Claude's accounts in the panel's order, which is also the picker's order. */
let profileLabels: string[] = [];

const tabs = createTabs(tabsEl, {
  // The beside pane's tab is already on screen: clicking it goes there rather
  // than pulling its window into the main pane as well.
  selectWindow: (id) => {
    if (split.state?.windowId === id) return split.focusSide();
    if (current) conn.send({ t: "select-window", session: current, id });
  },
  newWindow: (agent) => { if (current) conn.send({ t: "new-window", session: current, ...(agent ? { agent } : {}) }); },
  renameWindow: (id, name) => { if (current) conn.send({ t: "rename-window", session: current, id, name }); },
  killWindow: (id) => { if (current) conn.send({ t: "kill-window", session: current, id }); },
  reorderWindows,
  moveWindow: (id) => {
    const win = sessions.find((s) => s.name === current)?.windows.find((w) => w.id === id);
    if (!win?.conversation) return;
    openMove(
      document.body,
      win,
      win.conversation,
      targets(usageSources, profileLabels, win.agent?.profile),
      { moveTo: (wid, profile) => { if (current) conn.send({ t: "move-window-to", session: current, id: wid, profile }); } },
      Date.now(),
    );
  },
  openNote: (id) => {
    if (!current) return;
    if (split.state?.windowId === id) {
      split.focusSide();
      notePane = "side";
    } else {
      notePane = "main";
      if (!currentWindows().find((w) => w.id === id)?.active) conn.send({ t: "select-window", session: current, id });
    }
    notes.show("window");
  },
  openBeside: (id) => {
    if (!current) return;
    if (onPhone()) return sidebar.toast("Split needs a wider screen");
    split.open(current, id, split.state?.side ?? "right");
  },
  dragOut: {
    over: (id, x, y) => split.over(id, x, y),
    leave: () => split.leave(),
    drop: (id, x, y) => split.drop(id, x, y),
  },
});

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const split = createSplit({
  shell: document.getElementById("term-shell")!,
  mainPane: document.getElementById("pane-main")!,
  sidePane: document.getElementById("pane-side")!,
  sideTerm: document.getElementById("terminal-side")!,
  divider: document.getElementById("divider")!,
}, {
  wsUrl,
  enabled: () => !onPhone(),
  selectMain: (id) => { if (current) conn.send({ t: "select-window", session: current, id }); },
  focusMain: () => term.focus(),
  toast: (m) => sidebar.toast(m),
  changed: () => tabs.setBeside(split.state?.windowId ?? null),
});

const currentWindows = (): WindowInfo[] => sessions.find((s) => s.name === current)?.windows ?? [];

/**
 * The terminal pane the note belongs to: the one that last had the keys.
 * Focus moving into the note itself is not a move, so it is not listened for.
 */
let notePane: "main" | "side" = "main";
document.getElementById("pane-main")!.addEventListener("focusin", () => { notePane = "main"; notes.sync(); });
document.getElementById("pane-side")!.addEventListener("focusin", () => { notePane = "side"; notes.sync(); });

const notesPanel = document.getElementById("notes-panel")!;
const notes = createNotes({
  layout,
  panel: notesPanel,
  button: document.getElementById("note-btn")!,
  tabWindow: document.getElementById("notes-tab-window")!,
  tabAll: document.getElementById("notes-tab-all")!,
  close: document.getElementById("notes-close")!,
  windowView: document.getElementById("notes-window")!,
  heading: document.getElementById("note-heading")!,
  text: document.getElementById("note-text")!,
  allView: document.getElementById("notes-all")!,
}, {
  send: (m) => conn.send(m),
  session: () => current,
  owner: () => notesOwner(),
  ownerPlace: () => {
    const s = sessions.find((x) => x.name === current);
    const w = notesOwner();
    return s && w ? windowPlace(s, w) : "";
  },
  phone: onPhone,
  focusTerminal: () => term.focus(),
  toast: (m) => sidebar.toast(m),
  goTo: ({ session, windowId }) => {
    openWindow(session, windowId);
    notes.show("window");
  },
});

function notesOwner(): WindowInfo | undefined {
  const ws = currentWindows();
  const side = split.state?.windowId;
  if (notePane === "side" && side) return ws.find((w) => w.id === side) ?? ws.find((w) => w.active);
  return ws.find((w) => w.active);
}

makeResizable({
  grip: document.getElementById("sidebar-grip")!, panel: document.getElementById("sidebar")!, host: layout,
  cssVar: "--sidebar", storageKey: "muxnexus.sidebar-width", min: 240, max: 480, fallback: 280, edge: "right",
});
makeResizable({
  grip: document.getElementById("notes-grip")!, panel: notesPanel, host: layout,
  cssVar: "--notes", storageKey: "muxnexus.notes-width", min: 260, max: 640, fallback: 380, edge: "left",
});

/** Show a window: its session attached, the window selected in the main pane. */
function openWindow(session: string, id: string) {
  conn.send({ t: "select-window", session, id });
  notePane = "main";
  if (session !== current) attach(session);
  else if (onPhone()) setDrawer(false);
}

const conn = new Connection(wsUrl, {
  onOpen() {
    hideReconnect();
    notes.reconnected();
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
        // Kept, not just rendered: the "Move to..." picker lists the same
        // accounts with the same bars, and it opens between usage updates.
        usageSources = m.sources;
        renderUsage(usageEl, m.sources);
        // Claude's accounts, in the panel's order: the only places a
        // conversation can be moved to. Codex's tabs still wear its badge.
        profileLabels = m.sources.filter((s) => s.provider === "claude").map((s) => s.label);
        tabs.setProfiles(badgedLabels(m.sources));
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
      case "note":
        notes.receive(m);
        break;
      case "notes":
        notes.list(m.notes);
        break;
      case "note-deleted":
        notes.deleted(m.noteId);
        break;
      case "notice":
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
// The badges are worn by the tabs and legended by the quota panel; the checkout
// mark by the tabs and the sidebar. A switch redraws all of them.
displayBtn.onclick = () => openDisplay(document.body, () => {
  paintAll();
  renderUsage(usageEl, usageSources);
});
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
  // Typing a draft or a search must not search the terminal or leave the session.
  const inNote = e.target instanceof Element && e.target.closest("#notes-panel, #side-search") !== null;
  if (e.shiftKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    if (onPhone()) setDrawer(false);
    notes.show("all");
  } else if (e.shiftKey && (e.key === "e" || e.key === "E")) {
    if (wrapEl.hidden) return;
    e.preventDefault();
    if (notes.open && notes.tab === "window") notes.toggle();
    else notes.show("window");
  } else if (e.key === "k") {
    e.preventDefault();
    if (onPhone()) setDrawer(true);
    sidebar.focusSearch();
    term.fit();
  } else if (inNote) {
    return;
  } else if (e.key === "b") {
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
