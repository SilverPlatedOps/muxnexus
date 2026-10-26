import { open, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { AgentKind } from "../../shared/chat";

/**
 * How a message reaches an agent of each kind. Both routes were proven on
 * 2026-10-26 on a scratch tmux:
 *
 * - Claude Code: one JSON user line on the session's inbox socket. An idle
 *   session starts a turn; a busy one reads it between tool calls; Claude Code
 *   frames it as another session's message, never the user's. A session that
 *   has exited has no socket, so offline is known at once.
 * - Codex: `codex queue --thread`. Reaches a `--no-daemon` tab, waits out a
 *   running turn, keeps a draft -- and accepts a message for a tab that has
 *   exited, which is why the planner only hands one over to a live, idle tab.
 *
 * A new agent kind is one more adapter here.
 */

export interface AgentTarget {
  kind: AgentKind;
  /** The agent process, from the window's stamp. */
  pid: number;
  configDir?: string;
  /** Claude: its inbox. */
  socketPath?: string;
  /** Codex: its thread id, from `@muxnexus_thread`. */
  thread?: string;
  /** Where its conversation is written: what a receipt is looked for in. */
  transcript?: string;
}

export type SendResult = { ok: true } | { ok: false; reason: "offline" | "unavailable"; detail?: string };

export interface Adapter {
  kind: AgentKind;
  send(target: AgentTarget, text: string): Promise<SendResult>;
}

/** A Claude session's inbox, from its registry entry: `<config dir>/sessions/<pid>.json`. */
export async function claudeSocket(configDir: string, pid: number, read: (p: string) => Promise<string> = (p) => readFile(p, "utf8")): Promise<string | null> {
  try {
    const entry = JSON.parse(await read(join(configDir, "sessions", `${pid}.json`)));
    return typeof entry?.messagingSocketPath === "string" ? entry.messagingSocketPath : null;
  } catch {
    return null;
  }
}

export function claudeAdapter(): Adapter {
  return {
    kind: "claude",
    send(target, text) {
      const path = target.socketPath;
      if (!path) return Promise.resolve({ ok: false, reason: "offline" });
      const line = `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
      return new Promise<SendResult>((resolve) => {
        let done = false;
        const finish = (r: SendResult) => {
          if (done) return;
          done = true;
          resolve(r);
        };
        const sock = createConnection({ path });
        sock.setTimeout(5000, () => {
          sock.destroy();
          finish({ ok: false, reason: "unavailable", detail: "the inbox did not answer" });
        });
        sock.on("error", (e: NodeJS.ErrnoException) => {
          finish(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? { ok: false, reason: "offline" } : { ok: false, reason: "unavailable", detail: e.message });
        });
        // Claude Code closes a connection with no complete line inside 30 s, so
        // the line is written whole the moment the socket opens.
        sock.on("connect", () => {
          sock.end(line, () => finish({ ok: true }));
        });
      });
    },
  };
}

type Runner = (argv: string[]) => Promise<{ code: number; out: string }>;

/** `codex` with the server's tmux variables removed, so nothing it starts can stamp the server's own pane. */
const runCodex: Runner = async (argv) => {
  const bin = Bun.which("codex");
  if (!bin) return { code: 127, out: "codex is not on the server's PATH" };
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  const p = Bun.spawn([bin, ...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: (out + err).trim() };
};

export function codexAdapter(opts: { run?: Runner } = {}): Adapter {
  const run = opts.run ?? runCodex;
  return {
    kind: "codex",
    async send(target, text) {
      if (!target.thread) return { ok: false, reason: "unavailable", detail: "no thread yet" };
      // Arguments, never a shell line: the text is whatever an agent wrote.
      const r = await run(["queue", "--thread", target.thread, "--message", text]);
      return r.code === 0 ? { ok: true } : { ok: false, reason: "unavailable", detail: r.out || `codex queue exited ${r.code}` };
    },
  };
}

/** The last stretch of a transcript holds the message once the agent has it. */
const TAIL = 256 * 1024;

/**
 * Whether `tag` appears near the end of a transcript or rollout. Both are
 * JSON lines, so the tag is also looked for as JSON would escape it.
 */
export async function hasTag(path: string, tag: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    const escaped = JSON.stringify(tag).slice(1, -1);
    const ascii = escaped.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return text.includes(tag) || text.includes(escaped) || text.includes(ascii);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}
