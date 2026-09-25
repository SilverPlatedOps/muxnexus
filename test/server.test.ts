import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { ServerMessage } from "../src/shared/protocol";
import { allowedHostList, createServer, hostAllowed, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

beforeAll(() => { server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 }); });
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

test("a session tagged with a profile's name starts on that profile", async () => {
  const home = homedir();
  const srv = createServer({
    hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200,
    profiles: () => [join(home, ".claude"), join(home, ".claude-work")],
  });
  try {
    const c = await connect(srv.port);
    await waitFor(() => c.last("state"));
    c.send({ t: "new-session", name: "[Work] Voucher" });
    c.send({ t: "new-session", name: "[Personal] Notes" });
    c.send({ t: "new-session", name: "Debug" });
    await waitFor(() => (c.last("state") as any)?.sessions.length === 3, 2000, "three sessions");
    const env = async (name: string) =>
      (await tmux.run(["show-environment", "-t", await tmux.target(name), "CLAUDE_CONFIG_DIR"]).catch(() => "")).trim();
    expect(await env("[Work] Voucher")).toBe(`CLAUDE_CONFIG_DIR=${join(home, ".claude-work")}`);
    // The default profile is left unset rather than set to ~/.claude: Claude
    // Code keys the default's credentials on the variable being absent.
    expect(await env("[Personal] Notes")).toBe("");
    expect(await env("Debug")).toBe("");
    c.ws.close();
  } finally {
    srv.stop();
  }
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
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketPath: path, pollMs: 200 });
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
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200, mirror });
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

test("attaching to a dotted name reaches that session, not the one its prefix names", async () => {
  await tmux.newSession("api");
  await tmux.newSession("api.v2");
  const c = await connect();
  c.send({ t: "attach", session: "api.v2" });
  await waitFor(() => (c.last("attached") as any)?.session === "api.v2", 2000, "attached");
  const clients = await waitFor(async () => (await tmux.run(["list-clients", "-F", "#{session_name}"])).trim(), 3000, "client");
  expect(clients).toBe("api.v2");
  c.ws.close();
});

// ---- renaming the attached session ----
// The PTY follows a rename on its own -- tmux clients track the session, not its
// name -- but everything else addressed the old name until the row was clicked.

/** Index of the first message matching `pred`, or -1. */
const indexOf = (c: { messages: ServerMessage[] }, pred: (m: any) => boolean) => c.messages.findIndex(pred);

test("renaming the attached session from the browser moves the attachment to the new name", async () => {
  await tmux.run(["new-session", "-d", "-s", "old", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "old" });
  await waitFor(() => (c.last("attached") as any)?.session === "old", 2000, "attached");
  c.send({ t: "rename-session", session: "old", name: "new" });
  await waitFor(() => (c.last("renamed") as any)?.session === "new", 2000, "renamed");
  // before any state naming it, so the client never paints a list without its session
  const renamedAt = indexOf(c, (m) => m.t === "renamed");
  const stateAt = indexOf(c, (m) => m.t === "state" && m.sessions.some((s: any) => s.name === "new"));
  expect(renamedAt).toBeLessThan(stateAt);
  // and the new name is the one that works now
  c.send({ t: "new-window", session: "new" });
  await waitFor(() => (c.last("state") as any)?.sessions.find((s: any) => s.name === "new")?.windows.length === 2, 2000, "window");
  expect(c.messages.filter((m) => m.t === "error")).toHaveLength(0);
  c.ws.close();
});

test("a rename made outside muxnexus reaches the attached client on the next poll", async () => {
  await tmux.run(["new-session", "-d", "-s", "before", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "before" });
  await waitFor(() => c.last("attached"), 2000, "attached");
  await tmux.run(["rename-session", "-t", "=before:", "after"]); // cmux, or C-b $
  await waitFor(() => (c.last("renamed") as any)?.session === "after", 2000, "renamed by poll");
  c.ws.close();
});

test("detaching after a rename says the client exited, not that the session was killed", async () => {
  await tmux.run(["new-session", "-d", "-s", "first", "sh"]);
  const c = await connect();
  c.send({ t: "attach", session: "first" });
  await waitFor(() => c.last("attached"), 2000, "attached");
  await waitFor(() => c.output().length > 0, 3000, "redraw");
  await tmux.run(["rename-session", "-t", "=first:", "second"]);
  await tmux.run(["detach-client", "-s", "=second:"]);
  const d = await waitFor(() => c.last("detached"), 3000, "detached");
  expect((d as any).reason).toBe("exited");
  c.ws.close();
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
  const first = (await tmux.run(["display-message", "-p", "-t", "=ws:0", "#{window_id}"])).trim();
  c.send({ t: "select-window", session: "ws", id: first });
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
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 });
  const c = await connect(srv.port);
  c.send({ t: "attach", session: "s" });
  await waitFor(() => c.last("attached"), 2000, "attached");
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 1, 3000, "client attached");
  srv.stop();
  await waitFor(async () => (await tmux.listSessions())[0]?.attached === 0, 3000, "detached by stop");
  expect(await tmux.hasSession("s")).toBe(true);
  c.ws.close();
});

test("killing a stamped session closes its own workspace, not one that shares its name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-viewer-mirror-kill-"));
  const log = join(dir, "calls.log");
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh
printf '%s\n' "$*" >> "${log}"
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '{"workspaces":[{"custom_title":"shared","ref":"workspace:3","id":"A"},{"custom_title":"renamed in cmux","ref":"workspace:4","id":"B"}]}'
fi
`);
  chmodSync(bin, 0o755);
  const readLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const mirror = createCmuxMirror({ cmuxBin: bin, socketPath: "/tmp/fake.sock", cwd: "/tmp" });
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200, mirror });
  try {
    await tmux.newSession("shared");
    await tmux.run(["set-option", "-t", "=shared:", "@muxnexus_workspace", "B"]);
    const c = await connect(srv.port);
    await waitFor(() => c.last("state"));
    c.send({ t: "kill-session", session: "shared" });
    await waitFor(() => readLog().includes("workspace close"), 2000, "close logged");
    expect(readLog()).toContain("workspace close workspace:4");
    expect(readLog()).not.toContain("workspace close workspace:3");
    c.ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing cmux mirror surfaces a toast but the tmux command still succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-viewer-mirror-bad-"));
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh\necho "cmux is not running" >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  const mirror = createCmuxMirror({ cmuxBin: bin, socketPath: "/tmp/fake.sock" });
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200, mirror });
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

// ---- Host header allowlist ----
// Bun's dev server blocks any Host it does not recognise, which is every name a
// phone reaches this machine by. We turn that off and gate the WebSocket
// ourselves; these cover what the replacement must accept and refuse.

test("hostAllowed accepts the bound host with or without a port", () => {
  const allowed = allowedHostList(["100.101.102.103"]);
  expect(hostAllowed("100.101.102.103:7681", allowed)).toBe(true);
  expect(hostAllowed("100.101.102.103", allowed)).toBe(true);
});

test("hostAllowed accepts loopback and a MagicDNS name given explicitly", () => {
  const allowed = allowedHostList(["100.101.102.103"], ["macbook.tail1234ab.ts.net", "macbook"]);
  for (const h of ["localhost:7681", "127.0.0.1:7681", "[::1]:7681", "macbook.tail1234ab.ts.net:7681", "macbook:7681"]) {
    expect(hostAllowed(h, allowed)).toBe(true);
  }
});

test("hostAllowed refuses a rebound host even though its Origin would match", () => {
  // DNS rebinding: the attacker serves evil.example:7681 and points it at this
  // machine, so Origin and Host agree and the same-origin check alone passes.
  const allowed = allowedHostList(["100.101.102.103"]);
  expect(hostAllowed("evil.example:7681", allowed)).toBe(false);
  expect(hostAllowed(null, allowed)).toBe(false);
  expect(hostAllowed("", allowed)).toBe(false);
});

test("hostAllowed ignores case and bracketed IPv6", () => {
  const allowed = allowedHostList(["::1"], ["MacBook.Tail1234ab.TS.net"]);
  expect(hostAllowed("macbook.tail1234ab.ts.net", allowed)).toBe(true);
  expect(hostAllowed("[::1]:7681", allowed)).toBe(true);
});

test("serves the page to a host Bun's dev server would have blocked", async () => {
  const index = (await import("../src/client/index.html")).default;
  const withPage = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000, index });
  try {
    const res = await fetch(`http://127.0.0.1:${withPage.port}/`, { headers: { Host: "macbook.tail1234ab.ts.net" } });
    const body = await res.text();
    expect(body).not.toContain("Blocked:");
    expect(body).toContain("<!doctype html>");
  } finally {
    withPage.stop();
  }
});

test("rejects a WebSocket upgrade whose Host is not ours, matching Origin or not", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Host: "evil.example", Origin: "http://evil.example" },
  } as any);
  let opened = false;
  ws.onopen = () => { opened = true; };
  await new Promise<void>((res) => { ws.onclose = () => res(); ws.onerror = () => res(); });
  expect(opened).toBe(false);
});

test("allowedHostList answers to every address it is bound to", () => {
  const allowed = allowedHostList(["100.101.102.103", "127.0.0.1"], ["mux.example.com"]);
  expect(hostAllowed("100.101.102.103:7681", allowed)).toBe(true);
  expect(hostAllowed("localhost:7681", allowed)).toBe(true);
  expect(hostAllowed("mux.example.com", allowed)).toBe(true);
  expect(hostAllowed("192.168.1.9:7681", allowed)).toBe(false);
});

test("listens on every requested address, on one shared port", async () => {
  const both = createServer({ hosts: ["127.0.0.1", "::1"], port: 0, socketName: SOCKET, pollMs: 10_000 });
  try {
    for (const url of [`http://127.0.0.1:${both.port}/nope`, `http://[::1]:${both.port}/nope`]) {
      const res = await fetch(url);
      expect(res.status).toBe(404); // reached our handler, so the listener is up
    }
  } finally {
    both.stop();
  }
});

// ---- ordering round-trip ----
// The whole point of sending the full order rather than one move: what comes
// back out of tmux must be exactly what went in, with no server-side guessing.

const names = (m: ServerMessage | undefined) => (m && m.t === "state" ? m.sessions.map((s) => s.name) : null);

test("reorder-sessions stamps @muxnexus_order and the next state comes back in that order", async () => {
  for (const n of ["alpha", "beta", "gamma"]) await tmux.newSession(n);
  const c = await connect();
  await waitFor(() => c.last("state"), 2000, "state");

  c.send({ t: "reorder-sessions", names: ["gamma", "alpha", "beta"] });
  await waitFor(() => {
    const n = names(c.last("state"));
    return n !== null && n[0] === "gamma";
  }, 3000, "reordered state");
  expect(names(c.last("state"))).toEqual(["gamma", "alpha", "beta"]);

  // and it survives a fresh client, because the order lives in tmux not the page
  const fresh = await connect();
  const state = await waitFor(() => fresh.last("state"), 2000, "state for fresh client");
  expect(names(state)).toEqual(["gamma", "alpha", "beta"]);
  c.ws.close();
  fresh.ws.close();
});

test("a session with no stamp sorts after the stamped ones", async () => {
  for (const n of ["alpha", "beta"]) await tmux.newSession(n);
  const c = await connect();
  await waitFor(() => c.last("state"), 2000, "state");
  c.send({ t: "reorder-sessions", names: ["beta", "alpha"] });
  await waitFor(() => names(c.last("state"))?.[0] === "beta", 3000, "reordered");

  await tmux.newSession("zulu"); // made outside muxnexus, never stamped
  await waitFor(() => names(c.last("state"))?.length === 3, 3000, "third session");
  expect(names(c.last("state"))).toEqual(["beta", "alpha", "zulu"]);
  c.ws.close();
});

test("reorder-windows rearranges tabs and keeps each window's stamped surface", async () => {
  await tmux.newSession("wins");
  await tmux.run(["rename-window", "-t", "=wins:0", "one"]);
  await tmux.newWindow("wins");
  await tmux.newWindow("wins");
  const live = (await tmux.run(["list-windows", "-t", "=wins:", "-F", "#{window_id}"])).trim().split("\n");
  for (const id of live) await tmux.run(["set-option", "-w", "-t", `=wins:${id}`, "@muxnexus_surface", `SURF-${id}`]);

  const c = await connect();
  await waitFor(() => c.last("state"), 2000, "state");
  const wanted = [live[2], live[0], live[1]];
  c.send({ t: "reorder-windows", session: "wins", ids: wanted });

  await waitFor(async () => {
    const out = await tmux.run(["list-windows", "-t", "=wins:", "-F", "#{window_id}"]);
    return out.trim().split("\n")[0] === live[2];
  }, 3000, "windows swapped");

  const out = await tmux.run(["list-windows", "-t", "=wins:", "-F", "#{@muxnexus_surface}"]);
  expect(out.trim().split("\n")).toEqual(wanted.map((id) => `SURF-${id}`));
  c.ws.close();
});

test("window messages reject anything but window ids", async () => {
  await tmux.newSession("w");
  const c = await connect();
  await waitFor(() => c.last("state"), 2000, "state");
  c.send({ t: "kill-window", session: "w", id: 0 });
  await waitFor(() => c.last("error"), 2000, "error");
  c.send({ t: "reorder-windows", session: "w", ids: [0] });
  await waitFor(() => c.messages.filter((m) => m.t === "error").length === 2, 2000, "second error");
  expect(c.messages.filter((m) => m.t === "error").map((m: any) => m.message)).toEqual([
    "invalid kill-window",
    "invalid reorder-windows",
  ]);
  expect((c.last("state") as any).sessions[0].windows).toHaveLength(1);
  c.ws.close();
});

// ---- polling cost ----
// A server left running in the background must not keep reading tmux, cmux, the
// Keychain and the usage API for nobody. And one slow read must not overlap the
// next, or an older answer can be broadcast after a newer one.

/** A fake cmux that logs when each call starts and ends, and takes `delay` seconds. */
function slowCmux(dir: string, delay: string) {
  const log = join(dir, "calls.log");
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh
printf 'start %s\n' "$*" >> "${log}"
sleep ${delay}
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '{"workspaces":[{"custom_title":"w","ref":"workspace:1","id":"W"}]}'
fi
printf 'end %s\n' "$*" >> "${log}"
`);
  chmodSync(bin, 0o755);
  return { bin, read: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

test("nothing is polled while no browser is connected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-viewer-idle-"));
  const cmux = slowCmux(dir, "0");
  let reads = 0;
  const usage = { read: async () => { reads++; return []; } };
  await tmux.newSession("w");
  await tmux.run(["set-option", "-t", "=w:", "@muxnexus_workspace", "W"]); // makes every poll ask cmux
  const mirror = createCmuxMirror({ cmuxBin: cmux.bin, socketPath: "/tmp/fake.sock" });
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 30, mirror, usage, usageMs: 30 });
  try {
    await Bun.sleep(400);
    expect(cmux.read()).toBe("");
    expect(reads).toBe(1); // the one read at startup, so the first page is not blank
    const c = await connect(srv.port);
    await waitFor(() => cmux.read().includes("workspace list"), 2000, "polling resumed");
    await waitFor(() => reads > 1, 2000, "usage resumed");
    c.ws.close();
  } finally {
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow poll is never overlapped by the next one", async () => {
  // A mirror whose title lookup is slow and counts how many run at once.
  let running = 0;
  let most = 0;
  let calls = 0;
  const mirror = {
    sessionCreated: async () => {},
    sessionRenamed: async () => {},
    sessionKilled: async () => {},
    surfaceTitles: async () => new Map<string, string>(),
    workspaceTitles: async () => {
      calls++;
      most = Math.max(most, ++running);
      await Bun.sleep(150);
      running--;
      return new Map([["W", "w"]]);
    },
  };
  await tmux.newSession("w");
  await tmux.run(["set-option", "-t", "=w:", "@muxnexus_workspace", "W"]); // makes every poll ask the mirror
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 20, mirror });
  try {
    const c = await connect(srv.port);
    c.send({ t: "new-window", session: "w" }); // a command-triggered poll on top of the timer's
    await Bun.sleep(1000);
    c.ws.close();
    expect(calls).toBeGreaterThan(2);
    expect(most).toBe(1);
  } finally {
    srv.stop();
  }
});

test("a reconnect reuses a fresh quota read instead of asking again", async () => {
  let reads = 0;
  const usage = { read: async () => { reads++; return []; } };
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000, usage, usageMs: 60_000 });
  try {
    await waitFor(() => reads === 1, 2000, "startup read");
    for (let i = 0; i < 3; i++) {
      const c = await connect(srv.port);
      await waitFor(() => c.last("usage"), 2000, "usage sent on connect");
      c.ws.close();
    }
    expect(reads).toBe(1);
  } finally {
    srv.stop();
  }
});

test("connecting after a quiet spell reads quota straight away", async () => {
  let reads = 0;
  const usage = { read: async () => { reads++; return []; } };
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000, usage, usageMs: 150 });
  try {
    await waitFor(() => reads === 1, 2000, "startup read");
    await Bun.sleep(400); // stale now, and nobody was connected to refresh it
    expect(reads).toBe(1);
    const c = await connect(srv.port);
    await waitFor(() => reads === 2, 500, "read on connect");
    c.ws.close();
  } finally {
    srv.stop();
  }
});

/** Sessions tmux has, views included, by id: listSessions hides the views. */
const allSessionIds = async () => (await tmux.run(["list-sessions", "-F", "#{session_id}"])).split("\n").filter(Boolean);

async function twoShells() {
  await tmux.run(["new-session", "-d", "-s", "s", "-x", "80", "-y", "24", "sh"]);
  await tmux.run(["new-window", "-d", "-t", "=s:", "sh"]);
  const [first, second] = (await tmux.run(["list-windows", "-t", "=s:", "-F", "#{window_id}"])).split("\n").filter(Boolean);
  return { first, second };
}

test("attach-view types into its own window, and the main pane keeps its own", async () => {
  const w = await twoShells();
  const main = await connect();
  main.send({ t: "attach", session: "s" });
  await waitFor(() => main.last("attached"), 2000, "main attached");
  const side = await connect();
  side.send({ t: "resize", cols: 80, rows: 24 });
  side.send({ t: "attach-view", session: "s", id: w.second });
  await waitFor(() => side.last("attached"), 3000, "view attached");
  await waitFor(() => side.output().length > 0, 3000, "view redraw");
  side.sendBytes("echo VIEW_MARK_$((2+2))\r");
  const shown = (id: string) => tmux.run(["capture-pane", "-p", "-t", id]);
  await waitFor(async () => (await shown(w.second)).includes("VIEW_MARK_4"), 3000, "typed into the view's window");
  expect(await shown(w.first)).not.toContain("VIEW_MARK_4");
  expect((await tmux.run(["display-message", "-p", "-t", "=s:", "#{window_id}"])).trim()).toBe(w.first);
  // The sidebar still sees one session, attached by one client: the view is neither.
  const s = (await tmux.listSessions()).find((x) => x.name === "s");
  expect(s?.attached).toBe(1);
  main.ws.close();
  side.ws.close();
});

test("closing a view's socket removes the view and keeps every window", async () => {
  const w = await twoShells();
  const before = await allSessionIds();
  const side = await connect();
  side.send({ t: "attach-view", session: "s", id: w.second });
  await waitFor(() => side.last("attached"), 3000, "view attached");
  expect((await allSessionIds()).length).toBe(before.length + 1);
  side.ws.close();
  await waitFor(async () => (await allSessionIds()).length === before.length, 3000, "view gone");
  expect((await tmux.run(["list-windows", "-t", "=s:", "-F", "#{window_id}"])).split("\n").filter(Boolean)).toEqual([w.first, w.second]);
});

test("closing the socket while a view is being made leaves no view behind", async () => {
  const w = await twoShells();
  const before = await allSessionIds();
  for (let i = 0; i < 5; i++) {
    const c = await connect();
    c.send({ t: "attach-view", session: "s", id: w.second });
    c.ws.close();
  }
  await Bun.sleep(300);
  await waitFor(async () => (await allSessionIds()).length === before.length, 3000, "no stray view");
});
