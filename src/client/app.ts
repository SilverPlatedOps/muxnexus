import { createSidebar, sessionLabel } from "./sidebar";
import { visualOrder } from "./groups";
import { createTabs } from "./tabs";
import { openMove, targets } from "./move";
import { Connection } from "./socket";
import { createTerminal } from "./terminal";
import { createSplit } from "./split";
import { markdownPath } from "./file-links";
import { createNotes } from "./notes";
import { makeResizable } from "./resize";
import { crumb, tabLabel } from "./labels";
import { applyPendingOrder, orderSatisfied } from "./reorder";
import { badgedLabels, renderUsage } from "./usage";
import { marksShown, openDisplay, setSystemShown, systemShown } from "./display";
import { createSystemPanel, setSystemCollapsed, systemCollapsed } from "./system";
import { createDockerPanel, loadTab, type OverviewTab, saveTab } from "./docker";
import { GLYPH, GLYPH_TITLE, needsYouCount, nextAttention, sessionGlyph } from "./agent";
import type { SessionInfo, UsageSource, WindowInfo } from "../shared/protocol";
import { createFolded } from "./folded";
import { buildWorld, nextWaiting, type World } from "./world";
import { diffWorlds } from "./transitions";
import { sessionName, type WorldActions } from "./world-actions";
import { createViewHost } from "./view-host";
import { createDebugView } from "./views/debug";

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
const nextBtn = document.getElementById("next-waiting") as HTMLButtonElement;
const nextCount = document.getElementById("next-count")!;
const drawerClose = document.getElementById("drawer-close")!;
const findEl = document.getElementById("find")!;
const findInput = document.getElementById("find-input") as HTMLInputElement;
const findCount = document.getElementById("find-count")!;
const findPrevBtn = document.getElementById("find-prev")!;
const findNextBtn = document.getElementById("find-next")!;
const findCloseBtn = document.getElementById("find-close")!;
const viewEl = document.getElementById("view")!;
const viewToggle = document.getElementById("view-toggle")!;

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
/** The tmux server the last state came from; a change means its ids were handed out again. */
let tmuxServer: string | null = null;
/** The last world views were given, so the next one can be told apart from it. */
let world: World | null = null;
/** Whether a session is attached and the terminal is what the main area would show. */
let terminalOn = false;
const folded = createFolded();
const winKey = (w: { id: string }) => w.id;

const mainWindowId = () => sessions.find((s) => s.name === current)?.windows.find((w) => w.active)?.id;
const term = createTerminal(termEl, {
  windowId: mainWindowId,
  onInput: (d) => conn.sendInput(d),
  onResize: (cols, rows) => conn.send({ t: "resize", cols, rows }),
  onScroll: (lines) => conn.send({ t: "scroll", lines }),
  onSearch: (s) => { if (!findEl.hidden) paintFind(s); },
  // A plan an agent linked to is read beside it, with its note alongside.
  onLink: (target) => {
    const from = mainWindowId();
    if (!current || !from || !markdownPath(target)) return false;
    split.openFile(current, { target, from }, split.state?.side ?? "right");
    return true;
  },
});

function onPhone(): boolean {
  return window.matchMedia(PHONE).matches;
}

function setDrawer(open: boolean) {
  layout.classList.toggle("drawer-open", open);
  overlay.hidden = !open;
}

function showTerminal(on: boolean) {
  terminalOn = on;
  if (!on) closeFind();
  paintMain();
  if (on && !views.showing()) {
    term.fit();
    term.focus();
  }
}

/** What the main area shows: a view while one is up, else the terminal or the empty prompt. */
function paintMain() {
  const viewing = views.showing();
  wrapEl.hidden = viewing || !terminalOn;
  emptyEl.hidden = viewing || terminalOn;
  topbar.hidden = !(viewing || terminalOn);
  viewToggle.hidden = views.chosen() === "terminal";
  viewToggle.setAttribute("aria-pressed", String(viewing));
  // Nothing typed may reach tmux while a view is up: xterm takes keys only while focused.
  const active = document.activeElement;
  if (viewing && active instanceof HTMLElement && wrapEl.contains(active)) active.blur();
}

/** The view came or went: back on the terminal, it gets the room and the keys again. */
function viewChanged() {
  paintMain();
  updateAttention(); // ⌘J goes to a window in a view, a session out of one
  if (views.showing() || !terminalOn) return;
  term.fit();
  // Not from behind a modal: the Display modal is one way a view goes away,
  // and the Esc that closes it would reach the agent and interrupt its turn.
  if (!document.querySelector(".modal-back")) term.focus();
}

/** The attached session, as one chip. Its windows are the tab strip. */
function updateChip() {
  const session = sessions.find((s) => s.name === current);
  // The whole name, tag included: the sidebar row drops the tag under its
  // group's header, and up here there is no header to carry it.
  chipName.replaceChildren(...crumb(session ? sessionLabel(session) : current ?? ""));
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
  // Live whenever ⌘J would go somewhere, counted only when someone elsewhere
  // is blocked: the one on screen says so on its own chip.
  const elsewhere = needsYouCount(sessions.filter((s) => s.name !== current));
  const next = nextJump();
  nextBtn.disabled = !next || next.here;
  nextCount.hidden = elsewhere === 0;
  nextCount.textContent = String(elsewhere);
}

/**
 * Where ⌘J and "Next waiting" go: the next session that wants you, in the order
 * the sidebar draws, so it walks down the list you can see -- or, while a view
 * is up, the window there. Null when nothing wants you, so neither moves you
 * somewhere arbitrary. `here` when that is the session on screen, which comes
 * round last: ⌘J still takes the key, the button has nowhere to go.
 */
function nextJump(): { go(): void; here: boolean } | null {
  if (views.showing()) {
    const ref = nextWaiting(sessions, current);
    return ref ? { go: () => views.reveal(ref), here: false } : null;
  }
  const next = nextAttention(visualOrder(sessions, sessionLabel), current);
  return next ? { go: () => attach(next), here: next === current } : null;
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
  rebuildWorld();
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
}, footEl, document.getElementById("side-search-input") as HTMLInputElement, folded);

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
    return s && w ? { session: sessionLabel(s), window: tabLabel(w) } : null;
  },
  phone: onPhone,
  focusTerminal: () => term.focus(),
  toast: (m) => sidebar.toast(m),
  goTo: ({ session, windowId }) => {
    openWindow(session, windowId);
    notes.show("window");
  },
  opened: () => syncSystem(),
});

const systemEl = document.getElementById("system")!;
const systemBody = document.getElementById("system-body")!;
const system = createSystemPanel(systemBody, document.getElementById("system-summary")!);
const systemToggle = document.getElementById("system-toggle")!;
/** One line, or the figures and the apps: this browser's choice. */
let systemFolded = systemCollapsed();
function paintSystemToggle() {
  systemEl.classList.toggle("collapsed", systemFolded);
  systemToggle.setAttribute("aria-expanded", String(!systemFolded));
  systemToggle.title = systemFolded ? "Show the figures and the apps" : "Collapse to one line";
}
paintSystemToggle();
systemToggle.onclick = () => {
  systemFolded = !systemFolded;
  setSystemCollapsed(systemFolded);
  paintSystemToggle();
  syncSystem();
};
/** What this socket was last told about the overview: the server reads the machine only while it is on. */
let systemSent = false;
systemEl.hidden = !(notes.open && systemShown());
const dockerBody = document.getElementById("docker-body")!;
const docker = createDockerPanel(dockerBody);
const overviewTabs = { system: document.getElementById("system-tab-system")!, docker: document.getElementById("system-tab-docker")! };
let overviewTab = loadTab();
/** Likewise for the Docker tab, which the server reads only while it is the tab showing. */
let dockerSent = false;

function showOverviewTab() {
  systemBody.hidden = overviewTab !== "system";
  dockerBody.hidden = overviewTab !== "docker";
  for (const [tab, b] of Object.entries(overviewTabs)) {
    b.classList.toggle("on", tab === overviewTab);
    b.setAttribute("aria-selected", String(tab === overviewTab));
  }
}
showOverviewTab();
for (const [tab, b] of Object.entries(overviewTabs)) {
  b.onclick = () => {
    overviewTab = tab as OverviewTab;
    saveTab(overviewTab);
    showOverviewTab();
    syncSystem();
  };
}

// The System tab keeps reading behind the Docker one, so its CPU line still
// has its last minute when you come back to it.
function syncSystem() {
  const on = notes.open && systemShown();
  systemEl.hidden = !on;
  // Docker is read only while its list shows: one line never shows it.
  const dockerOn = on && !systemFolded && overviewTab === "docker";
  if (dockerOn !== dockerSent) {
    if (dockerOn) docker.reset();
    if (conn.send({ t: "docker", on: dockerOn })) dockerSent = dockerOn;
  }
  if (on === systemSent) return;
  if (on) system.reset();
  if (conn.send({ t: "system", on })) systemSent = on;
}
document.getElementById("system-close")!.onclick = () => {
  setSystemShown(false);
  syncSystem();
};

function notesOwner(): WindowInfo | undefined {
  const ws = currentWindows();
  // A file beside is read against the note of the window it was opened from.
  const side = split.state?.windowId ?? split.state?.file.from;
  if (notePane === "side" && side) return ws.find((w) => w.id === side) ?? ws.find((w) => w.active);
  return ws.find((w) => w.active);
}

makeResizable({
  grip: document.getElementById("sidebar-grip")!, panel: document.getElementById("sidebar")!, host: layout,
  cssVar: "--sidebar", storageKey: "muxnexus.sidebar-width", min: 180, max: 480, fallback: 280, edge: "right",
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

/** A session's tmux name now, from the id a world ref carries. */
const nameOf = (id: string) => sessionName(sessions, id);

const worldActions: WorldActions = {
  openWindow(ref) {
    const name = nameOf(ref.session);
    if (!name) return;
    views.show(false);
    openWindow(name, ref.window);
  },
  openNote(ref) {
    const name = nameOf(ref.session);
    if (!name) return;
    views.show(false);
    openWindow(name, ref.window);
    notes.show("window");
  },
  openBeside(ref) {
    const name = nameOf(ref.session);
    if (!name) return;
    if (onPhone()) return sidebar.toast("Split needs a wider screen");
    if (name !== current) return sidebar.toast("A split shows two windows of the open session");
    views.show(false);
    split.open(name, ref.window, split.state?.side ?? "right");
  },
  nextWaiting: () => nextWaiting(sessions, current),
  setFolded: (key, on) => folded.set(key, on),
  newSession: (name) => conn.send({ t: "new-session", name }),
  renameSession(ref, name) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "rename-session", session: s, name });
  },
  killSession(ref) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "kill-session", session: s });
  },
  newWindow(ref, agent) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "new-window", session: s, ...(agent ? { agent } : {}) });
  },
  renameWindow(ref, name) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "rename-window", session: s, id: ref.window, name });
  },
  killWindow(ref) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "kill-window", session: s, id: ref.window });
  },
  moveWindowTo(ref, profile) {
    const s = nameOf(ref.session);
    if (s) conn.send({ t: "move-window-to", session: s, id: ref.window, profile });
  },
};

const views = createViewHost({
  slot: viewEl,
  actions: worldActions,
  views: { debug: createDebugView },
  changed: viewChanged,
});

/**
 * The world every view draws from, rebuilt whenever something in it changes --
 * never on a timer: durations are timestamps, counted by each view's own clock.
 */
function rebuildWorld() {
  const next = buildWorld({
    sessions, tmuxServer, usage: usageSources, folded: folded.keys(), current, marksShown: marksShown(),
  });
  const events = diffWorlds(world, next, Date.now());
  world = next;
  views.update(next, events);
}
// A group folded in the sidebar folds in the view too.
folded.subscribe(rebuildWorld);

const conn = new Connection(wsUrl, {
  onOpen() {
    hideReconnect();
    notes.reconnected();
    // A new socket starts with the overview off on the server's side.
    systemSent = false;
    dockerSent = false;
    syncSystem();
    if (desired) attach(desired);
    else conn.send({ t: "resize", cols: term.cols, rows: term.rows });
  },
  onClose(nextDelayMs) {
    showReconnect(nextDelayMs);
    // The server-side attachment is gone with the socket; clear `current` so
    // the reconnect's onOpen re-sends `attach` instead of treating it as a
    // same-session no-op (attach()'s current === session guard).
    current = null;
    // The reconnect's first state starts afresh: whatever changed while the
    // socket was down is not a transition anyone watched happen.
    world = null;
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
        tmuxServer = m.tmuxServer ?? null;
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
        rebuildWorld();
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
      case "system":
        if (systemSent) system.receive(m.stats);
        break;
      case "docker":
        if (dockerSent) docker.receive(m.stats);
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
nextBtn.onclick = () => {
  nextJump()?.go();
  if (onPhone()) setDrawer(false);
};
drawerClose.onclick = () => setDrawer(false);
// The badges are worn by the tabs and legended by the quota panel; the checkout
// mark by the tabs and the sidebar. A switch redraws all of them.
displayBtn.onclick = () => openDisplay(document.body, () => {
  paintAll();
  renderUsage(usageEl, usageSources);
  syncSystem();
}, { chosen: views.chosen(), choose: (name) => views.choose(name) });
viewToggle.onclick = () => views.show(!views.showing());
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
    const next = nextJump();
    if (!next) return;
    e.preventDefault();
    next.go();
  }
});

// The chosen view is what this browser wants to see first.
if (views.chosen() !== "terminal") views.show(true);

conn.connect();
