import { createSidebar } from "./sidebar";
import { Connection } from "./socket";
import { createTerminal } from "./terminal";
import type { SessionInfo } from "../shared/protocol";

const SESSION_KEY = "muxnexus.session";
const PHONE = "(max-width: 720px)";

const layout = document.getElementById("layout")!;
const overlay = document.getElementById("overlay")!;
const sessionsEl = document.getElementById("sessions")!;
const footEl = document.getElementById("side-foot")!;
const topbar = document.getElementById("topbar")!;
const crumbSession = document.getElementById("crumb-session")!;
const crumbWindow = document.getElementById("crumb-window")!;
const connDot = document.getElementById("conn")!;
const statusEl = document.getElementById("status")!;
const statusText = document.getElementById("status-text")!;
const retryBtn = document.getElementById("retry")!;
const emptyEl = document.getElementById("empty")!;
const emptyNew = document.getElementById("empty-new")!;
const wrapEl = document.getElementById("wrap")!;
const termEl = document.getElementById("terminal")!;
const collapseBtn = document.getElementById("collapse")!;
const hamburger = document.getElementById("hamburger")!;
const drawerClose = document.getElementById("drawer-close")!;

let desired: string | null = localStorage.getItem(SESSION_KEY);
let current: string | null = null;
let sessions: SessionInfo[] = [];
let countdown: ReturnType<typeof setInterval> | undefined;

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
  if (on) {
    term.fit();
    term.focus();
  }
}

/** Session and active window in the top bar; the sidebar shows everything else. */
function updateCrumb() {
  crumbSession.textContent = current ?? "";
  const active = sessions.find((s) => s.name === current)?.windows.find((w) => w.active);
  crumbWindow.textContent = active ? `${active.index}: ${active.name}` : "";
}

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
  selectWindow: (session, index) => conn.send({ t: "select-window", session, index }),
  newSession: (name) => conn.send({ t: "new-session", name }),
  newWindow: (session) => conn.send({ t: "new-window", session }),
  killSession: (session) => conn.send({ t: "kill-session", session }),
  killWindow: (session, index) => conn.send({ t: "kill-window", session, index }),
  renameSession: (session, name) => conn.send({ t: "rename-session", session, name }),
  renameWindow: (session, index, name) => conn.send({ t: "rename-window", session, index, name }),
}, footEl);

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
      case "state":
        sessions = m.sessions;
        sidebar.render(sessions, current);
        updateCrumb();
        break;
      case "attached":
        current = m.session;
        term.reset();
        showTerminal(true);
        sidebar.render(sessions, current);
        updateCrumb();
        break;
      case "detached":
        current = null;
        desired = null;
        localStorage.removeItem(SESSION_KEY);
        showTerminal(false);
        sidebar.render(sessions, current);
        updateCrumb();
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
hamburger.onclick = () => setDrawer(true);
drawerClose.onclick = () => setDrawer(false);
overlay.onclick = () => setDrawer(false);
emptyNew.onclick = () => {
  if (onPhone()) setDrawer(true);
  sidebar.startNewSession();
};
retryBtn.onclick = () => conn.retryNow();

document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "b") {
    e.preventDefault();
    sidebar.toggle();
    term.fit();
  }
});

conn.connect();
