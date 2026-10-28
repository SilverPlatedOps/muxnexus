/** Runs inside a throwaway tmux pane; no real chat or agent is contacted. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const out = process.argv[2]!;
const seen: unknown[] = [];
const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (new URL(req.url).pathname !== "/api/chat/hook") return new Response("wrong path", { status: 404 });
  seen.push(await req.json());
  return Response.json({ ok: true, output: "posted as #1 in throwaway fixture" });
} });
try {
  for (const agent of ["claude", "codex"]) {
    const client = new Client({ name: "pane-local-fixture", version: "1" });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../../scripts/chat-mcp.ts", import.meta.url).pathname, agent],
        env: { PATH: process.env.PATH!, TMUX: process.env.TMUX!, TMUX_PANE: process.env.TMUX_PANE!, MUXNEXUS_PORT: String(gateway.port) },
        stderr: "pipe",
      }));
      const r = await client.callTool({ name: "chat_reply", arguments: { chat: "fixture-only", text: 'literal "\\n"\nsecond line' } });
      if (r.isError) throw new Error(JSON.stringify(r));
    } finally { await client.close(); }
  }
  await Bun.write(out, JSON.stringify({ ok: true, pane: process.env.TMUX_PANE, seen }));
} catch (e) {
  await Bun.write(out, JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exitCode = 1;
} finally { gateway.stop(true); }
