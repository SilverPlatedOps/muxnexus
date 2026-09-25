import type { HTMLBundle, ServerWebSocket } from "bun";
import type { ClientMessage, DetachReason, ServerMessage, SessionInfo } from "../shared/protocol";
import { categoryProfile, profileLabel, type UsageReader } from "./usage";
import { splitCategory } from "../shared/category";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /**
   * Optional quota panel. Absent, no timer runs and nothing is read: the tests
   * create servers constantly and must not spawn `security` or reach the network.
   */
  usage?: UsageReader;
  usageMs?: number;
  /**
   * The Claude config dirs on this machine. A session created here whose tag
   * names one (`[Work] ...`) starts with `CLAUDE_CONFIG_DIR` set to it, so
   * `claude` inside it spends that account. Absent, nothing is set: the tests
   * must not depend on which profiles the machine running them has.
   */
  profiles?: () => string[];
}

export interface RunningServer {
  port: number;
  stop(): void;
}

interface ConnData {
  pty: PtyHandle | null;
  session: string | null;
  /** The attached session's id (`$3`): what `session` is re-derived from after a rename. */
  sessionId: string | null;
  /** The last `state` this socket was sent, so each gets every change exactly once. */
  sentState: string | null;
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
  /** The last quota read, so a socket opening between polls is not blank for a minute. */
  let lastUsage: ServerMessage | null = null;

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

  /**
   * Point each attached client at its session's current name. The tmux client in
   * the PTY follows a rename by itself; the name every other command addresses
   * does not, so it is re-derived from the id on every read. Runs before the
   * `state` broadcast, so no client sees a list its own session is missing from.
   */
  function followRenames(sessions: SessionInfo[]) {
    for (const ws of clients) {
      const s = ws.data.sessionId ? sessions.find((x) => x.id === ws.data.sessionId) : undefined;
      if (!s || s.name === ws.data.session) continue;
      ws.data.session = s.name;
      send(ws, { t: "renamed", session: s.name });
    }
  }

  /** Re-read tmux state and send it to each socket that has not seen it yet. */
  async function readState(): Promise<void> {
    const sessions = await label(await tmux.listSessions().catch(() => []));
    followRenames(sessions);
    const json = JSON.stringify({ t: "state", sessions } satisfies ServerMessage);
    for (const ws of clients) {
      if (ws.data.sentState === json || ws.readyState !== WebSocket.OPEN) continue;
      ws.data.sentState = json;
      ws.sendText(json);
    }
  }

  let polling: Promise<void> | null = null;
  let pollAgain: Promise<void> | null = null;

  /**
   * One read at a time. Reads overlapped when cmux was slow, and the older one
   * could finish last and broadcast state from before the newer. A call that
   * arrives mid-read may be reporting a change that read began too early to
   * see, so it gets exactly one more read after it -- shared by every caller
   * that arrives meanwhile.
   */
  function poll(): Promise<void> {
    if (!polling) {
      polling = readState().finally(() => { polling = null; });
      return polling;
    }
    // After the current read however it ended: a failed one must not strand
    // every later caller on a promise that never re-polls.
    pollAgain ??= polling.catch(() => {}).then(() => {
      pollAgain = null;
      return poll();
    });
    return pollAgain;
  }

  function detach(ws: Socket) {
    const pty = ws.data.pty;
    ws.data.pty = null;
    ws.data.session = null;
    ws.data.sessionId = null;
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
      target,
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
        ws.data.sessionId = null;
        // By id: the session may have been renamed while attached.
        void tmux
          .alive(target)
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
    ws.data.sessionId = target;
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
        case "move-window-to": {
          const win = (await tmux.listSessions().catch(() => []))
            .find((x) => x.name === m.session)?.windows.find((w) => w.id === m.id);
          // Refuse rather than guess: without a stamp there is no transcript to
          // resume, and typing a bare `claude` would start an empty session over
          // the one the user meant to carry.
          if (!win?.conversation) break;
          // Mid-turn, "/exit" would be queued as the agent's next prompt rather
          // than quitting it -- the same mistake as typing the resume itself.
          // An idle agent is quit for the user; a busy one is theirs to interrupt.
          if (win.agent && win.agent.state !== "done") break;
          const dirs = opts.profiles ? opts.profiles() : [];
          const target = dirs.find((d) => profileLabel(d) === m.profile) ?? null;
          await tmux.resumeIn(
            m.session,
            m.id,
            target === join(homedir(), ".claude") ? null : target,
            win.conversation.transcriptPath,
            win.agent !== undefined,
          );
          break;
        }
        case "new-session": {
          const cat = splitCategory(m.name);
          const dir = cat && opts.profiles ? categoryProfile(cat.category, opts.profiles(), homedir()) : null;
          await tmux.newSession(m.name, undefined, dir ? { CLAUDE_CONFIG_DIR: dir } : {});
          await mirrorStep(ws, (mirror) => mirror.sessionCreated(m.name));
          break;
        }
        case "kill-session": {
          // The stamp, read before the session and its options are gone: the
          // title lookup would close whichever workspace shares the name.
          const wsId = opts.mirror
            ? (await tmux.listSessions().catch(() => [])).find((x) => x.name === m.session)?.workspaceId
            : undefined;
          await tmux.killSession(m.session);
          await mirrorStep(ws, (mirror) => mirror.sessionKilled(m.session, wsId));
          break;
        }
        case "new-window":
          await tmux.newWindow(m.session);
          break;
        case "kill-window":
          if (typeof m.id !== "string") return send(ws, { t: "error", message: "invalid kill-window" });
          await tmux.killWindow(m.session, m.id);
          break;
        case "select-window":
          if (typeof m.id !== "string") return send(ws, { t: "error", message: "invalid select-window" });
          await tmux.selectWindow(m.session, m.id);
          break;
        case "rename-session": {
          // Grab the stamped workspace id before the rename: cmux's own lookup
          // falls back to matching on the old name, which is precisely wrong
          // once the workspace title and the session name have diverged.
          const wsId = opts.mirror
            ? (await tmux.listSessions().catch(() => [])).find((x) => x.name === m.session)?.workspaceId
            : undefined;
          await tmux.renameSession(m.session, m.name);
          await mirrorStep(ws, (mirror) => mirror.sessionRenamed(m.session, m.name, wsId));
          break;
        }
        case "rename-window":
          if (typeof m.id !== "string") return send(ws, { t: "error", message: "invalid rename-window" });
          await tmux.renameWindow(m.session, m.id, m.name);
          break;
        case "reorder-sessions": {
          if (!Array.isArray(m.names) || m.names.some((n) => typeof n !== "string")) {
            return send(ws, { t: "error", message: "invalid reorder-sessions" });
          }
          await tmux.setSessionOrder(m.names);
          break;
        }
        case "reorder-windows": {
          if (!Array.isArray(m.ids) || m.ids.some((i) => typeof i !== "string")) {
            return send(ws, { t: "error", message: "invalid reorder-windows" });
          }
          await tmux.reorderWindows(m.session, m.ids);
          break;
        }
        default:
          return send(ws, { t: "error", message: `unknown message type: ${String((m as { t?: unknown }).t)}` });
      }
      await poll();
    } catch (e) {
      send(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  const usageMs = opts.usageMs ?? 60_000;
  /** When quota was last asked for, whether or not the answer was good. */
  let usageAskedAt = -Infinity;
  let usageReading: Promise<void> | null = null;
  const usageDue = () => Date.now() - usageAskedAt >= usageMs;

  /**
   * Quota moves slowly, so it gets its own timer rather than riding the session
   * poll. A failed read is already folded into the reader's own last-good
   * values; the catch here is for the read throwing outright, which must not
   * become an unhandled rejection inside an interval. Never two at once: the
   * timer and a connecting socket can both find a read due.
   */
  function pollUsage(): Promise<void> {
    usageReading ??= readUsage().finally(() => { usageReading = null; });
    return usageReading;
  }

  async function readUsage(): Promise<void> {
    if (!opts.usage) return;
    usageAskedAt = Date.now();
    const sources = await opts.usage.read().catch(() => null);
    if (!sources) return;
    const message = { t: "usage", sources } satisfies ServerMessage;
    lastUsage = message;
    const json = JSON.stringify(message);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.sendText(json);
  }

  // Nobody connected, nothing read: a server left running in the background
  // would otherwise shell out to tmux and cmux every couple of seconds, and ask
  // the Keychain and the usage API every minute, for no one. A socket that
  // connects triggers its own read.
  const timer = setInterval(() => { if (clients.size > 0) void poll(); }, opts.pollMs ?? 2000);
  // Checked four times an interval so that a read triggered by a connecting
  // socket moves the schedule rather than being followed moments later by the
  // timer's own.
  const usageTimer = opts.usage
    ? setInterval(() => { if (clients.size > 0 && usageDue()) void pollUsage(); }, usageMs / 4)
    : undefined;
  // setInterval does not fire at zero, and a cold load would show an empty
  // footer until it did.
  if (opts.usage) void pollUsage();

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
        const ok = srv.upgrade(req, { data: { pty: null, session: null, sessionId: null, sentState: null, cols: 80, rows: 24, attachSeq: 0 } });
        return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        clients.add(ws);
        void poll();
        // Reconnects are routine on a phone that slept; send what we already
        // know rather than making this client wait out the usage interval. Ask
        // again only if that is stale -- a read per reconnect is how the usage
        // endpoint came to answer 429.
        if (lastUsage && ws.readyState === WebSocket.OPEN) ws.sendText(JSON.stringify(lastUsage));
        if (opts.usage && usageDue()) void pollUsage();
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
      clearInterval(usageTimer);
      for (const ws of clients) {
        ws.data.attachSeq++; // invalidate any in-flight attach
        detach(ws);
      }
      clients.clear();
      for (const s of servers) s.stop(true);
    },
  };
}
