// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

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

type Runner = (argv: string[], opts: { home?: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;

/**
 * `codex` with the server's tmux variables removed, so nothing it starts can
 * stamp the server's own pane, under the recipient's CODEX_HOME, whose queue
 * its tab reads, and killed if it hangs.
 */
const runCodex: Runner = async (argv, opts) => {
  const bin = Bun.which("codex");
  if (!bin) return { code: 127, out: "codex is not on the server's PATH" };
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  if (opts.home) env.CODEX_HOME = opts.home;
  const p = Bun.spawn([bin, ...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: (out + err).trim() };
  } finally {
    clearTimeout(timer);
  }
};

/** A `codex queue` call that hasn't answered in this long never will. */
const CODEX_TIMEOUT_MS = 15_000;

export function codexAdapter(opts: { run?: Runner; timeoutMs?: number } = {}): Adapter {
  const run = opts.run ?? runCodex;
  const timeoutMs = opts.timeoutMs ?? CODEX_TIMEOUT_MS;
  return {
    kind: "codex",
    async send(target, text) {
      if (!target.thread) return { ok: false, reason: "unavailable", detail: "no thread yet" };
      // Arguments, never a shell line: the text is whatever an agent wrote.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs + 1000); });
      const r = await Promise.race([run(["queue", "--thread", target.thread, "--message", text], { ...(target.configDir ? { home: target.configDir } : {}), timeoutMs }), late]).finally(() => clearTimeout(timer));
      if (!r) return { ok: false, reason: "unavailable", detail: "codex queue didn't answer in time" };
      return r.code === 0 ? { ok: true } : { ok: false, reason: "unavailable", detail: r.out || `codex queue exited ${r.code}` };
    },
  };
}

/** With no offset, the last stretch of a transcript holds the message once the agent has it. */
const TAIL = 256 * 1024;
/** From an offset, this much is read: the message lands soon after it goes. */
const SPAN = 8 * 1024 * 1024;

/** A tag as it can appear in a JSON line: as is, escaped, or escaped down to ASCII. */
export function tagForms(tag: string): string[] {
  const escaped = JSON.stringify(tag).slice(1, -1);
  const ascii = escaped.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [tag, escaped, ascii];
}

/**
 * Whether `tag` appears in a transcript or rollout: after `from`, where it
 * stood when the message went, or else near its end. Both are JSON lines, so
 * the tag is also looked for as JSON would escape it.
 */
export async function hasTag(path: string, tag: string, from?: number): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    // A file shorter than the offset was replaced: all of it is new.
    const start = from === undefined ? Math.max(0, size - TAIL) : from <= size ? from : 0;
    const buf = Buffer.alloc(Math.min(size - start, from === undefined ? TAIL : SPAN));
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return tagForms(tag).some((f) => text.includes(f));
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}
