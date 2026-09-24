import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun-pty";
import { attachSession } from "../src/server/pty";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-guard";
const tmux = new Tmux(SOCKET);
const SCRIPT = join(import.meta.dir, "..", "scripts", "cmux-tmux-guard.zsh");
let dir: string;
let ptys: { kill(): void }[] = [];

/** Run a zsh snippet with the guard sourced; returns trimmed stdout. */
async function zsh(snippet: string, env: Record<string, string> = {}, cwd = dir): Promise<string> {
  const proc = Bun.spawn(["zsh", "-c", `source "${SCRIPT}"; ${snippet}`], {
    cwd,
    stdout: "pipe", stderr: "pipe",
    // never "": the guard reads ${MUXNEXUS_TMUX_SOCKET:-$HOME/.cmux/...}, and an
    // empty value would point a stray guard run at the user's real tmux server.
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MUXNEXUS_TMUX_SOCKET: join(dir, "unused.sock"), ...env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`zsh exited ${code}: ${err}`);
  return out.trim();
}

/** The `-S` path of this test's `-L` server, read through an existing session. */
async function sockOf(session: string): Promise<string> {
  const path = (await tmux.run(["display-message", "-p", "-t", `=${session}:0`, "#{socket_path}"])).trim();
  expect(path).toContain(SOCKET); // never let a guard run reach the user's tmux
  return path;
}

/** Run the whole guard in a PTY (it ends with a blocking `attach-session`). */
function guardPty(sock: string, extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "TMUX") env[k] = v;
  env.TERM = "xterm-256color";
  env.PATH = `${dir}:${process.env.PATH}`;
  env.MUXNEXUS_TMUX_SOCKET = sock;
  Object.assign(env, extra);
  const pty = spawn("zsh", ["-c", `source "${SCRIPT}"; muxnexus_tmux_guard`], {
    name: "xterm-256color", cols: 80, rows: 24, env, cwd: dir,
  });
  ptys.push({ kill: () => { try { pty.kill(); } catch { /* already gone */ } } });
  return pty;
}

/** `#{session_name}\t#{window_index}` for every session. */
async function currentWindows(): Promise<string[]> {
  return (await tmux.run(["list-sessions", "-F", "#{session_name}\t#{window_index}"])).trim().split("\n");
}

/** Rewrite the fake `cmux` on PATH so a test can change what workspaces report. */
function writeCmuxStub(workspaces: object[]) {
  writeFileSync(join(dir, "cmux"), `#!/bin/sh
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '${JSON.stringify({ workspaces })}'
fi
`);
  chmodSync(join(dir, "cmux"), 0o755);
}

/** WS-1 has a custom title; WS-2 and WS-3 are untitled, as cmux leaves them. */
const DEFAULT_WORKSPACES = [
  { id: "WS-1", custom_title: "My Project", has_custom_title: true },
  { id: "WS-2", custom_title: null, has_custom_title: false },
  { id: "WS-3", custom_title: null, has_custom_title: false },
];

beforeEach(async () => {
  await tmux.killServer();
  dir = mkdtempSync(join(tmpdir(), "muxnexus-guard-"));
  writeCmuxStub(DEFAULT_WORKSPACES);
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
  const sock = await sockOf("ws");
  const pick = () => zsh(`muxnexus_pick_window "${sock}" ws`);
  expect(await pick()).toBe("0");                       // nobody attached: lowest window
  // a tab session attached on window 0
  await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~t1"]);
  await tmux.run(["select-window", "-t", "=ws~t1:0"]);
  ptys.push(attachSession({ target: "=ws~t1", socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }));
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=ws~t1:0", "#{session_attached}"])).trim() === "1", 3000, "t1 attached");
  expect(await pick()).toBe("1");
  // second tab on window 1, third on window 2: all shown -> a new window 3 is created
  for (const [name, win] of [["ws~t2", "1"], ["ws~t3", "2"]] as const) {
    await tmux.run(["new-session", "-d", "-t", "ws", "-s", name]);
    await tmux.run(["select-window", "-t", `=${name}:${win}`]);
    ptys.push(attachSession({ target: `=${name}`, socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }));
    await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", `=${name}:0`, "#{session_attached}"])).trim() === "1", 3000, `${name} attached`);
  }
  expect(await pick()).toBe("3");
  expect((await tmux.listSessions())[0].windows).toHaveLength(4);
});

test("the guard's tab-session name uses the first 8 chars of CMUX_SURFACE_ID", async () => {
  expect(await zsh('muxnexus_tab_name ws', { CMUX_SURFACE_ID: "F6AA5D79-79C3-4556-BA76-B59700078684" })).toBe("ws~F6AA5D79");
});

test("pick_window follows the group after the base is renamed", async () => {
  await tmux.run(["new-session", "-d", "-s", "ws", "-x", "80", "-y", "24"]);
  await tmux.run(["new-window", "-d", "-t", "=ws"]); // windows 0,1
  const sock = await sockOf("ws");
  await tmux.run(["new-session", "-d", "-t", "=ws", "-s", "ws~t1"]);
  await tmux.run(["select-window", "-t", "=ws~t1:0"]);
  ptys.push(attachSession({ target: "=ws~t1", socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} }));
  await waitFor(async () => (await tmux.run(["display-message", "-p", "-t", "=ws~t1:0", "#{session_attached}"])).trim() === "1", 3000, "t1 attached");
  // tmux keeps #{session_group} at "ws"; the guard must resolve the group, not assume the name.
  await tmux.run(["rename-session", "-t", "=ws", "--", "proj"]);
  expect(await zsh(`muxnexus_pick_window "${sock}" proj`)).toBe("1");
});

test("the guard creates a base, attaches a tab session, and removes it on detach", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]); // the guard restarts the server at the same path

  guardPty(sock, { VIEWER_TMUX_SESSION: "e2e", CMUX_SURFACE_ID: "ABCDEFGH-1111" });
  await waitFor(
    async () => (await tmux.run(["display-message", "-p", "-t", "=e2e~ABCDEFGH:0", "#{session_attached}"]).catch(() => "")).trim() === "1",
    8000, "tab session attached",
  );
  expect(await tmux.hasSession("e2e")).toBe(true);
  expect((await tmux.run(["list-windows", "-t", "=e2e", "-F", "#{window_index}"])).trim().split("\n")).toEqual(["0"]);
  expect(await currentWindows()).toContain("e2e~ABCDEFGH\t0");

  // Detaching the client ends the guard's blocking attach; its cleanup kills the tab session.
  await tmux.run(["detach-client", "-s", "=e2e~ABCDEFGH"]);
  await waitFor(async () => !(await tmux.hasSession("e2e~ABCDEFGH")), 8000, "tab session cleaned up");
  expect(await tmux.hasSession("e2e")).toBe(true);
  expect((await tmux.run(["list-windows", "-t", "=e2e", "-F", "#{window_index}"])).trim().split("\n")).toEqual(["0"]);
});

test("the guard rejoins an orphaned group instead of starting a fresh base", async () => {
  await tmux.run(["new-session", "-d", "-s", "ws", "-x", "80", "-y", "24"]);
  await tmux.run(["new-window", "-d", "-t", "=ws"]); // windows 0,1
  await tmux.run(["new-session", "-d", "-t", "=ws", "-s", "ws~t1"]);
  const sock = await sockOf("ws");
  await tmux.run(["kill-session", "-t", "=ws"]); // orphaned group: tabs alive, base gone

  guardPty(sock, { VIEWER_TMUX_SESSION: "ws", CMUX_SURFACE_ID: "ORPHAN01-2222" });
  await waitFor(async () => await tmux.hasSession("ws"), 8000, "base recreated");
  await waitFor(
    async () => (await tmux.run(["display-message", "-p", "-t", "=ws~ORPHAN01:0", "#{session_attached}"]).catch(() => "")).trim() === "1",
    8000, "new tab attached",
  );
  // the recreated base shares the orphan's windows rather than owning a lone new one
  expect((await tmux.run(["list-windows", "-t", "=ws", "-F", "#{window_index}"])).trim().split("\n")).toEqual(["0", "1"]);
  const rows = (await tmux.run(["list-sessions", "-F", "#{session_name}\t#{session_group}"])).trim().split("\n");
  expect(rows).toContain("ws\tws");
  expect(rows).toContain("ws~t1\tws");
});

/** Wait until a tab session of this surface id exists and has a client. */
async function waitForTab(surface: string, label: string) {
  await waitFor(
    async () =>
      (await tmux.run(["list-sessions", "-F", "#{session_name}\t#{session_attached}"]).catch(() => ""))
        .split("\n").some((r) => r.includes(`~${surface}`) && r.endsWith("\t1")),
    8000, label,
  );
}

/** Base sessions (those a workspace owns) as `name\tworkspace-id` rows. */
async function ownedSessions(): Promise<string[]> {
  return (await tmux.run(["list-sessions", "-F", "#{session_name}\t#{@muxnexus_workspace}"]))
    .trim().split("\n").filter((r) => !r.split("\t")[0].includes("~"));
}

test("two untitled workspaces in one directory get a session each, not a shared one", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);
  const dirName = dir.split("/").pop()!;

  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-2", CMUX_SURFACE_ID: "AAAAAAAA-1" });
  await waitForTab("AAAAAAAA", "first workspace attached");
  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-3", CMUX_SURFACE_ID: "BBBBBBBB-1" });
  await waitForTab("BBBBBBBB", "second workspace attached");

  // Both derive the same name from the directory, so the second must be disambiguated.
  const owned = await ownedSessions();
  expect(owned).toContain(`${dirName}\tWS-2`);
  expect(owned.length).toBe(2);
  expect(owned.some((r) => r.endsWith("\tWS-3") && r.split("\t")[0] !== dirName)).toBe(true);

  // The giveaway of the old bug: one base holding both workspaces' windows.
  expect((await tmux.run(["list-windows", "-t", `=${dirName}`, "-F", "#{window_index}"])).trim().split("\n"))
    .toEqual(["0"]);
});

test("a renamed workspace keeps its own session instead of stranding it", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);

  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "AAAAAAAA-1" });
  await waitForTab("AAAAAAAA", "first tab attached");
  expect(await tmux.hasSession("My Project")).toBe(true);
  await tmux.run(["detach-client", "-s", "=My Project~AAAAAAAA"]);
  await waitFor(async () => !(await tmux.hasSession("My Project~AAAAAAAA")), 8000, "first tab gone");

  // The user retitles the workspace in cmux; its id is unchanged.
  writeCmuxStub([{ id: "WS-1", custom_title: "Renamed Project", has_custom_title: true }]);
  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "BBBBBBBB-1" });
  await waitForTab("BBBBBBBB", "tab after rename attached");

  // One session, carrying the new name — not a second base beside the old one.
  const owned = await ownedSessions();
  expect(owned).toEqual(["Renamed Project\tWS-1"]);
  expect(await tmux.hasSession("My Project")).toBe(false);
});

test("a workspace renamed while an earlier tab is still attached still follows", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);

  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "AAAA1111-0" });
  await waitForTab("AAAA1111", "first tab attached");
  expect(await tmux.hasSession("My Project")).toBe(true);

  // Renamed in cmux while that first tab is still open and attached.
  writeCmuxStub([{ id: "WS-1", custom_title: "Renamed Project", has_custom_title: true }]);
  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "BBBB2222-0" });
  await waitForTab("BBBB2222", "second tab attached");

  expect(await ownedSessions()).toEqual(["Renamed Project\tWS-1"]);
});

test("a failed title lookup never renames the session to the directory", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);

  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "AAAA1111-0" });
  await waitForTab("AAAA1111", "first tab attached");
  expect(await tmux.hasSession("My Project")).toBe(true);

  // cmux hiccups: the CLI is there but answers with nothing usable.
  writeFileSync(join(dir, "cmux"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(dir, "cmux"), 0o755);
  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "BBBB2222-0" });
  await waitForTab("BBBB2222", "second tab attached");

  // The session keeps its real name instead of being renamed to the temp dir.
  expect(await ownedSessions()).toEqual(["My Project\tWS-1"]);
  expect(await tmux.hasSession(dir.split("/").pop()!)).toBe(false);
});

/** The value a pane in this window would start with, as tmux would hand it over. */
async function sessionEnv(session: string, name: string): Promise<string> {
  const out = await tmux.run(["show-environment", "-t", `=${session}`, name]).catch(() => "");
  const line = out.trim();
  return line.startsWith(`${name}=`) ? line.slice(name.length + 1) : "";
}

test("a tab publishes its own cmux identity, so a later window is not stamped with the first tab's", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);

  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "AAAA1111-0", CMUX_PANEL_ID: "PANEL-A" });
  await waitForTab("AAAA1111", "first tab attached");
  expect(await sessionEnv("My Project", "CMUX_SURFACE_ID")).toBe("AAAA1111-0");
  expect(await sessionEnv("My Project", "CMUX_PANEL_ID")).toBe("PANEL-A");

  // A second tab of the same workspace: the session must now describe *it*,
  // otherwise `cmux` in its window would resolve to the first tab's surface.
  guardPty(sock, { CMUX_WORKSPACE_ID: "WS-1", CMUX_SURFACE_ID: "BBBB2222-0", CMUX_PANEL_ID: "PANEL-B" });
  await waitForTab("BBBB2222", "second tab attached");
  expect(await sessionEnv("My Project", "CMUX_SURFACE_ID")).toBe("BBBB2222-0");
  expect(await sessionEnv("My Project", "CMUX_PANEL_ID")).toBe("PANEL-B");
});

test("a tab with no cmux identity clears any stale one left in the session", async () => {
  await tmux.run(["new-session", "-d", "-s", "__probe"]);
  const sock = await sockOf("__probe");
  await tmux.run(["kill-session", "-t", "=__probe"]);

  guardPty(sock, { VIEWER_TMUX_SESSION: "plain", CMUX_SURFACE_ID: "STALE-1", CMUX_SURFACE_ID_SET: "1" });
  await waitForTab("STALE-1".slice(0, 8), "cmux tab attached");
  expect(await sessionEnv("plain", "CMUX_SURFACE_ID")).toBe("STALE-1");

  // The browser opens a window on the same session: no cmux tab, so no identity.
  guardPty(sock, { VIEWER_TMUX_SESSION: "plain", CMUX_SURFACE_ID: "", CMUX_SURFACE_ID_SET: "" });
  await waitFor(async () => (await sessionEnv("plain", "CMUX_SURFACE_ID")) === "", 8000, "identity cleared");
  expect(await sessionEnv("plain", "CMUX_SURFACE_ID")).toBe("");
});
