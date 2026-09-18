import type { HTMLBundle, ServerWebSocket } from "bun";
import type { ClientMessage, DetachReason, ServerMessage } from "../shared/protocol";
import { attachSession, type PtyHandle } from "./pty";
import { Tmux } from "./tmux";

export interface ServerOptions {
  host: string;
  port: number;
  socketName?: string;
  pollMs?: number;
  index?: HTMLBundle;
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
  const tmux = new Tmux(opts.socketName);
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
    detach(ws);
    const handle: PtyHandle = attachSession({
      session,
      socketName: opts.socketName,
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
          .then((alive) => alive)
          .catch(() => false)
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
        case "resize":
          ws.data.cols = m.cols;
          ws.data.rows = m.rows;
          ws.data.pty?.resize(m.cols, m.rows);
          return;
        case "new-session":
          await tmux.newSession(m.name);
          break;
        case "kill-session":
          await tmux.killSession(m.session);
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
        const ok = srv.upgrade(req, { data: { pty: null, session: null, cols: 80, rows: 24 } });
        return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        clients.add(ws);
        void tmux.listSessions().catch(() => []).then((sessions) => send(ws, { t: "state", sessions }));
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
