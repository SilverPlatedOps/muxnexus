import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ServerMessage } from "../src/shared/protocol";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmuxMirror } from "../src/server/cmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-server";
const tmux = new Tmux(SOCKET);
let server: RunningServer;

/** Small test client that records control messages and terminal output separately. */
async function connect(port: number = server.port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: `http://127.0.0.1:${port}` },
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

test("attaches through an explicit tmux socket path", async () => {
  const path = `${tmpdir()}/cmux-viewer-test-server-${process.pid}.sock`;
  const byPath = new Tmux(undefined, path);
  const srv = createServer({ host: "127.0.0.1", port: 0, socketPath: path, pollMs: 200 });
  try {
    await byPath.run(["new-session", "-d", "-s", "p", "sh"]);
    const c = await connect(srv.port);
    const state = await waitFor(() => c.last("state"), 2000, "state");
    expect(state && state.t === "state" ? state.sessions.map((s) => s.name) : null).toEqual(["p"]);
    c.send({ t: "attach", session: "p" });
    await waitFor(() => c.last("attached"), 2000, "attached");
    await waitFor(() => c.output().length > 0, 3000, "redraw through -S socket");
    c.ws.close();
  } finally {
    srv.stop();
    await byPath.killServer();
  }
});

test("with a cmux mirror, create/rename/kill from the browser drive cmux workspaces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-viewer-mirror-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '{"workspaces":[{"custom_title":"web1","ref":"workspace:7"},{"custom_title":"web2","ref":"workspace:8"}]}'
fi
`);
  chmodSync(bin, 0o755);
  const readLog = () => (existsSync(log) ? readFileSync(log, "utf8") : ""); // the fake creates it on first call
  const mirror = createCmuxMirror({ cmuxBin: bin, socketPath: "/tmp/fake.sock", cwd: "/tmp" });
  const srv = createServer({ host: "127.0.0.1", port: 0, socketName: SOCKET, pollMs: 200, mirror });
  try {
    const c = await connect(srv.port);
    await waitFor(() => c.last("state"));
    c.send({ t: "new-session", name: "web1" });
    await waitFor(() => (c.last("state") as any)?.sessions.some((s: any) => s.name === "web1"), 2000, "web1 created");
    await waitFor(() => readLog().includes("workspace create"), 2000, "create logged");
    c.send({ t: "rename-session", session: "web1", name: "web2" });
    await waitFor(() => (c.last("state") as any)?.sessions.some((s: any) => s.name === "web2"), 2000, "renamed");
    // The poller can broadcast the renamed state before the mirror step runs; wait for the mirror too.
    await waitFor(() => readLog().includes("workspace rename"), 2000, "rename logged");
    c.send({ t: "kill-session", session: "web2" });
    await waitFor(() => (c.last("state") as any)?.sessions.length === 0, 2000, "killed");
    await waitFor(() => readLog().includes("workspace close"), 2000, "close logged");
    expect(readLog().trim().split("\n")).toEqual([
      "workspace create --name web1 --cwd /tmp --env VIEWER_TMUX_SESSION=web1 --focus false",
      "workspace list --json",
      "workspace rename workspace:7 --title web2",
      "workspace list --json",
      "workspace close workspace:8",
    ]);
    expect(c.messages.filter((m) => m.t === "error")).toHaveLength(0);
    c.ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attaching to a group targets the base and does not move a tab session's window", async () => {
  await tmux.run(["new-session", "-d", "-s", "ws", "-x", "80", "-y", "24", "sh"]);
  await tmux.run(["new-window", "-d", "-t", "=ws", "sh"]);
  await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~tab00001"]);
  await tmux.run(["select-window", "-t", "=ws~tab00001:1"]);
  const c = await connect();
  c.send({ t: "attach", session: "ws" });
  await waitFor(() => (c.last("attached") as any)?.session === "ws", 2000, "attached to group");
  await waitFor(() => c.output().length > 0, 3000, "redraw");
  c.send({ t: "select-window", session: "ws", index: 0 });
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=ws:0", "#{window_active}"])).trim() === "1", 2000, "browser on window 0");
  // the tab session keeps its own current window
  expect((await tmux.run(["list-sessions", "-F", "#{session_name}\t#{window_index}"])).trim().split("\n"))
    .toContain("ws~tab00001\t1");
  // the sidebar shows one session with two windows
  const state = c.last("state") as any;
  expect(state.sessions.map((s: any) => s.name)).toEqual(["ws"]);
  expect(state.sessions[0].windows).toHaveLength(2);
  c.send({ t: "kill-session", session: "ws" });
  await waitFor(() => (c.last("state") as any)?.sessions.length === 0, 3000, "group gone");
  await waitFor(() => c.last("detached"), 3000, "detached");
  c.ws.close();
});

test("attaching to a group whose base is gone uses the surviving member", async () => {
  await tmux.run(["new-session", "-d", "-s", "ws", "sh"]);
  await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~tab00002"]);
  await tmux.run(["kill-session", "-t", "=ws"]);
  // The sidebar shows the surviving member's own name; the browser attaches to that.
  const shown = (await tmux.listSessions())[0].name;
  expect(shown).toBe("ws~tab00002");
  const c = await connect();
  c.send({ t: "attach", session: shown });
  await waitFor(() => (c.last("attached") as any)?.session === shown, 2000, "attached via member");
  await waitFor(() => c.output().length > 0, 3000, "redraw via member");
  expect(c.messages.filter((m) => m.t === "error")).toHaveLength(0);
  // A failed `tmux attach-session -t =ws` also produces "attached" (sent
  // before the PTY is confirmed live) and its error text arrives as pty
  // output, so the assertions above pass even without the fix. Confirm a
  // real attach happened: the surviving member's attached count flips to 1.
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 1, 3000, "member actually attached");
  expect(c.output()).not.toContain("can't find session");
  c.ws.close();
});

test("closing the socket while an attach is resolving leaves no phantom client", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  // Race the resolution several times: send attach and close immediately.
  for (let i = 0; i < 5; i++) {
    const c = await connect();
    await waitFor(() => c.last("state"));
    c.send({ t: "attach", session: "s" });
    c.ws.close();
  }
  await Bun.sleep(150); // long enough for a phantom attach to register
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 0, 3000, "no phantom");
  // A phantom can register late; the final word is a hard check after a settle.
  await Bun.sleep(300);
  expect((await tmux.listSessions())[0]?.attached).toBe(0);
});

test("a newer attach supersedes an older one still resolving", async () => {
  await tmux.run(["new-session", "-d", "-s", "a", "sh"]);
  await tmux.run(["new-session", "-d", "-s", "b", "sh"]);
  const c = await connect();
  await waitFor(() => c.last("state"));
  c.send({ t: "attach", session: "a" });
  c.send({ t: "attach", session: "b" });
  await waitFor(() => c.messages.some((m) => m.t === "attached"), 2000, "some attached");
  await waitFor(async () => (await tmux.listSessions()).find((s) => s.name === "b")?.attached === 1, 3000, "b attached");
  const sessions = await tmux.listSessions();
  expect(sessions.find((s) => s.name === "a")?.attached).toBe(0);
  const attachedMsgs = c.messages.filter((m) => m.t === "attached") as any[];
  expect(attachedMsgs.at(-1).session).toBe("b");
  c.ws.close();
});

test("stop() detaches every client and leaves no in-flight attach behind", async () => {
  await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
  const srv = createServer({ host: "127.0.0.1", port: 0, socketName: SOCKET, pollMs: 200 });
  const c = await connect(srv.port);
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"), 2000, "attached");
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 1, 3000, "client attached");
  srv.stop();
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 0, 3000, "detached by stop");
  expect(await tmux.hasSession("s")).toBe(true);
  c.ws.close();
});

test("a failing cmux mirror surfaces a toast but the tmux command still succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-viewer-mirror-bad-"));
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh\necho "cmux is not running" >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  const mirror = createCmuxMirror({ cmuxBin: bin, socketPath: "/tmp/fake.sock" });
  const srv = createServer({ host: "127.0.0.1", port: 0, socketName: SOCKET, pollMs: 200, mirror });
  try {
    const c = await connect(srv.port);
    await waitFor(() => c.last("state"));
    c.send({ t: "new-session", name: "lonely" });
    const err = await waitFor(() => c.last("error"), 2000, "mirror error toast");
    expect((err as any).message).toMatch(/cmux is not running/);
    expect(await tmux.hasSession("lonely")).toBe(true);
    c.ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
