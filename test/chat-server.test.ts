import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import type { ServerMessage } from "../src/shared/protocol";
import { waitFor } from "./helpers";

const SOCKET = "mxn-chat-server-test";
const tmux = new Tmux(SOCKET);
let server: RunningServer;
let dir = "";

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
  const messages: ServerMessage[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") messages.push(JSON.parse(e.data)); };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const last = <T extends ServerMessage["t"]>(t: T) => [...messages].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  return { ws, messages, send, last };
}

const hook = (port: number, body: object, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/api/chat/hook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mxn-chatsrv-"));
  server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200, chatsDir: dir });
});
afterAll(() => {
  server.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

describe("the chat hook endpoint", () => {
  test("answers a post from this machine", async () => {
    const res = await hook(server.port, { agent: "claude", pane: "%999", argv: ["say", "hi"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, output: "NOT POSTED: this tab isn't in a muxnexus chat. The user adds it from the Chats tab." });
  });

  test("refuses a browser's post", async () => {
    const res = await hook(server.port, { agent: "claude", pane: "%1", argv: ["say", "hi"] }, { Origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  test("refuses a body that is not a hook request", async () => {
    const res = await hook(server.port, { agent: "claude", pane: "%1", argv: "say hi" });
    expect(res.status).toBe(400);
  });

  test("does not exist on a server without chats", async () => {
    const plain = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 });
    try {
      expect((await hook(plain.port, { agent: "claude", pane: "%1", argv: ["say", "hi"] })).status).toBe(404);
    } finally {
      plain.stop();
    }
  });
});

describe("chats over the socket", () => {
  test("a subscriber gets the list, a new chat, and the chat itself", async () => {
    await tmux.newSession("shop");
    const [pane, win] = (await tmux.run(["display-message", "-p", "-t", "=shop:", "#{pane_id} #{window_id}"])).trim().split(" ");
    await tmux.run(["set-option", "-p", "-t", pane!, "@muxnexus_agent", `done ${Math.floor(Date.now() / 1000)} ${process.pid} /Users/me/.claude`]);
    const c = await connect(server.port);
    c.send({ t: "chats", on: true });
    await waitFor(() => c.last("chats"), 2000, "the chat list");
    c.send({ t: "chat-create", name: "shop review", members: [{ windowId: win, role: "driver" }] });
    const created = await waitFor(() => c.last("chat-created"), 3000, "chat-created");
    await waitFor(() => (c.last("chats")?.chats.length ?? 0) === 1, 3000, "the list has it");
    c.send({ t: "chat-open", id: created.id });
    const view = await waitFor(() => c.last("chat"), 3000, "the chat");
    expect(view.chat.name).toBe("shop review");
    expect(view.chat.members.map((m) => m.handle)).toEqual(["user", "claude1"]);
    c.send({ t: "chat-post", id: created.id, text: "@claude1 hello" });
    await waitFor(() => c.last("chat")?.chat.messages.some((m) => m.text === "@claude1 hello"), 3000, "the post shows");
    c.ws.close();
  });

  test("a bad chat message is answered with an error", async () => {
    const c = await connect(server.port);
    c.send({ t: "chat-post", id: "not-a-chat", text: "x" });
    expect((await waitFor(() => c.last("error"), 2000, "an error")).message).toBe("No such chat.");
    c.ws.close();
  });
});
