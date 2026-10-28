import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChatToolServer, hookPoster, type ChatToolDeps, type ToolHookRequest } from "../src/server/chat/tool-adapter";
import { descendsFrom, paneIdentity } from "../src/server/chat/tool-identity";
import { chatMcpConfig } from "../scripts/chat-mcp-config";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function connect(overrides: Partial<ChatToolDeps> = {}) {
  const calls: ToolHookRequest[] = [];
  const server = createChatToolServer({ identity: async () => ({ agent: "codex", pane: "%7" }), post: async (body) => { calls.push(body); return { ok: true, output: "posted as #8" }; }, ...overrides });
  const client = new Client({ name: "test-chat", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

describe("typed chat tools", () => {
  test("discovery has five bounded, strict schemas; no caller-supplied sender or endpoint", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["chat_members", "chat_read", "chat_reply", "chat_rules", "chat_submit"]);
    for (const t of tools) {
      expect(t.inputSchema.required).toContain("chat");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.properties).not.toHaveProperty("pane");
      expect(t.inputSchema.properties).not.toHaveProperty("agent");
      expect(t.inputSchema.properties).not.toHaveProperty("url");
    }
    expect(tools.find((t) => t.name === "chat_reply")!.annotations!.idempotentHint).toBe(false);
  });

  test("multiline/code/quotes stay opaque JSON and reply targeting is explicit", async () => {
    const { client, calls } = await connect();
    const text = '@claude1\nUse `console.log("\\n")`; $HOME $(touch /tmp/not-executed)\n\n--chat';
    const r = await client.callTool({ name: "chat_reply", arguments: { chat: "Room A", text, replyTo: 12 } });
    expect(r.isError).toBe(false);
    expect(calls).toEqual([{ agent: "codex", pane: "%7", literalText: true, argv: ["--chat", "Room A", "say", "--reply", "12", "--", text] }]);
    expect(r.structuredContent).toEqual({ ok: true, output: "posted as #8" });
  });

  test("literal backslash-n in a one-line code example is marked for preservation", async () => {
    const { client, calls } = await connect();
    const text = 'Use String.raw`\\n` here.';
    await client.callTool({ name: "chat_reply", arguments: { chat: "room", text } });
    expect(calls[0]!.argv.at(-1)).toBe(text);
    expect(calls[0]!.literalText).toBe(true);
  });

  test("read filters, context recovery and round submission map to existing hook commands", async () => {
    const { client, calls } = await connect();
    await client.callTool({ name: "chat_read", arguments: { chat: "room", limit: 40, since: 3, before: 25, humanOnly: true } });
    await client.callTool({ name: "chat_rules", arguments: { chat: "room" } });
    await client.callTool({ name: "chat_members", arguments: { chat: "room" } });
    await client.callTool({ name: "chat_submit", arguments: { chat: "room", roundId: "r2", text: "Evidence" } });
    expect(calls.map((c) => c.argv)).toEqual([
      ["--chat", "room", "read", "40", "--since", "3", "--before", "25", "--human"],
      ["--chat", "room", "rules"], ["--chat", "room", "who"], ["--chat", "room", "submit", "r2", "Evidence"],
    ]);
  });

  test("bad arguments and identity spoofing never reach the gateway", async () => {
    const { client, calls } = await connect();
    for (const args of [{ text: "missing chat" }, { chat: "room", text: " " }, { chat: "room", text: "x".repeat(32_001) }, { chat: "room", text: "hi", pane: "%8" }, { chat: "room", text: "hi", replyTo: 2.5 }]) {
      const r = await client.callTool({ name: "chat_reply", arguments: args });
      expect(r.isError).toBe(true);
    }
    expect((await client.callTool({ name: "chat_read", arguments: { chat: "room", limit: 201 } })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("gateway refusals remain errors, and identity is rechecked on every call", async () => {
    let allowed = true;
    let sent = 0;
    const { client } = await connect({ identity: async () => { if (!allowed) throw new Error("Pane no longer belongs to this process"); return { agent: "claude", pane: "%1" }; }, post: async () => { sent++; return { ok: false, output: "NOT POSTED: replaced member" }; } });
    expect((await client.callTool({ name: "chat_reply", arguments: { chat: "room", text: "hi" } })).isError).toBe(true);
    allowed = false;
    const r = await client.callTool({ name: "chat_read", arguments: { chat: "room" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ ok: false, output: "Pane no longer belongs to this process" });
    expect(sent).toBe(1);
  });

  test("real stdio process initializes and reports missing pane identity without posting", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../scripts/chat-mcp.ts", import.meta.url).pathname, "codex"], env: { PATH: process.env.PATH ?? "", TMUX: "", TMUX_PANE: "" }, stderr: "pipe" });
    const client = new Client({ name: "stdio-test", version: "1" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(5);
    const r = await client.callTool({ name: "chat_reply", arguments: { chat: "room", text: "hi" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("No tmux pane identity");
  });
});

describe("pane identity", () => {
  test("requires pane-local ancestry, rejects daemon, cycles and missing identity", async () => {
    expect(await descendsFrom(30, 10, async (pid) => ({ 30: 20, 20: 10 }[pid] ?? 1))).toBe(true);
    expect(await descendsFrom(30, 10, async () => 1)).toBe(false);
    expect(await descendsFrom(30, 10, async (p) => p === 30 ? 20 : 30)).toBe(false);
    await expect(paneIdentity("codex", {}, 30)()).rejects.toThrow("No tmux pane identity");
    await expect(paneIdentity("user", { TMUX: "socket", TMUX_PANE: "%1" }, 30)()).rejects.toThrow("agent identity");
  });

  test("capture pane once, revalidate current parent on each call", async () => {
    const env = { TMUX: "socket,1,0", TMUX_PANE: "%1" };
    let parent = 10;
    const identity = paneIdentity("claude", env, 30, async (args) => args[0] === "tmux" ? "10\n" : String(parent));
    env.TMUX_PANE = "%99";
    expect(await identity()).toEqual({ agent: "claude", pane: "%1" });
    parent = 1;
    await expect(identity()).rejects.toThrow("original tmux pane");
  });
});

describe("local hook transport", () => {
  const body: ToolHookRequest = { agent: "codex", pane: "%1", literalText: true, argv: ["--chat", "room", "say", "--", "hello"] };
  test("posts JSON to fixed loopback hook with no redirects", async () => {
    const fetcher = (async (url, options) => {
      expect(url).toBe("http://127.0.0.1:7681/api/chat/hook");
      expect(options!.redirect).toBe("error");
      expect(JSON.parse(options!.body as string)).toEqual(body);
      expect(new Headers(options!.headers).has("origin")).toBe(false);
      return Response.json({ ok: true, output: "posted as #2" });
    }) as typeof fetch;
    expect(await hookPoster(7681, fetcher)(body)).toEqual({ ok: true, output: "posted as #2" });
    expect(() => hookPoster(0)).toThrow("MUXNEXUS_PORT");
  });
  test("unconfirmed writes never retry or claim they were not posted", async () => {
    let attempts = 0;
    const post = hookPoster(7681, (async () => { attempts++; throw new Error("socket closed after commit"); }) as unknown as typeof fetch);
    const r = await post(body);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("may already have succeeded");
    expect(attempts).toBe(1);
  });
});

test("config snippets preserve runtime pane binding and paths with spaces", () => {
  const codex = Bun.TOML.parse(chatMcpConfig("codex", "/tmp/repo with spaces", "/tmp/bun bin")) as { mcp_servers: Record<string, { command: string; args: string[]; env_vars: string[] }> };
  expect(codex.mcp_servers["muxnexus-chat"]).toEqual({ command: "/tmp/bun bin", args: ["/tmp/repo with spaces/scripts/chat-mcp.ts", "codex"], env_vars: ["TMUX", "TMUX_PANE", "MUXNEXUS_PORT"] });
  const claude = JSON.parse(chatMcpConfig("claude", "/tmp/repo", "/tmp/bun"));
  expect(claude.mcpServers["muxnexus-chat"].env.TMUX_PANE).toBe("${TMUX_PANE}");
  expect(claude.mcpServers["muxnexus-chat"].args).toEqual(["/tmp/repo/scripts/chat-mcp.ts", "claude"]);
});
