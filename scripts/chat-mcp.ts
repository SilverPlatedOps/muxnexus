#!/usr/bin/env bun
/** Per-agent stdio MCP adapter. stdout is protocol-only; all setup is explicit. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createChatToolServer, hookPoster } from "../src/server/chat/tool-adapter";
import { paneIdentity } from "../src/server/chat/tool-identity";

if (import.meta.main) {
  try {
    const server = createChatToolServer({
      identity: paneIdentity(process.argv[2], process.env),
      post: hookPoster(Number(process.env.MUXNEXUS_PORT ?? "7681")),
    });
    await server.connect(new StdioServerTransport());
  } catch (e) {
    process.stderr.write(`muxnexus chat tools: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
