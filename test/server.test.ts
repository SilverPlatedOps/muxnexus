import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ServerMessage } from "../src/shared/protocol";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-server";
const tmux = new Tmux(SOCKET);
let server: RunningServer;

/** Small test client that records control messages and terminal output separately. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Origin: `http://127.0.0.1:${server.port}` },
  } as any);
  ws.binaryType = "arraybuffer";
  const messages: ServerMessage[] = [];
  let output = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    else output += dec.decode(e.data as ArrayBuffer, { stream: true });
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const last = (t: ServerMessage["t"]) => [...messages].reverse().find((m) => m.t === t);
  return { ws, messages, send, last, output: () => output, sendBytes: (s: string) => ws.send(new TextEncoder().encode(s)) };
}

beforeAll(() => { server = createServer({ host: "127.0.0.1", port: 0, socketName: SOCKET, pollMs: 200 }); });
afterAll(() => server.stop());
beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

test("rejects a WebSocket upgrade with a foreign Origin", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Origin: "http://evil.example" },
  } as any);
  let opened = false;
  ws.onopen = () => { opened = true; };
  await new Promise<void>((res) => {
    ws.onerror = () => res();
    ws.onclose = () => res();
  });
  expect(opened).toBe(false);
});

test("rejects a WebSocket upgrade with no Origin", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  let opened = false;
  ws.onopen = () => { opened = true; };
  await new Promise<void>((res) => {
    ws.onerror = () => res();
    ws.onclose = () => res();
  });
  expect(opened).toBe(false);
});

test("sends state on connect", async () => {
  const c = await connect();
  const state = await waitFor(() => c.last("state"), 2000, "initial state");
  expect(state).toEqual({ t: "state", sessions: [] });
  c.ws.close();
});

test("new-session pushes updated state without waiting for the poll", async () => {
  const c = await connect();
  await waitFor(() => c.last("state"));
  c.send({ t: "new-session", name: "created" });
  const state = await waitFor(() => {
    const s = c.last("state");
    return s && s.t === "state" && s.sessions.some((x) => x.name === "created") ? s : null;
  }, 2000, "state with created");
  expect(state.t).toBe("state");
  c.ws.close();
});

test("attach streams output, forwards input, and resizes", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "-x", "80", "-y", "24", "sh"]);
  const c = await connect();
  c.send({ t: "resize", cols: 120, rows: 40 });
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"), 2000, "attached");
  await waitFor(() => c.output().length > 0, 3000, "redraw");
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=s:0", "#{window_width}"])).trim() === "120", 3000, "attach at 120 cols");
  c.sendBytes("echo SRV_MARK_$((1+1))\r");
  await waitFor(() => c.output().includes("SRV_MARK_2"), 3000, "echoed input");
  c.send({ t: "resize", cols: 90, rows: 30 });
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=s:0", "#{window_width}"])).trim() === "90", 3000, "resize to 90");
  c.ws.close();
  // Closing the socket detaches the client but keeps the session.
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 0, 3000, "client gone");
  expect(await tmux.hasSession("s")).toBe(true);
});

test("killing the attached session sends detached with reason session-killed", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"));
  c.send({ t: "kill-session", session: "s" });
  const d = await waitFor(() => c.last("detached"), 3000, "detached");
  expect(d).toEqual({ t: "detached", reason: "session-killed" });
  c.ws.close();
});

test("detaching from inside tmux sends detached with reason exited", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"));
  await waitFor(() => c.output().length > 0);
  await tmux.run(["detach-client", "-s", "=s"]);
  const d = await waitFor(() => c.last("detached"), 3000, "detached");
  expect(d).toEqual({ t: "detached", reason: "exited" });
  expect(await tmux.hasSession("s")).toBe(true);
  c.ws.close();
});

test("switching sessions kills the old client and attaches the new one", async () => {
  await tmux.run(["new-session", "-d", "-s", "a", "sh"]);
  await tmux.run(["new-session", "-d", "-s", "b", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "a" });
  await waitFor(() => c.last("attached")?.t === "attached" && (c.last("attached") as any).session === "a");
  c.send({ t: "attach", session: "b" });
  await waitFor(() => (c.last("attached") as any)?.session === "b", 3000, "attached b");
  await waitFor(async () => {
    const s = await tmux.listSessions();
    return s.find((x) => x.name === "a")?.attached === 0 && s.find((x) => x.name === "b")?.attached === 1;
  }, 3000, "only b attached");
  expect(c.messages.filter((m) => m.t === "detached")).toHaveLength(0);
  c.ws.close();
});

test("attach to the already-attached session is a no-op", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"));
  await waitFor(() => c.output().length > 0);
  c.send({ t: "attach", session: "s" });
  await Bun.sleep(300);
  expect(c.messages.filter((m) => m.t === "attached")).toHaveLength(1);
  expect(c.messages.filter((m) => m.t === "detached")).toHaveLength(0);
  expect((await tmux.listSessions())[0].attached).toBe(1);
  c.ws.close();
});

test("rejects invalid resize", async () => {
  const c = await connect();
  await waitFor(() => c.last("state"));
  c.send({ t: "resize", cols: "x", rows: null });
  c.send({ t: "resize", cols: 999999, rows: 5 });
  await waitFor(() => c.messages.filter((m) => m.t === "error").length === 2, 2000, "two errors");
  for (const err of c.messages.filter((m) => m.t === "error")) {
    expect((err as any).message).toMatch(/invalid resize/);
  }
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"));
  await waitFor(() => c.output().length > 0);
  expect((await tmux.run(["display-message", "-p", "-t", "=s:0", "#{window_width}"])).trim()).toBe("80");
  c.ws.close();
});

test("binary input before attach is dropped without error", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  const c = await connect();
  await waitFor(() => c.last("state"));
  c.sendBytes("echo SHOULD_NOT_RUN\r");
  await Bun.sleep(150);
  expect(c.messages.filter((m) => m.t === "error")).toHaveLength(0);
  expect(c.output()).toBe("");
  // The session's pane must not have received the bytes either.
  const pane = await tmux.run(["capture-pane", "-p", "-t", "=s:0"]);
  expect(pane).not.toContain("SHOULD_NOT_RUN");
  c.ws.close();
});

test("errors are reported, unknown types rejected, ping ignored", async () => {
  const c = await connect();
  await waitFor(() => c.last("state"));
  c.send({ t: "kill-session", session: "nope" });
  const err = await waitFor(() => c.last("error"), 2000, "error");
  expect((err as any).message).toMatch(/can't find session|no server running/);
  c.send({ t: "bogus" });
  await waitFor(() => c.messages.filter((m) => m.t === "error").length === 2, 2000, "second error");
  expect((c.last("error") as any).message).toMatch(/unknown message type/);
  const before = c.messages.length;
  c.send({ t: "ping" });
  await Bun.sleep(150);
  expect(c.messages.length).toBe(before);
  c.ws.close();
});

test("a new connection receives exactly one state", async () => {
  const c = await connect();
  await Bun.sleep(500); // 2+ poll intervals at pollMs 200
  expect(c.messages.filter((m) => m.t === "state")).toHaveLength(1);
  c.ws.close();
});
