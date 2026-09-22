import type { HTMLBundle, ServerWebSocket } from "bun";
import type { ClientMessage, DetachReason, ServerMessage, SessionInfo } from "../shared/protocol";
import type { CmuxMirror } from "./cmux";
import { attachSession, type PtyHandle } from "./pty";
import { Tmux } from "./tmux";

export interface ServerOptions {
  /** Addresses to listen on, all sharing one port. The first is the one reported. */
  hosts: string[];
  port: number;
  socketName?: string;
  /** tmux `-S` socket path; takes precedence over `socketName`. */
  socketPath?: string;
  pollMs?: number;
  index?: HTMLBundle;
  /** Optional cmux parity: mirror browser-created sessions as cmux workspaces. */
  mirror?: CmuxMirror;
  /** Extra names this server answers to, beyond `host` and loopback (`--allow-host`). */
  allowHosts?: string[];
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
  attachSeq: number;
}

type Socket = ServerWebSocket<ConnData>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The name part of a Host header or a configured address: lowercased, port
 * removed, IPv6 unbracketed. A bare IPv6 address has no port to strip -- only
 * the bracketed form may carry one.
 */
function hostOnly(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  const first = v.indexOf(":");
  if (first === -1) return v;
  if (v.indexOf(":", first + 1) !== -1) return v; // bare IPv6
  return v.slice(0, first);
}

/** Every name this server answers to: what it is bound to, loopback, and `--allow-host`. */
export function allowedHostList(hosts: readonly string[], extra: readonly string[] = []): string[] {
  return [...hosts, "localhost", "127.0.0.1", "::1", ...extra];
}

/**
 * Whether a request's Host header names this server.
 *
 * Bun's dev server does this check itself, but it accepts only the address the
 * server is bound to -- never the MagicDNS name a phone actually types -- so we
 * turn it off (`development.hmr`) and do our own. It is not authentication: it
 * is the DNS-rebinding guard that check was providing. Comparing Origin to Host
 * cannot replace it, because an attacker serving from their own domain on this
 * port controls both headers and they agree.
 */
export function hostAllowed(host: string | null, allowed: readonly string[]): boolean {
  if (host === null) return false;
  const name = hostOnly(host);
  if (name === "") return false;
  return allowed.some((a) => hostOnly(a) === name);
}

export function createServer(opts: ServerOptions): RunningServer {
  const tmux = new Tmux(opts.socketName, opts.socketPath);
  const clients = new Set<Socket>();
  const allowedHosts = allowedHostList(opts.hosts, opts.allowHosts ?? []);
  let lastState = "";

  function send(ws: Socket, m: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.sendText(JSON.stringify(m));
  }

  /**
   * Show each session under its cmux workspace's current title, so renaming a
   * workspace is reflected straight away instead of waiting for a new tab. A
   * stamped session whose workspace is gone is marked: it still runs, but
   * nothing in cmux corresponds to it any more.
   */
  async function label(sessions: SessionInfo[]): Promise<SessionInfo[]> {
    const mirror = opts.mirror;
    const known = sessions.some((s) => s.workspaceId || s.windows.some((w) => w.surfaceId));
    if (!mirror || !known) return sessions;
    const [titles, tabs] = await Promise.all([
      mirror.workspaceTitles().catch(() => new Map<string, string>()),
      mirror.surfaceTitles().catch(() => new Map<string, string>()),
    ]);
    if (titles.size === 0 && tabs.size === 0) return sessions; // cmux unreachable
    return sessions.map((s) => {
      const windows = s.windows.map((w) => {
        const tab = w.surfaceId ? tabs.get(w.surfaceId) : undefined;
        return tab ? { ...w, label: tab } : w;
      });
      if (!s.workspaceId) return { ...s, windows };
      const title = titles.get(s.workspaceId);
      return title ? { ...s, windows, label: title } : { ...s, windows, orphan: true };
    });
  }

  /** Re-read tmux state; broadcast only when it changed since the last broadcast. */
  async function poll(): Promise<void> {
    const sessions = await label(await tmux.listSessions().catch(() => []));
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

  async function attach(ws: Socket, session: string) {
    if (ws.data.session === session && ws.data.pty && !ws.data.pty.exited) return;
    const seq = ++ws.data.attachSeq;
    let target: string;
    try {
      target = await tmux.target(session);
    } catch (e) {
      return send(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
    }
    // a newer attach superseded this one, or the socket closed while resolving
    if (seq !== ws.data.attachSeq || !clients.has(ws)) return;
    detach(ws);
    const handle: PtyHandle = attachSession({
      session: target,
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
    ws.data.session = session; // the sidebar name, not the tmux target
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
          await attach(ws, m.session);
          return;
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

  const serveOn = (hostname: string, port: number) => Bun.serve<ConnData>({
    hostname,
    port,
    // Bun's dev server refuses any Host header that is not the bound address,
    // which is every name you reach this machine by over Tailscale. Turning HMR
    // off turns that check off with it; `hostAllowed` below replaces it. Nothing
    // is lost -- `bun run dev` reloads by restarting the process (`--watch`).
    development: { hmr: false },
    routes: opts.index ? { "/": opts.index } : {},
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws") {
        // WebSocket handshakes are not subject to the browser's same-origin
        // policy, so any page open in the user's browser could otherwise
        // connect and send keystrokes. Neither check is authentication: the
        // first stops another origin's page, the second stops a rebound name
        // pointed at this machine.
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        let sameOrigin = false;
        try {
          sameOrigin = origin !== null && host !== null && new URL(origin).host === host;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) return new Response("Forbidden: cross-origin WebSocket", { status: 403 });
        if (!hostAllowed(host, allowedHosts)) {
          console.warn(`refused a WebSocket for Host "${host}"; pass --allow-host ${hostOnly(host ?? "")} to allow it`);
          return new Response("Forbidden: unrecognised Host", { status: 403 });
        }
        const ok = srv.upgrade(req, { data: { pty: null, session: null, cols: 80, rows: 24, attachSeq: 0 } });
        return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        clients.add(ws);
        void tmux.listSessions().catch(() => []).then(label).then((sessions) => {
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
        ws.data.attachSeq++; // invalidate any in-flight attach for this socket
        detach(ws);
      },
    },
  });

  // One listener per address rather than a wildcard bind: a wildcard would also
  // answer on whatever network the laptop joins next. The first listener settles
  // the port (`port: 0` picks one), and the rest join it.
  const servers = [serveOn(opts.hosts[0], opts.port)];
  const port = servers[0].port ?? opts.port;
  try {
    for (const h of opts.hosts.slice(1)) servers.push(serveOn(h, port));
  } catch (e) {
    for (const s of servers) s.stop(true);
    throw e;
  }

  return {
    port,
    stop() {
      clearInterval(timer);
      for (const ws of clients) {
        ws.data.attachSeq++; // invalidate any in-flight attach
        detach(ws);
      }
      clients.clear();
      for (const s of servers) s.stop(true);
    },
  };
}
