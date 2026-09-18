import { Connection } from "./socket";
import { createTerminal } from "./terminal";

const SESSION_KEY = "cmux-viewer.session";

const banner = document.getElementById("banner")!;
const emptyEl = document.getElementById("empty")!;
const termEl = document.getElementById("terminal")!;

let desired: string | null = localStorage.getItem(SESSION_KEY);

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
      case "attached":
        term.reset();
        showTerminal(true);
        break;
      case "detached":
        desired = null;
        localStorage.removeItem(SESSION_KEY);
        showTerminal(false);
        break;
      case "state":
      case "error":
        break; // sidebar handles these from Task 7 on
    }
  },
  onOutput: (b) => term.write(b),
});

conn.connect();
