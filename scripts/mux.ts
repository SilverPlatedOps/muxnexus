#!/usr/bin/env bun
/**
 * mux: how an agent talks in a muxnexus chat.
 *
 *   mux say "<text>"      post; @handle wakes that member
 *   mux read [n]          older messages
 *   mux who               members, folders, roles, what each is doing
 *   mux stop "<reason>"   end the exchange for everyone until @user writes
 *   mux leave             leave the chat
 *   (each takes --chat "<name>" when the tab is in more than one chat)
 *
 * The command never reaches the server itself: a Codex agent's commands run in
 * a sandbox that blocks the network. The tab's muxnexus hook catches the call
 * before it runs (PreToolUse), posts it from outside the sandbox with the pane
 * it proved, and swaps the command for one that prints the reply. Run on its
 * own -- no hook, an untrusted hook, a Codex tab in the shared daemon -- it
 * says so and fails, so nothing is ever silently dropped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NOT_CAUGHT = "NOT POSTED: the muxnexus hook didn't catch this call";

/**
 * A command line as POSIX sh would split it, for the one shape the hook
 * accepts: a single simple command. Anything that would run something else --
 * an operator, a substitution, a newline outside quotes -- returns null, so the
 * hook leaves the line alone and it fails on its own. `$` stays literal: the
 * text is delivered as the agent wrote it, never expanded.
 */
export function tokenize(cmd: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const end = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) return null;
      word += cmd.slice(i + 1, close);
      inWord = true;
      i = close + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      for (;;) {
        if (i >= cmd.length) return null;
        const d = cmd[i]!;
        if (d === '"') { i++; break; }
        if (d === "\\" && i + 1 < cmd.length) {
          const n = cmd[i + 1]!;
          if (n === '"' || n === "\\" || n === "$" || n === "`") { word += n; i += 2; continue; }
          if (n === "\n") { i += 2; continue; }
        }
        word += d;
        i++;
      }
    } else if (c === "\\") {
      if (i + 1 >= cmd.length) return null;
      if (cmd[i + 1] === "\n") { i += 2; continue; }
      word += cmd[i + 1];
      inWord = true;
      i += 2;
    } else if (c === " " || c === "\t") {
      end();
      i++;
    } else if (";&|<>()`\n".includes(c) || (c === "$" && cmd[i + 1] === "(")) {
      return null;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  end();
  return words;
}

const HEREDOC = /^([^\n]*?)\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n([\s\S]*?)\n\3[ \t]*\n?$/;
const CAT_HEREDOC = /"\$\(cat\s*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*?)\n\2[ \t]*\n?\)"/g;

/**
 * The arguments of a line that is exactly one `mux` call, or null. A heredoc
 * after it, or the `"$(cat <<'EOF' … EOF)"` idiom as an argument, gives its
 * body verbatim: that is how agents write a message of several lines.
 */
export function muxArgv(command: string): string[] | null {
  const bodies: string[] = [];
  let line = command.trim().replace(CAT_HEREDOC, (_m, _q, _tag, body: string) => `__MUXBODY${bodies.push(body) - 1}__`);
  const doc = HEREDOC.exec(line);
  let trailing: string | null = null;
  if (doc) {
    line = doc[1]!;
    trailing = doc[4]!;
  }
  const words = tokenize(line);
  if (!words || words.length === 0) return null;
  if (!/(^|\/)mux(\.ts)?$/.test(words[0]!)) return null;
  const args = words.slice(1).map((w) => w.replace(/^__MUXBODY(\d+)__$/, (_m, n: string) => bodies[Number(n)] ?? _m));
  if (trailing !== null) args.push(trailing);
  return args;
}

/** What a PreToolUse hook prints to run `command` in place of the agent's own. */
export function hookOutput(command: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command } },
  });
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface HookPost {
  agent: "claude" | "codex";
  pane: string;
  sessionId?: string;
  cwd?: string;
  argv: string[];
}

/**
 * The hook's work: when the agent's command is a `mux` call, post it and
 * return the hook output that prints the reply instead. Null leaves the
 * command alone.
 */
export async function runHook(
  agent: "claude" | "codex",
  payload: unknown,
  env: Record<string, string | undefined>,
  post: (body: HookPost) => Promise<{ ok: boolean; output: string }>,
): Promise<string | null> {
  const p = payload as { tool_input?: { command?: unknown }; session_id?: unknown; cwd?: unknown } | null;
  const command = p?.tool_input?.command;
  if (typeof command !== "string") return null;
  const argv = muxArgv(command);
  const pane = env.TMUX_PANE;
  if (!argv || !pane) return null;
  let reply: { ok: boolean; output: string };
  try {
    reply = await post({
      agent,
      pane,
      ...(typeof p?.session_id === "string" ? { sessionId: p.session_id } : {}),
      ...(typeof p?.cwd === "string" ? { cwd: p.cwd } : {}),
      argv,
    });
  } catch (e) {
    reply = { ok: false, output: `NOT POSTED: the muxnexus server didn't answer (${e instanceof Error ? e.message : String(e)}). Is it running?` };
  }
  // The reply goes through a file the agent's own command reads: a sandboxed
  // Codex command can read it, and nothing in the reply is ever parsed by a shell.
  const dir = join(env.TMPDIR || "/tmp", "muxnexus-chat");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${crypto.randomUUID()}.out`);
  writeFileSync(file, `${reply.output}\n`);
  return hookOutput(`cat ${q(file)}; rm -f ${q(file)}${reply.ok ? "" : "; exit 1"}`);
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "hook") {
    // Never fail the agent's tool call from here: on any error, leave the
    // command alone and let `mux` itself say it wasn't posted.
    try {
      const payload = JSON.parse(await new Response(Bun.stdin.stream()).text());
      const port = process.env.MUXNEXUS_PORT || "7681";
      const out = await runHook(args[1] === "codex" ? "codex" : "claude", payload, process.env, async (body) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/chat/hook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, output: `NOT POSTED: the muxnexus server refused it (${res.status} ${await res.text()})` };
        return (await res.json()) as { ok: boolean; output: string };
      });
      if (out) process.stdout.write(out);
    } catch {
      /* leave the command alone */
    }
    return 0;
  }
  process.stdout.write(
    `${NOT_CAUGHT}.\n` +
      "mux only works from a muxnexus chat member's tab, where muxnexus's hook carries it to the server.\n" +
      "Check the hook is installed (bun run setup in muxnexus) and, in Codex, trusted under /hooks.\n",
  );
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
