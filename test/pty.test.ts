import { afterEach, beforeEach, expect, test } from "bun:test";
import { attachSession } from "../src/server/pty";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-pty";
const tmux = new Tmux(SOCKET);

beforeEach(async () => {
  await tmux.killServer();
  // `sh` gives a deterministic shell with no rc files.
  await tmux.run(["new-session", "-d", "-s", "s", "-x", "80", "-y", "24", "sh"]);
});
afterEach(async () => { await tmux.killServer(); });

test("attaches, forwards input and output", async () => {
  let out = "";
  const exits: number[] = [];
  const pty = attachSession({
    target: "=s", socketName: SOCKET, cols: 100, rows: 30,
    onData: (d) => { out += d; },
    onExit: (c) => { exits.push(c); },
  });
  await waitFor(() => out.length > 0, 3000, "initial redraw");
  pty.write("echo PTY_MARK_$((40+2))\r");
  await waitFor(() => out.includes("PTY_MARK_42"), 3000, "echo output");
  expect(exits).toEqual([]);
  pty.kill();
  await waitFor(() => exits.length === 1, 3000, "exit callback");
  // Session must survive the client leaving.
  expect(await tmux.hasSession("s")).toBe(true);
});

test("resize propagates to the tmux window", async () => {
  const pty = attachSession({
    target: "=s", socketName: SOCKET, cols: 100, rows: 30,
    onData: () => {}, onExit: () => {},
  });
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=s:0", "#{window_width}"])).trim() === "100", 3000, "initial width");
  pty.resize(120, 40);
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=s:0", "#{window_width}"])).trim() === "120", 3000, "resized width");
  pty.kill();
});

test("onExit fires once when the session is killed underneath the client", async () => {
  const exits: number[] = [];
  const pty = attachSession({
    target: "=s", socketName: SOCKET, cols: 80, rows: 24,
    onData: () => {}, onExit: (c) => { exits.push(c); },
  });
  await waitFor(() => (async () => (await tmux.listSessions())[0]?.attached === 1)(), 3000, "client attached");
  await tmux.killSession("s");
  await waitFor(() => exits.length === 1, 3000, "exit after kill-session");
  expect(pty.exited).toBe(true);
  pty.kill(); // must be a no-op, not a throw
  await Bun.sleep(100);
  expect(exits).toHaveLength(1);
});
