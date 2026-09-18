import type { HTMLBundle, ServerWebSocket } from "bun";
import type { ClientMessage, DetachReason, ServerMessage } from "../shared/protocol";
import type { CmuxMirror } from "./cmux";
import { attachSession, type PtyHandle } from "./pty";
import { Tmux } from "./tmux";

export interface ServerOptions {
  host: string;
  port: number;
  socketName?: string;
  /** tmux `-S` socket path; takes precedence over `socketName`. */
  socketPath?: string;
  pollMs?: number;
  index?: HTMLBundle;
  /** Optional cmux parity: mirror browser-created sessions as cmux workspaces. */
  mirror?: CmuxMirror;
}

export interface RunningServer {
  port: number;
  stop(): void;
}

interface ConnData {
  pty: PtyHandle | null;
  session: string | null;
  cols: number;
  rows: number;
}

type Socket = ServerWebSocket<ConnData>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createServer(opts: ServerOptions): RunningServer {
  const tmux = new Tmux(opts.socketName, opts.socketPath);
  const clients = new Set<Socket>();
  let lastState = "";

  function send(ws: Socket, m: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.sendText(JSON.stringify(m));
  }

  /** Re-read tmux state; broadcast only when it changed since the last broadcast. */
  async function poll(): Promise<void> {
    const sessions = await tmux.listSessions().catch(() => []);
    const json = JSON.stringify({ t: "state", sessions } satisfies ServerMessage);
    if (json === lastState) return;
    lastState = json;
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.sendText(json);
  }

  function detach(ws: Socket) {
    const pty = ws.data.pty;
    ws.data.pty = null;
    ws.data.session = null;
    pty?.kill();
  }

  function attach(ws: Socket, session: string) {
    if (ws.data.session === session && ws.data.pty && !ws.data.pty.exited) return;
    detach(ws);
    const handle: PtyHandle = attachSession({
      session,
      socketName: opts.socketName,
      socketPath: opts.socketPath,
      cols: ws.data.cols,
      rows: ws.data.rows,
      onData: (d) => {
        if (ws.readyState === WebSocket.OPEN) ws.sendBinary(encoder.encode(d));
      },
      onExit: () => {
        // Ignore exits from a client we already replaced or dropped.
        if (ws.data.pty !== handle) return;
        ws.data.pty = null;
        ws.data.session = null;
        void tmux
          .hasSession(session)
          .catch(() => true)
          .then((alive) => {
            const reason: DetachReason = alive ? "exited" : "session-killed";
            send(ws, { t: "detached", reason });
            void poll();
          });
      },
    });
    ws.data.pty = handle;
    ws.data.session = session;
    send(ws, { t: "attached", session });
    void poll();
  }

  /** Run a cmux mirror step; a failure is a toast, never a failure of the tmux command itself. */
  async function mirrorStep(ws: Socket, step: (m: CmuxMirror) => Promise<void>): Promise<void> {
    if (!opts.mirror) return;
    try {
      await step(opts.mirror);
    } catch (e) {
      send(ws, { t: "error", message: `cmux: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function handleControl(ws: Socket, text: string): Promise<void> {
    let m: ClientMessage;
    try {
      m = JSON.parse(text);
    } catch {
      return send(ws, { t: "error", message: "invalid JSON" });
    }
    try {
      switch (m.t) {
        case "ping":
          return;
        case "attach":
          return attach(ws, m.session);
        case "resize": {
          const ok =
            Number.isInteger(m.cols) &&
            Number.isInteger(m.rows) &&
            m.cols > 0 &&
            m.rows > 0 &&
            m.cols <= 1000 &&
            m.rows <= 1000;
          if (!ok) return send(ws, { t: "error", message: "invalid resize" });
          ws.data.cols = m.cols;
          ws.data.rows = m.rows;
          ws.data.pty?.resize(m.cols, m.rows);
          return;
        }
        case "new-session":
          await tmux.newSession(m.name);
          await mirrorStep(ws, (mirror) => mirror.sessionCreated(m.name));
          break;
        case "kill-session":
          await tmux.killSession(m.session);
          await mirrorStep(ws, (mirror) => mirror.sessionKilled(m.session));
          break;
        case "new-window":
          await tmux.newWindow(m.session);
          break;
        case "kill-window":
          await tmux.killWindow(m.session, m.index);
          break;
        case "select-window":
          await tmux.selectWindow(m.session, m.index);
          break;
        case "rename-session":
          await tmux.renameSession(m.session, m.name);
          await mirrorStep(ws, (mirror) => mirror.sessionRenamed(m.session, m.name));
          break;
        case "rename-window":
          await tmux.renameWindow(m.session, m.index, m.name);
          break;
        default:
          return send(ws, { t: "error", message: `unknown message type: ${String((m as { t?: unknown }).t)}` });
      }
      await poll();
    } catch (e) {
      send(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const timer = setInterval(() => void poll(), opts.pollMs ?? 2000);

  const server = Bun.serve<ConnData>({
    hostname: opts.host,
    port: opts.port,
    routes: opts.index ? { "/": opts.index } : {},
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        // WebSocket handshakes are not subject to the browser's same-origin
        // policy, so any page open in the user's browser could otherwise
        // connect and send keystrokes. This is a same-origin check, not
        // authentication.
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        let sameOrigin = false;
        try {
          sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) return new Response("Forbidden: cross-origin WebSocket", { status: 403 });
        const ok = srv.upgrade(req, { data: { pty: null, session: null, cols: 80, rows: 24 } });
        return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        clients.add(ws);
        void tmux.listSessions().catch(() => []).then((sessions) => {
          const json = JSON.stringify({ t: "state", sessions } satisfies ServerMessage);
          if (json !== lastState) {
            lastState = json;
            for (const other of clients) if (other !== ws && other.readyState === WebSocket.OPEN) other.sendText(json);
          }
          if (ws.readyState === WebSocket.OPEN) ws.sendText(json);
        });
      },
      message(ws, msg) {
        if (typeof msg === "string") void handleControl(ws, msg);
        else ws.data.pty?.write(decoder.decode(msg));
      },
      close(ws) {
        clients.delete(ws);
        detach(ws);
      },
    },
  });

  return {
    port: server.port ?? opts.port,
    stop() {
      clearInterval(timer);
      for (const ws of clients) detach(ws);
      server.stop(true);
    },
  };
}
