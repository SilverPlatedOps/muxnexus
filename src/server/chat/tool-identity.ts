// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ToolIdentity } from "./tool-adapter";

type Command = (args: string[]) => Promise<string>;
/** A proof is bounded even for malformed/cyclic process information. */
export async function descendsFrom(pid: number, ancestor: number, parent: (pid: number) => Promise<number>): Promise<boolean> {
  const seen = new Set<number>();
  for (let depth = 0; depth < 128 && Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid); depth++) {
    if (pid === ancestor) return true;
    seen.add(pid);
    pid = await parent(pid);
  }
  return false;
}

/** Capture identity once; verify ancestry for every call so an orphaned server cannot post as a replacement agent. */
export function paneIdentity(agent: string | undefined, env: Record<string, string | undefined>, pid = process.pid, run: Command = command): () => Promise<ToolIdentity> {
  const pane = env.TMUX_PANE;
  const tmux = env.TMUX;
  return async () => {
    if (agent !== "claude" && agent !== "codex") throw new Error("Start chat-mcp.ts with claude or codex; agent identity is not a tool argument.");
    if (!tmux || !pane || !/^%[0-9]+$/.test(pane)) throw new Error("No tmux pane identity. Start the agent inside tmux and forward TMUX and TMUX_PANE to this stdio server. Codex must use --no-daemon.");
    const top = Number((await run(["tmux", "display-message", "-p", "-t", pane, "#{pane_pid}"])).trim());
    if (!Number.isSafeInteger(top) || top <= 1 || !(await descendsFrom(pid, top, async (p) => Number((await run(["ps", "-o", "ppid=", "-p", String(p)])).trim())))) {
      throw new Error("This MCP process does not belong to the original tmux pane. Start a pane-local agent (Codex: --no-daemon); a shared daemon cannot identify the chat sender.");
    }
    return { agent, pane };
  };
}

async function command(args: string[]): Promise<string> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error("Could not prove this MCP process's tmux identity. Is tmux available and the agent still in its pane?");
  return text;
}
