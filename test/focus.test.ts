import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isThisMachine } from "../src/server/focus";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import type { ServerMessage } from "../src/shared/protocol";
import { waitFor } from "./helpers";

const SOCKET = "mxn-focus-test";
const tmux = new Tmux(SOCKET);
let server: RunningServer;

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
  const messages: ServerMessage[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") messages.push(JSON.parse(e.data)); };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const last = <T extends ServerMessage["t"]>(t: T) => [...messages].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  return { ws, last };
}

const focus = (port: number, body: unknown, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}/api/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

beforeAll(() => {
  server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 });
});
afterAll(() => server.stop());
beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

describe("the focus endpoint", () => {
  test("tells the pages on this machine to show the pane's window", async () => {
    await tmux.newSession("work");
    const [pane, windowId] = (await tmux.run(["display-message", "-p", "-t", "work", "#{pane_id}\t#{window_id}"])).trim().split("\t");
    const page = await connect(server.port);
    const res = await focus(server.port, { pane });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: "work", windowId, pages: 1 });
    await waitFor(() => page.last("focus") !== undefined);
    expect(page.last("focus")).toEqual({ t: "focus", session: "work", windowId });
    page.ws.close();
  });

  test("names the session the sidebar shows, not a hidden view of it", async () => {
    await tmux.newSession("work");
    const [pane, windowId] = (await tmux.run(["display-message", "-p", "-t", "work", "#{pane_id}\t#{window_id}"])).trim().split("\t");
    // A split pane's private view of the group holds the same window, and was made last.
    await tmux.openView("work", windowId);
    const res = await focus(server.port, { pane });
    expect(res.status).toBe(200);
    expect((await res.json()).session).toBe("work");
  });

  test("refuses a Host it does not recognise", async () => {
    const res = await focus(server.port, { pane: "%1" }, { headers: { "content-type": "application/json", Host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("refuses a browser's post", async () => {
    const res = await focus(server.port, { pane: "%1" }, { headers: { "content-type": "application/json", Origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });

  test("takes only a POST with a pane id", async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/focus`)).status).toBe(405);
    expect((await focus(server.port, { pane: "work" })).status).toBe(400);
    expect((await focus(server.port, "nonsense")).status).toBe(400);
  });

  test("answers 404 for a pane that is gone", async () => {
    await tmux.newSession("work");
    expect((await focus(server.port, { pane: "%99999" })).status).toBe(404);
  });
});

describe("which pages count as this machine", () => {
  const interfaces = { lo0: [{ address: "127.0.0.1" }], utun4: [{ address: "100.104.88.26" }] };

  test("loopback and this machine's own addresses, its Tailscale one included", () => {
    expect(isThisMachine("127.0.0.1", interfaces)).toBe(true);
    expect(isThisMachine("::ffff:127.0.0.1", interfaces)).toBe(true);
    expect(isThisMachine("::1", interfaces)).toBe(true);
    expect(isThisMachine("100.104.88.26", interfaces)).toBe(true);
    expect(isThisMachine("::ffff:100.104.88.26", interfaces)).toBe(true);
  });

  test("not another device on the tailnet", () => {
    expect(isThisMachine("100.64.1.9", interfaces)).toBe(false);
    expect(isThisMachine(undefined, interfaces)).toBe(false);
  });
});
