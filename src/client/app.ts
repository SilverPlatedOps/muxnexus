import { createSidebar } from "./sidebar";
import { Connection } from "./socket";
import { createTerminal } from "./terminal";
import type { SessionInfo } from "../shared/protocol";

const SESSION_KEY = "cmux-viewer.session";

const banner = document.getElementById("banner")!;
const layout = document.getElementById("layout")!;
const sidebarEl = document.getElementById("sidebar")!;
const emptyEl = document.getElementById("empty")!;
const termEl = document.getElementById("terminal")!;

let desired: string | null = localStorage.getItem(SESSION_KEY);
let current: string | null = null;
let sessions: SessionInfo[] = [];

const term = createTerminal(termEl, {
  onInput: (d) => conn.sendInput(d),
  onResize: (cols, rows) => conn.send({ t: "resize", cols, rows }),
});

function showTerminal(on: boolean) {
  termEl.hidden = !on;
  emptyEl.hidden = on;
  if (on) {
    term.fit();
    term.focus();
  }
}

function attach(session: string) {
  desired = session;
  localStorage.setItem(SESSION_KEY, session);
  conn.send({ t: "resize", cols: term.cols, rows: term.rows });
  conn.send({ t: "attach", session });
}

const sidebar = createSidebar(sidebarEl, layout, {
  attach,
  selectWindow: (session, index) => conn.send({ t: "select-window", session, index }),
  newSession: (name) => conn.send({ t: "new-session", name }),
  newWindow: (session) => conn.send({ t: "new-window", session }),
  killSession: (session) => conn.send({ t: "kill-session", session }),
  killWindow: (session, index) => conn.send({ t: "kill-window", session, index }),
  renameSession: (session, name) => conn.send({ t: "rename-session", session, name }),
  renameWindow: (session, index, name) => conn.send({ t: "rename-window", session, index, name }),
});

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

const conn = new Connection(wsUrl, {
  onOpen() {
    banner.hidden = true;
    conn.send({ t: "resize", cols: term.cols, rows: term.rows });
    if (desired) conn.send({ t: "attach", session: desired });
  },
  onClose() {
    banner.hidden = false;
  },
  onMessage(m) {
    switch (m.t) {
      case "state":
        sessions = m.sessions;
        sidebar.render(sessions, current);
        break;
      case "attached":
        current = m.session;
        term.reset();
        showTerminal(true);
        sidebar.render(sessions, current);
        break;
      case "detached":
        current = null;
        desired = null;
        localStorage.removeItem(SESSION_KEY);
        showTerminal(false);
        sidebar.render(sessions, current);
        break;
      case "error":
        sidebar.toast(m.message);
        break;
    }
  },
  onOutput: (b) => term.write(b),
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.key === "b") {
    e.preventDefault();
    sidebar.toggle();
    term.fit();
  }
});

conn.connect();
