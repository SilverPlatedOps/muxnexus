import type { HTMLBundle, ServerWebSocket } from "bun";
import type { ClientMessage, DetachReason, NewWindowAgent, ServerMessage, SessionInfo, SwapHolder, SwapNotice, SystemStats } from "../shared/protocol";
import { categoryProfile, profileLabel, type UsageReader } from "./usage";
import { splitCategory } from "../shared/category";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CmuxMirror } from "./cmux";
import { attachSession, type PtyHandle } from "./pty";
import { shellQuote, Tmux } from "./tmux";
import { createNoteStore, isNoteId, pickOrphan } from "./notes";
import { claudeAdapter, codexAdapter } from "./chat/adapters";
import { createChatService, isLoopback, parseChatMessage, parseHookRequest, type ChatService, type WindowLive } from "./chat/service";
import { createChatStore, isChatId } from "./chat/store";
import type { DockerReader } from "./docker";
import type { MemoryReader, MemoryReading } from "./memory";
import type { VitalsSampler } from "./vitals";

/**
 * What a new window runs for each agent the client may ask for. The client only
 * ever names one: with no authentication in front of this server, a command
 * line taken from the wire would be a shell for anyone who can reach it.
 */
// `--no-daemon` because Codex otherwise runs hooks in its shared daemon, which
// holds another terminal's $TMUX_PANE: the tab would never show its status.
// Inline, because its alternate screen never reaches tmux's history, so there
// would be nothing to scroll. `command` skips scripts/codex-tmux.zsh, which
// would add the same flags again -- and Codex refuses --no-daemon twice.
const AGENTS: Record<NewWindowAgent, string> = { codex: `command codex --no-daemon -c 'tui.alternate_screen="never"'` };

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
   * The cheap readings -- memory, swap, CPU, the alarm level -- taken whether or
   * not anyone is looking, so the swap nudge can fire with every panel shut.
   * Absent, nothing is sampled and no notice is sent: the tests create servers
   * constantly and must not spawn `vm_stat`.
   */
  vitals?: VitalsSampler;
  /**
   * The costly reading -- every process and its footprint, charged to tabs --
   * made from this server's tmux. Read only on demand: while a client's app list
   * is in view (every `systemMs`), while one shows memory on its tabs (every
   * `memoryMs`), and while urgent (every `urgentMemoryMs`, to name the biggest).
   */
  memory?: (tmux: Tmux) => MemoryReader;
  systemMs?: number;
  memoryMs?: number;
  urgentMemoryMs?: number;
  /** The overview's Docker tab, on the same terms: read only while some client has the tab open. */
  docker?: DockerReader;
  dockerMs?: number;
  /**
   * The Claude config dirs on this machine. A session created here whose tag
   * names one (`[Work] ...`) starts with `CLAUDE_CONFIG_DIR` set to it, so
   * `claude` inside it spends that account. Absent, nothing is set: the tests
   * must not depend on which profiles the machine running them has.
   */
  profiles?: () => string[];
  /**
   * Asked as each client connects: one line worth telling them, or null. Used
   * for the waiting-restore notice. Absent, nothing is sent and nothing is read,
   * so the tests never touch the snapshot directory.
   */
  hint?: () => Promise<string | null>;
  /** Where window notes are kept; `~/.local/share/muxnexus/notes` when absent. */
  notesDir?: string;
  /**
   * Where group chats are kept. Absent, chats are off: no hook endpoint, no
   * delivery timer -- the tests create servers constantly and must not read
   * or deliver anything of the user's.
   */
  chatsDir?: string;
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
  /** The split-pane view this socket is attached through (`$7`), removed when it detaches. */
  view: string | null;
  /** The wheel opened the pane's history; the next keystroke closes it first. */
  scrolled: boolean;
  /** Keystrokes held while that closes, so they still arrive in order. */
  typing: Promise<void> | null;
  /** This client has the system overview open. */
  system: boolean;
  /** ...and its app list in view, which is what the process list is read for. */
  list: boolean;
  /** This client shows memory on its tabs. */
  memory: boolean;
  /** This client has the overview's Docker tab open. */
  docker: boolean;
  /** This client shows the chat list, and which chat it has open. */
  chats: boolean;
  chatOpen: string | null;
  /** What it was last sent of each, so a change goes out once. */
  sentChats: string | null;
  sentChat: string | null;
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

/** Sent as their own type: a browser shows these and runs nothing in them. */
const SHOWN_AS_IS = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/**
 * A local file a program linked to (`file:///...`), for the browser to show.
 * Anything but a picture or a PDF goes as plain text -- Bun would call a `.ts`
 * file MPEG video -- and all of it in a sandbox: an HTML or SVG file served as
 * itself would run as this page, and this page can type into every terminal.
 */
async function serveFile(path: string | null): Promise<Response> {
  const notFound = new Response("Not found", { status: 404 });
  if (!path || !isAbsolute(path)) return notFound;
  if (!(await stat(path).catch(() => null))?.isFile()) return notFound;
  const file = Bun.file(path);
  const type = file.type.split(";")[0];
  return new Response(file, {
    headers: {
      "Content-Type": SHOWN_AS_IS.has(type) ? type : "text/plain; charset=utf-8",
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      // Where a relative reference led: a pane re-reading the file asks for
      // this, not the reference, which moves with the window's directory.
      "X-File-Path": encodeURIComponent(path),
    },
  });
}

export function createServer(opts: ServerOptions): RunningServer {
  const tmux = new Tmux(opts.socketName, opts.socketPath);

  async function linkedFile(url: URL): Promise<Response> {
    let path = url.searchParams.get("path");
    if (path?.startsWith("~/")) path = resolve(homedir(), path.slice(2));
    if (path && !isAbsolute(path)) {
      const id = url.searchParams.get("window");
      if (!id || !/^@\d+$/.test(id)) return new Response("Not found", { status: 404 });
      // Resolve on the execution host, against this terminal's active pane.
      // An absent/deleted window must never fall back to the server's own cwd.
      const cwd = (await tmux.run(["display-message", "-p", "-t", id, "#{pane_current_path}"]).catch(() => "")).replace(/\r?\n$/, "");
      if (!isAbsolute(cwd)) return new Response("Not found", { status: 404 });
      path = resolve(cwd, path);
    }
    return serveFile(path);
  }
  const notes = createNoteStore(opts.notesDir);
  /**
   * Note requests run one at a time, in the order they arrived: a save sent a
   * moment before the list is asked for must be in the list, and the socket's
   * messages are otherwise handled side by side.
   */
  let noteQueue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = noteQueue.then(fn, fn);
    noteQueue = run.catch(() => {});
    return run;
  };
  // A server stopped between opening a view and its first output never let tmux
  // clean it up; nothing can be attached through one of ours before we start.
  void tmux.sweepViews().catch(() => {});
  const clients = new Set<Socket>();
  const allowedHosts = allowedHostList(opts.hosts, opts.allowHosts ?? []);
  /** The last quota read, so a socket opening between polls is not blank for a minute. */
  let lastUsage: ServerMessage | null = null;

  /**
   * The note a window wears, stamping one the first time. A window whose note
   * is blank and whose conversation an earlier tab left a written note beside
   * -- a tab that died, its conversation resumed here -- wears that one
   * instead. A note a live window wears is never taken, and a written one is
   * never replaced.
   */
  async function noteFor(session: string, id: string): Promise<string> {
    const { noteId, conversations } = await tmux.noteStamp(session, id);
    if (conversations.length) {
      if (!noteId || (await notes.read(noteId)).text.trim() === "") {
        const orphan = pickOrphan(await notes.list(), await tmux.wornNotes(), conversations);
        if (orphan) {
          await tmux.stampNote(session, id, orphan, false);
          return orphan;
        }
      }
      if (noteId) await notes.link(noteId, conversations);
    }
    return noteId ?? (await tmux.noteOf(session, id)).noteId;
  }

  // Notes written before conversations were recorded: tied to their windows'
  // now, so a tab that dies from here on still leaves one that can be found.
  void inTurn(async () => {
    for (const s of await tmux.listSessions().catch(() => [])) {
      for (const w of s.windows) {
        if (!w.noteId || !w.conversation) continue;
        const { conversations } = await tmux.noteStamp(s.name, w.id).catch(() => ({ conversations: [] as string[] }));
        await notes.link(w.noteId, conversations).catch(() => {});
      }
    }
  });

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

  /** The tmux server the last `state` was read from: window ids mean something only under it. */
  let tmuxServerId: string | null = null;

  /** Re-read tmux state and send it to each socket that has not seen it yet. */
  async function readState(): Promise<void> {
    const read = await tmux.listState().catch(() => ({ sessions: [] as SessionInfo[], tmuxServer: null }));
    tmuxServerId = read.tmuxServer;
    lastSessions = read.sessions;
    lastSessionsAt = Date.now();
    const sessions = await label(read.sessions);
    followRenames(sessions);
    const json = JSON.stringify({
      t: "state",
      sessions,
      ...(read.tmuxServer ? { tmuxServer: read.tmuxServer } : {}),
    } satisfies ServerMessage);
    for (const ws of clients) {
      if (ws.data.sentState === json || ws.readyState !== WebSocket.OPEN) continue;
      ws.data.sentState = json;
      ws.sendText(json);
    }
    // A member's state shows in its chat: what changed here may change a chat view.
    void pushChats();
  }

  // ---------------------------------------------------------------------------
  // Group chats. The room is the chat service; this is its plumbing: the
  // agents' states it waits on, the timer that delivers whether or not a
  // browser is open, and what each browser is sent.

  /** The last state read, so delivery doesn't read tmux twice in a second. */
  let lastSessions: SessionInfo[] = [];
  let lastSessionsAt = 0;

  async function chatStates(): Promise<Map<string, WindowLive>> {
    if (Date.now() - lastSessionsAt > 1000) {
      const read = await tmux.listState().catch(() => null);
      if (read) {
        lastSessions = read.sessions;
        lastSessionsAt = Date.now();
      }
    }
    const out = new Map<string, WindowLive>();
    for (const s of lastSessions) {
      for (const w of s.windows) out.set(w.id, { ...(w.agent ? { state: w.agent.state } : {}), session: s.name });
    }
    return out;
  }

  const chat: ChatService | null = opts.chatsDir
    ? createChatService({
        store: createChatStore(opts.chatsDir),
        tmux,
        states: chatStates,
        adapters: { claude: claudeAdapter(), codex: codexAdapter() },
        spawn: async (req) => {
          const where = isAbsolute(req.folder) ? await stat(req.folder).catch(() => null) : null;
          if (!where?.isDirectory()) throw new Error(`no such folder: ${req.folder}`);
          let command = AGENTS.codex;
          if (req.kind === "claude") {
            const dir = req.profile ? (opts.profiles?.() ?? []).find((d) => profileLabel(d) === req.profile) : undefined;
            command = dir ? `CLAUDE_CONFIG_DIR=${shellQuote(dir)} claude` : "claude";
          }
          return tmux.spawnWindow(req.session, req.folder, command);
        },
      })
    : null;

  /** Send each chat subscriber the list, and each open chat its view, when they changed. */
  async function pushChats(): Promise<void> {
    if (!chat) return;
    const want = [...clients].filter((ws) => ws.readyState === WebSocket.OPEN && (ws.data.chats || ws.data.chatOpen));
    if (want.length === 0) return;
    const list = JSON.stringify({ t: "chats", chats: await chat.summaries() } satisfies ServerMessage);
    const views = new Map<string, string>();
    for (const ws of want) {
      if (ws.data.chats && ws.data.sentChats !== list) {
        ws.data.sentChats = list;
        ws.sendText(list);
      }
      const id = ws.data.chatOpen;
      if (!id) continue;
      if (!views.has(id)) {
        const v = await chat.view(id);
        views.set(id, v ? JSON.stringify({ t: "chat", ...v } satisfies ServerMessage) : "");
      }
      const json = views.get(id)!;
      if (json && ws.data.sentChat !== json) {
        ws.data.sentChat = json;
        ws.sendText(json);
      }
    }
  }

  let chatTicking = false;
  /** One delivery pass, unless one is running or (unforced) there is nothing to do. */
  async function chatTick(force = false): Promise<void> {
    if (!chat || chatTicking || (!force && !chat.busy())) return;
    chatTicking = true;
    try {
      const changed = await chat.tick();
      if (changed.length) await pushChats();
    } catch (e) {
      console.warn(`chat delivery: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      chatTicking = false;
    }
  }
  // Agents talk while no browser is open, so delivery has its own timer; it
  // reads nothing while nothing waits. A restart picks up where it left off.
  const chatTimer = chat ? setInterval(() => void chatTick(), 1500) : undefined;
  if (chat) void chat.ready().then(() => chatTick(true));

  /** The tab hook's door: loopback only, never a browser page. */
  async function chatHook(req: Request, ip: { address: string } | null): Promise<Response> {
    if (!chat) return new Response("Not found", { status: 404 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (req.headers.get("origin") !== null || !isLoopback(ip?.address)) return new Response("Forbidden", { status: 403 });
    const body = parseHookRequest(await req.json().catch(() => null));
    if (!body) return new Response("Bad request", { status: 400 });
    const r = await chat.hook(body);
    void chatTick(true);
    void pushChats();
    return Response.json(r);
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
    dropView(ws);
  }

  function dropView(ws: Socket) {
    const view = ws.data.view;
    ws.data.view = null;
    if (view) void tmux.closeView(view).catch(() => {});
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
    startClient(ws, target, session);
  }

  /**
   * A split pane's terminal: a tmux client on a private view of window `id`.
   * The view is made before the old client goes, and dropped again if the
   * socket moved on meanwhile -- the same race `attach` guards against, except
   * that losing it here would leave a session behind rather than a client.
   */
  async function attachView(ws: Socket, session: string, id: string) {
    const seq = ++ws.data.attachSeq;
    let view: string;
    try {
      view = await tmux.openView(session, id);
    } catch (e) {
      return send(ws, { t: "error", message: e instanceof Error ? e.message : String(e) });
    }
    if (seq !== ws.data.attachSeq || !clients.has(ws)) {
      await tmux.closeView(view).catch(() => {});
      return;
    }
    detach(ws);
    ws.data.view = view;
    // tmux only redraws for an attached client, so output means the view has
    // one -- and from then on tmux may remove it, which it must not do before.
    startClient(ws, view, session, () => void tmux.releaseView(view).catch(() => {}));
  }

  /** Run a tmux client for `ws` on `target`, a session id; `session` is its sidebar name. */
  function startClient(ws: Socket, target: string, session: string, onFirstOutput?: () => void) {
    let seen = false;
    const handle: PtyHandle = attachSession({
      target,
      socketName: opts.socketName,
      socketPath: opts.socketPath,
      cols: ws.data.cols,
      rows: ws.data.rows,
      onData: (d) => {
        if (!seen) {
          seen = true;
          onFirstOutput?.();
        }
        if (ws.readyState === WebSocket.OPEN) ws.sendBinary(encoder.encode(d));
      },
      onExit: () => {
        // Ignore exits from a client we already replaced or dropped.
        if (ws.data.pty !== handle) return;
        ws.data.pty = null;
        ws.data.session = null;
        ws.data.sessionId = null;
        dropView(ws);
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
        case "system":
          if (typeof m.on !== "boolean" || (m.list !== undefined && typeof m.list !== "boolean")) return send(ws, { t: "error", message: "invalid system" });
          ws.data.system = m.on;
          ws.data.list = m.on && (m.list ?? true);
          syncFast();
          if (!m.on) return;
          // What is known now, so the box is not empty; the list follows its read.
          if (opts.vitals?.latest()) sendSystem([ws]);
          // The list's first read, sent when it lands rather than at the next sample.
          if (ws.data.list && memoryAge() > systemMs) void pollMemory().then(() => { if (ws.data.list && open(ws)) sendSystem([ws]); });
          // Not a change to tmux: no session poll.
          return;
        case "memory":
          if (typeof m.on !== "boolean") return send(ws, { t: "error", message: "invalid memory" });
          ws.data.memory = m.on;
          if (!m.on) return;
          if (lastMemory && memoryAge() <= memoryMs) ws.sendText(memoryJson(lastMemory));
          else void pollMemory();
          return;
        case "swap-ack":
          if (!Number.isFinite(m.episode)) return send(ws, { t: "error", message: "invalid swap-ack" });
          // The sampler tells its listeners, and the notice goes to everyone from there.
          opts.vitals?.acknowledge(m.episode);
          return;
        case "docker":
          if (typeof m.on !== "boolean") return send(ws, { t: "error", message: "invalid docker" });
          ws.data.docker = m.on;
          if (!m.on) return;
          // A reading still fresh is shown as it is: unlike the overview's CPU,
          // nothing here is a delta that a second read so soon would spoil.
          if (lastDocker && Date.now() - lastDocker.at <= dockerMs) return void ws.sendText(lastDocker.json);
          void pollDocker();
          return;
        case "attach":
          await attach(ws, m.session);
          return;
        case "attach-view":
          await attachView(ws, m.session, m.id);
          return;
        case "scroll": {
          const ok = Number.isInteger(m.lines) && Math.abs(m.lines) <= 1000;
          if (!ok) return send(ws, { t: "error", message: "invalid scroll" });
          // The tmux client's own session: a split pane's view, else the attached one.
          const target = ws.data.view ?? ws.data.sessionId;
          if (!target) return;
          if (m.lines < 0) ws.data.scrolled = true;
          await tmux.scroll(target, m.lines);
          return;
        }
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
            win.conversation,
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
        case "chats":
          ws.data.chats = m.on === true;
          ws.data.sentChats = null;
          if (ws.data.chats) await pushChats();
          return;
        case "chat-open":
          ws.data.chatOpen = isChatId(m.id) ? m.id : null;
          ws.data.sentChat = null;
          await pushChats();
          return;
        case "chat-create":
        case "chat-post":
        case "chat-add":
        case "chat-remove":
        case "chat-role":
        case "chat-settings":
        case "chat-archive":
        case "chat-discard-held":
        case "chat-reconnect": {
          if (!chat) return send(ws, { t: "error", message: "Chats are off on this server." });
          const parsed = parseChatMessage(m as unknown as { t: string } & Record<string, unknown>);
          if (!parsed) return send(ws, { t: "error", message: `invalid ${m.t}` });
          const r = await chat.handle(parsed);
          if (!r.ok) return send(ws, { t: "error", message: r.error });
          if (m.t === "chat-create" && r.chatId) send(ws, { t: "chat-created", id: r.chatId });
          await pushChats();
          void chatTick(true);
          return;
        }
        case "new-window": {
          if (m.agent !== undefined && !Object.hasOwn(AGENTS, m.agent)) {
            return send(ws, { t: "error", message: "invalid new-window" });
          }
          await tmux.newWindow(m.session, m.agent === undefined ? undefined : AGENTS[m.agent]);
          break;
        }
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
        case "note-open": {
          if (typeof m.id !== "string") return send(ws, { t: "error", message: "invalid note-open" });
          const noteId = await inTurn(() => noteFor(m.session, m.id));
          const note = await notes.read(noteId);
          send(ws, { t: "note", noteId, windowId: m.id, ...note });
          break; // the poll after carries the stamp to every tab strip
        }
        case "note-save": {
          if (!isNoteId(m.noteId) || typeof m.text !== "string") {
            return send(ws, { t: "error", message: "invalid note-save" });
          }
          // Queued as it arrives, the lookup included: a list asked for after
          // this save must find it written.
          const { note, w } = await inTurn(async () => {
            // Where it was written, while that is still known: what a note
            // whose window is gone will be found by.
            const sessions = await tmux.listSessions().catch(() => []);
            const s = sessions.find((x) => x.windows.some((v) => v.noteId === m.noteId));
            const w = s?.windows.find((x) => x.noteId === m.noteId);
            const conversations = s && w ? (await tmux.noteStamp(s.name, w.id).catch(() => null))?.conversations ?? [] : [];
            const meta = s && w
              ? {
                session: s.customName ?? s.label ?? s.name,
                window: w.customName ?? w.label ?? w.name,
                ...(w.agent?.checkout ? { cwd: w.agent.checkout } : {}),
                ...(conversations.length ? { conversations } : {}),
              }
              : null;
            return { note: await notes.write(m.noteId, m.text, meta), w };
          });
          const json = JSON.stringify({ t: "note", noteId: m.noteId, ...note } satisfies ServerMessage);
          for (const other of clients) if (other !== ws && other.readyState === WebSocket.OPEN) other.sendText(json);
          // Only a note turning empty or not changes what a tab shows.
          const empty = m.text.trim() === "";
          if (!w || (w.noteEmpty ?? false) === empty) return;
          await tmux.markNote(m.noteId, empty);
          break;
        }
        case "notes-list": {
          const [stored, sessions] = await inTurn(() => Promise.all([notes.list(), tmux.listSessions().catch(() => [])]));
          const where = new Map<string, { s: SessionInfo; w: SessionInfo["windows"][number] }>();
          for (const s of sessions) for (const w of s.windows) if (w.noteId) where.set(w.noteId, { s, w });
          const list = stored
            .filter((n) => n.text.trim() !== "")
            .map((n) => {
              const at = where.get(n.noteId);
              return {
                noteId: n.noteId,
                session: at ? at.s.customName ?? at.s.label ?? at.s.name : n.meta.session ?? "",
                window: at ? at.w.customName ?? at.w.label ?? at.w.name : n.meta.window ?? "",
                text: n.text,
                updated: n.updated,
                ...(at ? { live: { session: at.s.name, windowId: at.w.id } } : {}),
              };
            })
            .sort((a, b) => b.updated.localeCompare(a.updated));
          return send(ws, { t: "notes", notes: list });
        }
        case "note-delete": {
          if (!isNoteId(m.noteId)) return send(ws, { t: "error", message: "invalid note-delete" });
          await inTurn(() => notes.remove(m.noteId));
          await tmux.dropNote(m.noteId);
          const json = JSON.stringify({ t: "note-deleted", noteId: m.noteId } satisfies ServerMessage);
          for (const c of clients) if (c.readyState === WebSocket.OPEN) c.sendText(json);
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

  const systemMs = opts.systemMs ?? 2000;
  const memoryMs = opts.memoryMs ?? 5000;
  const urgentMemoryMs = opts.urgentMemoryMs ?? 30_000;
  const memoryReader = opts.memory?.(tmux);
  const open = (ws: Socket) => ws.readyState === WebSocket.OPEN;
  const watchingSystem = () => [...clients].filter((ws) => ws.data.system && open(ws));
  const watchingList = () => [...clients].filter((ws) => ws.data.list && open(ws));
  const watchingMemory = () => [...clients].filter((ws) => ws.data.memory && open(ws));

  // The sampler runs every five seconds for the nudge; every two while someone
  // has the overview open, which is the cadence its CPU line is drawn at.
  let fastSent = false;
  function syncFast() {
    const on = watchingSystem().length > 0;
    if (on === fastSent) return;
    fastSent = on;
    opts.vitals?.setFast(on);
  }

  let lastMemory: MemoryReading | null = null;
  let lastMemoryAt = 0;
  let memoryReading: Promise<void> | null = null;
  const memoryAge = () => (lastMemory ? Date.now() - lastMemoryAt : Infinity);
  const memoryJson = (m: MemoryReading) =>
    JSON.stringify({ t: "memory", tmuxServer: m.tmuxServer, at: m.at, metric: m.metric, windows: m.windows } satisfies ServerMessage);

  /** Never two at once: the list, the tab chips and an urgent notice all share one reading. */
  function pollMemory(): Promise<void> {
    memoryReading ??= readMemory().finally(() => { memoryReading = null; });
    return memoryReading;
  }

  async function readMemory(): Promise<void> {
    if (!memoryReader) return;
    const reading = await memoryReader.read().catch(() => null);
    if (!reading) return;
    lastMemory = reading;
    lastMemoryAt = Date.now();
    const json = memoryJson(reading);
    for (const ws of watchingMemory()) ws.sendText(json);
  }

  function systemStats(list: boolean): SystemStats {
    const v = opts.vitals?.latest();
    const m = list ? lastMemory : null;
    return {
      ...(v?.cpu === undefined ? {} : { cpu: v.cpu }),
      load: v?.load ?? [0, 0, 0],
      ...(v?.mem ? { mem: v.mem } : {}),
      ...(v?.swap ? { swap: v.swap } : {}),
      ...(v?.split ? { split: v.split } : {}),
      apps: m?.apps ?? [],
      // Stamped with the tmux server the windows were read from, not today's: after a
      // restart the old ids would otherwise wear the new server's name.
      ...(m ? { appsCpu: m.appsCpu, metric: m.metric, windows: m.windows, ...(m.tmuxServer ? { tmuxServer: m.tmuxServer } : {}) } : {}),
      history: opts.vitals?.history() ?? [],
      rate: v?.rate ?? null,
      written: v?.written ?? null,
      bootTime: v?.bootTime ?? null,
    };
  }

  /** Two bodies at most: with the list, for those who show it, and without. */
  function sendSystem(targets: Socket[]) {
    let withList: string | null = null;
    let without: string | null = null;
    for (const ws of targets) {
      ws.sendText(ws.data.list
        ? (withList ??= JSON.stringify({ t: "system", stats: systemStats(true) } satisfies ServerMessage))
        : (without ??= JSON.stringify({ t: "system", stats: systemStats(false) } satisfies ServerMessage)));
    }
  }

  /** The four biggest holders, apps and tabs on one scale, for the urgent nudge. */
  function holders(): SwapHolder[] {
    if (!lastMemory) return [];
    const all: SwapHolder[] = [
      ...lastMemory.apps.filter((a) => !a.unreadable).map((a) => ({ kind: "app" as const, name: a.name, bytes: a.mem })),
      // Tabs only from a reading of the tmux server the clients see now: theirs is what names them.
      ...(lastMemory.tmuxServer !== null && lastMemory.tmuxServer === tmuxServerId
        ? lastMemory.windows.map((w) => ({ kind: "tab" as const, name: w.windowId, bytes: w.bytes }))
        : []),
    ];
    return all.sort((a, b) => b.bytes - a.bytes).slice(0, 4);
  }

  function notice(): SwapNotice {
    const v = opts.vitals!.latest();
    const l = opts.vitals!.level();
    return {
      episode: l.episode, severity: l.severity, reason: l.reason,
      rate: v?.rate ?? null, swapUsed: v?.swap?.used ?? null, written: v?.written ?? null, bootTime: v?.bootTime ?? null,
      holders: l.severity === "urgent" ? holders() : [], acked: l.acked, at: v?.at ?? Date.now(),
    };
  }

  // While calm, a notice is news only when it changes; otherwise every sample
  // is, so the banner's rate never goes stale.
  const keyOf = (n: SwapNotice) => `${n.severity} ${n.episode} ${n.acked}`;
  /** What every client was last told, starting from the sampler's own start: calm, no episode. */
  let noticeKey = opts.vitals ? keyOf(notice()) : "";
  function broadcastNotice() {
    const n = notice();
    if (n.severity === "calm" && keyOf(n) === noticeKey) return;
    noticeKey = keyOf(n);
    const json = JSON.stringify({ t: "swap", notice: n } satisfies ServerMessage);
    for (const ws of clients) if (open(ws)) ws.sendText(json);
  }

  function onVitals(): void {
    const age = memoryAge();
    // 0.8: samples land a little either side of their period, and a read that
    // just missed being due would wait a whole extra period.
    const due = (watchingList().length > 0 && age >= systemMs * 0.8)
      || (watchingMemory().length > 0 && age >= memoryMs * 0.8)
      || (opts.vitals!.level().severity === "urgent" && age >= urgentMemoryMs * 0.8);
    // Never waited on: the notice and the figures go now, with the last reading's
    // list. A reading that lands while urgent names the biggest holders afresh.
    if (due && memoryReader) {
      void pollMemory().then(() => { if (opts.vitals!.level().severity === "urgent") broadcastNotice(); });
    }
    broadcastNotice();
    const watching = watchingSystem();
    if (watching.length > 0) sendSystem(watching);
  }
  const offVitals = opts.vitals?.onSample(onVitals);
  opts.vitals?.start();
  void opts.vitals?.sampleNow().catch(() => {});

  const dockerMs = opts.dockerMs ?? 5000;
  let dockerReading: Promise<void> | null = null;
  let lastDocker: { json: string; at: number } | null = null;
  const watchingDocker = () => [...clients].filter((ws) => ws.data.docker && ws.readyState === WebSocket.OPEN);

  /** One at a time, as for the overview: `docker stats` alone takes two seconds. */
  function pollDocker(): Promise<void> {
    dockerReading ??= readDocker().finally(() => { dockerReading = null; });
    return dockerReading;
  }

  async function readDocker(): Promise<void> {
    if (!opts.docker || watchingDocker().length === 0) return;
    const stats = await opts.docker.read().catch(() => null);
    if (!stats) return;
    const json = JSON.stringify({ t: "docker", stats } satisfies ServerMessage);
    lastDocker = { json, at: Date.now() };
    for (const ws of watchingDocker()) ws.sendText(json);
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
  const dockerTimer = opts.docker
    ? setInterval(() => { if (watchingDocker().length > 0) void pollDocker(); }, dockerMs)
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
      const url = new URL(req.url);
      if (url.pathname === "/file") {
        // The same rebinding guard as the socket's: a name pointed at this
        // machine must not be able to read its files.
        if (!hostAllowed(req.headers.get("host"), allowedHosts)) return new Response("Forbidden: unrecognised Host", { status: 403 });
        // Opened from this page or typed in; never embedded by another site's,
        // which could otherwise learn whether a file exists and its size.
        const site = req.headers.get("sec-fetch-site");
        if (site !== null && site !== "same-origin" && site !== "none") return new Response("Forbidden: cross-site", { status: 403 });
        return linkedFile(url);
      }
      if (url.pathname === "/api/chat/hook") return chatHook(req, srv.requestIP(req));
      if (url.pathname === "/ws") {
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
        const ok = srv.upgrade(req, { data: { pty: null, session: null, sessionId: null, sentState: null, cols: 80, rows: 24, attachSeq: 0, view: null, scrolled: false, typing: null, system: false, list: false, memory: false, docker: false, chats: false, chatOpen: null, sentChats: null, sentChat: null } });
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
        // The swap level, whatever it is: the nudge and the title need it with every panel shut.
        // To this client only: what the others were last told is not changed by it.
        if (opts.vitals && ws.readyState === WebSocket.OPEN) send(ws, { t: "swap", notice: notice() });
        // Asked per connection rather than once at startup: at login tmux may not
        // be up yet, and the answer stops being true the moment a restore runs.
        void opts.hint?.().then((message) => {
          if (message && ws.readyState === WebSocket.OPEN) send(ws, { t: "notice", message });
        }).catch(() => {});
      },
      message(ws, msg) {
        if (typeof msg === "string") return void handleControl(ws, msg);
        const text = decoder.decode(msg);
        const write = () => { ws.data.pty?.write(text); };
        // Typed into copy mode, keys would be copy-mode commands rather than
        // input: leave the history the wheel opened, then type.
        if (ws.data.scrolled) {
          ws.data.scrolled = false;
          const target = ws.data.view ?? ws.data.sessionId;
          if (target) ws.data.typing = tmux.leaveScroll(target).catch(() => {});
        }
        if (!ws.data.typing) return write();
        const held = ws.data.typing.then(write);
        ws.data.typing = held;
        void held.then(() => { if (ws.data.typing === held) ws.data.typing = null; });
      },
      close(ws) {
        clients.delete(ws);
        ws.data.attachSeq++; // invalidate any in-flight attach for this socket
        detach(ws);
        syncFast();
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
      offVitals?.();
      opts.vitals?.stop();
      clearInterval(dockerTimer);
      clearInterval(chatTimer);
      for (const ws of clients) {
        ws.data.attachSeq++; // invalidate any in-flight attach
        detach(ws);
      }
      clients.clear();
      for (const s of servers) s.stop(true);
    },
  };
}
