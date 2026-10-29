#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/** Print opt-in MCP configuration. Never edits the user's settings or freezes a pane ID. */
import { resolve } from "node:path";

export function chatMcpConfig(agent: "claude" | "codex", root = resolve(import.meta.dir, ".."), bun = process.execPath): string {
  const args = [resolve(root, "scripts/chat-mcp.ts"), agent];
  if (agent === "claude") {
    return JSON.stringify({ mcpServers: { "muxnexus-chat": {
      type: "stdio", command: bun, args,
      env: { TMUX: "${TMUX}", TMUX_PANE: "${TMUX_PANE}", MUXNEXUS_PORT: "${MUXNEXUS_PORT:-7681}" },
    } } }, null, 2) + "\n";
  }
  return [
    "[mcp_servers.muxnexus-chat]",
    `command = ${JSON.stringify(bun)}`,
    `args = ${JSON.stringify(args)}`,
    'env_vars = ["TMUX", "TMUX_PANE", "MUXNEXUS_PORT"]',
    "",
  ].join("\n");
}

if (import.meta.main) {
  const agent = process.argv[2];
  if ((agent !== "claude" && agent !== "codex") || process.argv.length !== 3) {
    process.stderr.write("Usage: bun scripts/chat-mcp-config.ts claude|codex\nPrints a config snippet; merge it into your existing MCP config, then review/reload it in the agent.\n");
    process.exitCode = 1;
  } else process.stdout.write(chatMcpConfig(agent));
}
