import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChatToolServer } from "../src/server/chat/tool-adapter";
import { createChatService } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "mxn-tool-gateway-"));
  const process = { replaced: false };
  const info = (codex: boolean) => ({ paneId: codex ? "%7" : "%1", kind: codex ? "codex" as const : "claude" as const, pid: codex ? (process.replaced ? 33 : 22) : 11, state: "done" as const, fresh: true, ...(codex ? { thread: { id: process.replaced ? "other-thread" : "thread", path: "/tmp/no-such-tool-rollout.jsonl" } } : { conversation: { sessionId: "session", transcriptPath: "/tmp/no-such-tool-session.jsonl" } }) });
  const svc = createChatService({
    store: createChatStore(dir), tmux: { windowOfPane: async (pane) => ({ windowId: pane === "%7" ? "@2" : "@1", session: "work" }), agentOfWindow: async (w) => info(w === "@2") as never },
    states: async () => new Map(), adapters: {}, alive: () => true, now: () => "2026-10-28T12:00:00.000Z",
  });
  const created = await svc.handle({ t: "chat-create", name: "Room A", members: [{ windowId: "@1" }, { windowId: "@2" }] });
  if (!created.ok || !created.chatId) throw new Error("Could not create fixture");
  const id = created.chatId;
  const server = createChatToolServer({ identity: async () => ({ agent: "codex", pane: "%7" }), post: (req) => svc.hook(req) });
  const client = new Client({ name: "gateway-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  cleanups.push(async () => { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  return { svc, id, client, process, view: async () => (await svc.view(id))!.chat };
}

test("typed reply traverses real gateway, preserves literal code, and links a parent", async () => {
  const { svc, id, client, view } = await fixture();
  await svc.handle({ t: "chat-post", id, text: "@codex1 review this" });
  const parent = (await view()).messages.at(-1)!.id;
  const text = '@claude1 Use String.raw`\\n` here.';
  const r = await client.callTool({ name: "chat_reply", arguments: { chat: id, text, replyTo: parent } });
  expect(r.isError).toBe(false);
  expect((await view()).messages.at(-1)).toMatchObject({ from: "codex1", text, replyTo: parent });
});

test("flag-shaped literal messages survive the hook terminator exactly once", async () => {
  const { id, client, view } = await fixture();
  for (const text of ["--", "--reply=12", "--reply", "--chat", "a\n\nmultiline code block:\n```sh\necho '$HOME'\n``` ".trim()]) {
    const r = await client.callTool({ name: "chat_reply", arguments: { chat: id, text } });
    expect(r.isError).toBe(false);
    expect((await view()).messages.at(-1)!.text).toBe(text);
  }
});

test("explicit room routing and replaced-member refusal use the existing gateway", async () => {
  const { svc, id, client, process, view } = await fixture();
  const second = await svc.handle({ t: "chat-create", name: "Room B", members: [{ windowId: "@2" }] });
  const before = (await view()).messages.length;
  expect((await client.callTool({ name: "chat_reply", arguments: { chat: "Room B", text: "B only" } })).isError).toBe(false);
  expect((await view()).messages.length).toBe(before);
  expect((await svc.view((second as { chatId: string }).chatId))!.chat.messages.at(-1)!.text).toBe("B only");
  process.replaced = true;
  expect((await client.callTool({ name: "chat_reply", arguments: { chat: id, text: "must not post" } })).isError).toBe(true);
  expect((await view()).messages.length).toBe(before);
});

test("read and reply keep blind-round and private-note boundaries; submit is distinct", async () => {
  const { svc, id, client, view } = await fixture();
  await svc.handle({ t: "chat-notes", id, text: "PRIVATE-NOTE", rev: 0, req: "n" });
  await svc.handle({ t: "chat-round", id, action: "start", topic: "Independent evidence" });
  const roundId = (await view()).round!.id;
  await svc.hook({ agent: "claude", pane: "%1", literalText: true, argv: ["--chat", id, "say", "SECRET-PEER-EVIDENCE"] });
  const blind = (await view()).messages.at(-1)!.id;
  const read = await client.callTool({ name: "chat_read", arguments: { chat: id } });
  expect(JSON.stringify(read)).not.toContain("PRIVATE-NOTE");
  expect(JSON.stringify(read)).not.toContain("SECRET-PEER-EVIDENCE");
  expect((await client.callTool({ name: "chat_reply", arguments: { chat: id, text: "guess", replyTo: blind } })).isError).toBe(true);
  await client.callTool({ name: "chat_reply", arguments: { chat: id, text: "ordinary progress" } });
  expect((await view()).round!.submitted).not.toContain("codex1");
  const submitted = await client.callTool({ name: "chat_submit", arguments: { chat: id, roundId, text: 'Use literal "\\n" evidence.' } });
  expect(submitted.isError).toBe(false);
  expect((await view()).round!.submitted).toContain("codex1");
  expect((await view()).messages.at(-1)!.text).toBe('Use literal "\\n" evidence.');
  expect(JSON.stringify(await client.callTool({ name: "chat_rules", arguments: { chat: id } }))).not.toContain("PRIVATE-NOTE");
});
