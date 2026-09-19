import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachSession, type PtyHandle } from "../src/server/pty";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-guard";
const tmux = new Tmux(SOCKET);
const SCRIPT = join(import.meta.dir, "..", "scripts", "cmux-tmux-guard.zsh");
let dir: string;
let ptys: PtyHandle[] = [];

/** Run a zsh snippet with the guard sourced; returns trimmed stdout. */
async function zsh(snippet: string, env: Record<string, string> = {}, cwd = dir): Promise<string> {
  const proc = Bun.spawn(["zsh", "-c", `source "${SCRIPT}"; ${snippet}`], {
    cwd,
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MUXNEXUS_TMUX_SOCKET: "", ...env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`zsh exited ${code}: ${err}`);
  return out.trim();
}

beforeEach(async () => {
  await tmux.killServer();
  dir = mkdtempSync(join(tmpdir(), "muxnexus-guard-"));
  // fake cmux: one workspace with a custom title, id WS-1
  writeFileSync(join(dir, "cmux"), `#!/bin/sh
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '{"workspaces":[{"id":"WS-1","custom_title":"My Project","has_custom_title":true},{"id":"WS-2","custom_title":null,"has_custom_title":false}]}'
fi
`);
  chmodSync(join(dir, "cmux"), 0o755);
});
afterEach(async () => {
  for (const p of ptys) p.kill();
  ptys = [];
  await tmux.killServer();
  rmSync(dir, { recursive: true, force: true });
});

test("base name: VIEWER_TMUX_SESSION wins, then the workspace title, then the directory", async () => {
  expect(await zsh("muxnexus_base_name", { VIEWER_TMUX_SESSION: "from.viewer:x", CMUX_WORKSPACE_ID: "WS-1" })).toBe("from_viewer_x");
  expect(await zsh("muxnexus_base_name", { VIEWER_TMUX_SESSION: "", CMUX_WORKSPACE_ID: "WS-1" })).toBe("My Project");
  expect(await zsh("muxnexus_base_name", { VIEWER_TMUX_SESSION: "", CMUX_WORKSPACE_ID: "WS-2" })).toBe(dir.split("/").pop()!);
  expect(await zsh("muxnexus_base_name", { VIEWER_TMUX_SESSION: "", CMUX_WORKSPACE_ID: "" })).toBe(dir.split("/").pop()!);
  // At the filesystem root the basename is empty; tmux would accept "" as a name, which nothing can target.
  expect(await zsh("muxnexus_base_name", { VIEWER_TMUX_SESSION: "", CMUX_WORKSPACE_ID: "" }, "/")).toBe("root");
});

test("pick_window adopts the lowest window no attached tab shows, else creates one", async () => {
  await tmux.run(["new-session", "-d", "-s", "ws", "-x", "80", "-y", "24"]);
  await tmux.run(["new-window", "-d", "-t", "=ws"]);
  await tmux.run(["new-window", "-d", "-t", "=ws"]); // windows 0,1,2
  const sock = await tmux.run(["display-message", "-p", "-t", "=ws:0", "#{socket_path}"]).then((s) => s.trim());
  const pick = () => zsh(`muxnexus_pick_window "${sock}" ws`);
  expect(await pick()).toBe("0");                       // nobody attached: lowest window
  // a tab session attached on window 0
  await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~t1"]);
  await tmux.run(["select-window", "-t", "=ws~t1:0"]);
  ptys.push(attachSession({ session: "ws~t1", socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }));
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=ws~t1:0", "#{session_attached}"])).trim() === "1", 3000, "t1 attached");
  expect(await pick()).toBe("1");
  // second tab on window 1, third on window 2: all shown -> a new window 3 is created
  for (const [name, win] of [["ws~t2", "1"], ["ws~t3", "2"]] as const) {
    await tmux.run(["new-session", "-d", "-t", "ws", "-s", name]);
    await tmux.run(["select-window", "-t", `=${name}:${win}`]);
    ptys.push(attachSession({ session: name, socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }));
    await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", `=${name}:0`, "#{session_attached}"])).trim() === "1", 3000, `${name} attached`);
  }
  expect(await pick()).toBe("3");
  expect((await tmux.listSessions())[0].windows).toHaveLength(4);
});

test("the guard's tab-session name uses the first 8 chars of CMUX_SURFACE_ID", async () => {
  expect(await zsh('muxnexus_tab_name ws', { CMUX_SURFACE_ID: "F6AA5D79-79C3-4556-BA76-B59700078684" })).toBe("ws~F6AA5D79");
});
