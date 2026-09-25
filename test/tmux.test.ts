import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutOf, orderSessions, swapPlan, Tmux, TmuxError, windowLabel } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-tmux";
const tmux = new Tmux(SOCKET);

/** tmux's own id for an exact session name, to check what target() resolved to. */
const idOf = async (name: string) =>
  (await tmux.run(["display-message", "-p", "-t", `=${name}:`, "#{session_id}"])).trim();

beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

describe("Tmux.listSessions", () => {
  test("returns [] when no server is running", async () => {
    expect(await tmux.listSessions()).toEqual([]);
  });

  test("lists a new session with its single window", async () => {
    await tmux.newSession("work");
    const sessions = await tmux.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("work");
    expect(sessions[0].attached).toBe(0);
    expect(sessions[0].windows).toHaveLength(1);
    expect(sessions[0].windows[0]).toMatchObject({ index: 0, active: true, panes: 1 });
  });

  test("reports an agent's profile, named as the quota panel names it", async () => {
    await tmux.newSession("work");
    const pane = (await tmux.run(["display-message", "-p", "-t", "=work:", "#{pane_id}"])).trim();
    const now = Math.floor(Date.now() / 1000);
    await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_agent", `done ${now} ${process.pid} /Users/me/.claude-work`]);
    const [s] = await tmux.listSessions();
    expect(s.windows[0].agent).toMatchObject({ state: "done", profile: "work" });
  });

  test("reports the git checkout an agent works in", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "mxn-checkout-")));
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(join(repo, "src"));
      await tmux.run(["new-session", "-d", "-s", "work", "-c", join(repo, "src")]);
      const pane = (await tmux.run(["display-message", "-p", "-t", "=work:", "#{pane_id}"])).trim();
      await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_agent", `done ${Math.floor(Date.now() / 1000)} ${process.pid}`]);
      const [s] = await tmux.listSessions();
      expect(s.windows[0].agent?.checkout).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("handles names with spaces and groups windows by session", async () => {
    await tmux.newSession("a b");
    await tmux.newSession("c");
    await tmux.newWindow("a b");
    const sessions = await tmux.listSessions();
    const ab = sessions.find((s) => s.name === "a b")!;
    const c = sessions.find((s) => s.name === "c")!;
    expect(ab.windows.map((w) => w.index)).toEqual([0, 1]);
    expect(c.windows).toHaveLength(1);
  });
});

describe("Tmux mutators", () => {
  test("newSession rejects duplicates with tmux's message", async () => {
    await tmux.newSession("dup");
    await expect(tmux.newSession("dup")).rejects.toBeInstanceOf(TmuxError);
    await expect(tmux.newSession("dup")).rejects.toThrow(/duplicate session/);
  });

  /** Window ids of a session, in tab order. */
  const windowIds = async (name: string) =>
    (await tmux.listSessions()).find((s) => s.name === name)!.windows.map((w) => w.id);

  test("renameWindow, selectWindow, killWindow target the window by id", async () => {
    await tmux.newSession("s");
    await tmux.newWindow("s");
    await tmux.newWindow("s");
    const [, one, two] = await windowIds("s");
    await tmux.renameWindow("s", one, "renamed one");
    await tmux.selectWindow("s", one);
    await tmux.killWindow("s", two);
    const [s] = await tmux.listSessions();
    expect(s.windows.map((w) => [w.id, w.name, w.active])).toEqual([
      [expect.any(String), expect.any(String), false],
      [one, "renamed one", true],
    ]);
  });

  // An index is a slot: swap-window moves windows between them. A kill confirmed
  // against the tab you saw must not land on whatever another device moved there.
  test("killWindow follows the window after a reorder moved it to another index", async () => {
    await tmux.newSession("s");
    await tmux.newWindow("s");
    const [first, second] = await windowIds("s");
    await tmux.reorderWindows("s", [second, first]);
    expect(await windowIds("s")).toEqual([second, first]);
    await tmux.killWindow("s", first);
    expect(await windowIds("s")).toEqual([second]);
  });

  test("reorderWindows ignores a window id that is gone", async () => {
    await tmux.newSession("s");
    await tmux.newWindow("s");
    const [first, second] = await windowIds("s");
    await tmux.reorderWindows("s", ["@9999", second, first]);
    expect(await windowIds("s")).toEqual([second, first]);
  });

  test("a window action rejects anything that is not a window id", async () => {
    await tmux.newSession("s");
    await expect(tmux.killWindow("s", "0")).rejects.toThrow(/invalid window id/);
  });

  test("rename to a name starting with a dash", async () => {
    await tmux.newSession("s");
    await tmux.renameSession("s", "-dash");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["-dash"]);
    await tmux.newWindow("-dash");
    const [, second] = await windowIds("-dash");
    await tmux.renameWindow("-dash", second, "-w");
    const [session] = await tmux.listSessions();
    expect(session.windows.find((w) => w.id === second)?.name).toBe("-w");
  });

  test("renameSession and killSession", async () => {
    await tmux.newSession("old name");
    await tmux.renameSession("old name", "new name");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["new name"]);
    await tmux.killSession("new name");
    expect(await tmux.listSessions()).toEqual([]);
  });

  test("rename stamps the custom name, which is reported ahead of any title", async () => {
    await tmux.newSession("s");
    await tmux.renameWindow("s", (await windowIds("s"))[0], "user name");
    expect((await tmux.listSessions())[0].windows[0].customName).toBe("user name");
    await tmux.renameSession("s", "proj");
    const [renamed] = await tmux.listSessions();
    expect(renamed.customName).toBe("proj");
    expect(renamed.name).toBe("proj");
  });

  // tmux reads `api.v2` in a target as session `api`, window `v2`, and `a:b` as
  // session `a`, window `b` -- yet it accepts both as session names. Found live:
  // set-option on `=api.v2` stamped `api`, and kill-session could not find it.
  test("a name with '.' or ':' never reaches the session it starts with", async () => {
    await tmux.newSession("api");
    await tmux.newSession("api.v2");
    await tmux.newSession("a");
    await tmux.newSession("a:b");
    await tmux.setSessionOrder(["api.v2", "a:b", "api", "a"]);
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["api.v2", "a:b", "api", "a"]);

    await tmux.renameSession("api.v2", "api.v3");
    const byName = new Map((await tmux.listSessions()).map((s) => [s.name, s]));
    expect(byName.get("api.v3")?.customName).toBe("api.v3");
    expect(byName.get("api")?.customName).toBeUndefined();

    await tmux.newWindow("a:b");
    expect((await tmux.listSessions()).find((s) => s.name === "a:b")?.windows).toHaveLength(2);
    expect((await tmux.listSessions()).find((s) => s.name === "a")?.windows).toHaveLength(1);

    await tmux.killSession("api.v3");
    await tmux.killSession("a:b");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["api", "a"]);
  });

  test("setSessionOrder skips a name that has gone since the drag", async () => {
    await tmux.newSession("x");
    await tmux.newSession("y");
    await tmux.setSessionOrder(["y", "gone", "x"]);
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["y", "x"]);
  });

  test("hasSession", async () => {
    await tmux.newSession("here");
    expect(await tmux.hasSession("here")).toBe(true);
    expect(await tmux.hasSession("gone")).toBe(false);
  });

  test("hasSession returns false when no server is running", async () => {
    await tmux.killServer();
    expect(await tmux.hasSession("any")).toBe(false);
  });

  test("an empty name is no session, rather than a target tmux misreads", async () => {
    await tmux.newSession("s");
    expect(await tmux.hasSession("")).toBe(false);
  });
});

describe("Tmux socket selection", () => {
  test("an explicit socket path (-S) runs its own server, isolated from -L sockets", async () => {
    const path = `${tmpdir()}/cmux-viewer-test-${process.pid}.sock`;
    const byPath = new Tmux(undefined, path);
    try {
      await byPath.newSession("p");
      expect(existsSync(path)).toBe(true);
      expect((await byPath.listSessions()).map((s) => s.name)).toEqual(["p"]);
      expect(await tmux.listSessions()).toEqual([]);
    } finally {
      await byPath.killServer();
    }
  });
});

describe("Tmux session groups", () => {
  /** base with two windows, plus two grouped tab sessions viewing different windows */
  async function makeGroup() {
    await tmux.run(["new-session", "-d", "-s", "ws", "-x", "80", "-y", "24"]);
    await tmux.run(["new-window", "-d", "-t", "=ws"]);
    await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~a1b2c3d4"]);
    await tmux.run(["new-session", "-d", "-t", "ws", "-s", "ws~e5f6a7b8"]);
    await tmux.run(["select-window", "-t", "=ws~e5f6a7b8:1"]);
  }

  test("a group lists once, named after the base, with the base's windows", async () => {
    await makeGroup();
    const sessions = await tmux.listSessions();
    expect(sessions.map((s) => s.name)).toEqual(["ws"]);
    expect(sessions[0].windows.map((w) => w.index)).toEqual([0, 1]);
    expect(sessions[0].attached).toBe(0);
  });

  test("attached counts every member of the group", async () => {
    await makeGroup();
    // A detached "attach" is impossible; simulate one client via a PTY.
    const { attachSession } = await import("../src/server/pty");
    const pty = attachSession({ target: "=ws~a1b2c3d4", socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
    try {
      await waitFor(async () => (await tmux.listSessions())[0]?.attached === 1, 3000, "group attached");
    } finally {
      pty.kill();
    }
  });

  test("target() is the base when present, else the sidebar shows the oldest surviving member", async () => {
    await makeGroup();
    expect(await tmux.target("ws")).toBe(await idOf("ws"));
    await tmux.run(["kill-session", "-t", "=ws"]);
    const sessions = await tmux.listSessions();
    // the group still answers to "ws", but only real session names are shown
    expect(sessions.map((s) => s.name)).toEqual(["ws~a1b2c3d4"]);
    expect(await tmux.target("ws~a1b2c3d4")).toBe(await idOf("ws~a1b2c3d4"));
    await expect(tmux.target("ws")).rejects.toThrow(/can't find session/);
    expect(await tmux.hasSession("ws")).toBe(false);
    await tmux.newWindow("ws~a1b2c3d4");
    expect((await tmux.listSessions())[0].windows).toHaveLength(3);
  });

  test("killSession removes every member", async () => {
    await makeGroup();
    await tmux.killSession("ws");
    expect(await tmux.listSessions()).toEqual([]);
  });

  test("a comma in a group name never touches another session", async () => {
    await tmux.newSession("a");
    await tmux.run(["new-session", "-d", "-s", "a,b"]);
    await tmux.run(["new-session", "-d", "-t", "=a,b", "-s", "a,b~t1"]);
    await tmux.killSession("a,b");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["a"]);
  });

  test("renaming a group's base renames the sidebar entry", async () => {
    await makeGroup();
    await tmux.renameSession("ws", "proj");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["proj"]);
    expect(await tmux.target("proj")).toBe(await idOf("proj"));
    // still one group: a window added through the new name reaches every member
    await tmux.newWindow("proj");
    expect((await tmux.listSessions())[0].windows).toHaveLength(3);
    expect((await tmux.run(["list-windows", "-t", "=ws~a1b2c3d4", "-F", "#{window_index}"])).trim().split("\n")).toHaveLength(3);
  });

  test("plain sessions are unaffected", async () => {
    await tmux.newSession("plain");
    const [s] = await tmux.listSessions();
    expect(s.name).toBe("plain");
    expect(await tmux.target("plain")).toBe(await idOf("plain"));
  });
});

describe("checkoutOf", () => {
  const gits = new Set(["/r/app", "/r/app-CEE-1"]);
  const has = (d: string) => gits.has(d);

  test("is the nearest directory up holding a .git", () => {
    expect(checkoutOf("/r/app/src/main", has)).toBe("/r/app");
    expect(checkoutOf("/r/app", has)).toBe("/r/app");
    expect(checkoutOf("/r/app/", has)).toBe("/r/app");
  });

  test("a worktree is its own checkout, not its repository's", () => {
    expect(checkoutOf("/r/app-CEE-1/src", has)).toBe("/r/app-CEE-1");
  });

  test("is null outside git", () => {
    expect(checkoutOf("/Users/me", has)).toBeNull();
    expect(checkoutOf("/", has)).toBeNull();
  });
});

describe("windowLabel", () => {
  const HOST = "Demo-MacBook-Pro.local";

  test("prefers a title the program set over tmux's command-derived name", () => {
    // Claude Code names every window after its version, so the pane title is
    // the only thing that distinguishes one tab from another.
    expect(windowLabel("2.1.278", "Sonar issues review", HOST)).toBe("Sonar issues review");
  });

  test("drops Claude's status mark, which the tab's glyph already shows", () => {
    expect(windowLabel("2.1.278", "✳ Sonar issues review", HOST)).toBe("Sonar issues review");
    expect(windowLabel("2.1.278", "⠐ Image analysis", HOST)).toBe("Image analysis");
    // A mark alone is no title at all.
    expect(windowLabel("2.1.278", "✳", HOST)).toBe("2.1.278");
  });

  test("keeps a title's own leading punctuation", () => {
    expect(windowLabel("zsh", "[WIP] migration", HOST)).toBe("[WIP] migration");
    expect(windowLabel("zsh", "✳Banner", HOST)).toBe("✳Banner");
  });

  test("ignores the hostname tmux seeds pane_title with", () => {
    expect(windowLabel("zsh", HOST, HOST)).toBe("zsh");
    expect(windowLabel("zsh", "demo-macbook-pro", HOST)).toBe("zsh");
    expect(windowLabel("zsh", "Demo-MacBook-Pro", HOST)).toBe("zsh");
  });

  test("falls back to the window name when the title adds nothing", () => {
    expect(windowLabel("zsh", "", HOST)).toBe("zsh");
    expect(windowLabel("zsh", "   ", HOST)).toBe("zsh");
    expect(windowLabel("vim", "vim", HOST)).toBe("vim");
  });
});

describe("swapPlan", () => {
  // tmux refuses `move-window` onto an occupied index ("index in use"), so any
  // reordering is done with swap-window. These are the swaps that get from the
  // current arrangement to the wanted one; each pair is a pair of *positions*.
  const apply = (positions: number[], plan: [number, number][]) => {
    const at = [...positions];
    for (const [a, b] of plan) {
      const i = positions.indexOf(a);
      const j = positions.indexOf(b);
      [at[i], at[j]] = [at[j], at[i]];
    }
    return at;
  };

  test("no swaps when already in the wanted order", () => {
    expect(swapPlan([0, 1, 2], [0, 1, 2])).toEqual([]);
  });

  test("moves the last window to the front in one swap", () => {
    const plan = swapPlan([0, 1, 2], [2, 1, 0]);
    expect(apply([0, 1, 2], plan)).toEqual([2, 1, 0]);
  });

  test("reaches an arbitrary order and never exceeds n-1 swaps", () => {
    const plan = swapPlan([0, 1, 2, 3], [3, 0, 2, 1]);
    expect(apply([0, 1, 2, 3], plan)).toEqual([3, 0, 2, 1]);
    expect(plan.length).toBeLessThanOrEqual(3);
  });

  test("works when window indices have gaps, as they do after a window is killed", () => {
    const plan = swapPlan([0, 1, 5], [5, 0, 1]);
    expect(apply([0, 1, 5], plan)).toEqual([5, 0, 1]);
    for (const [a, b] of plan) expect([0, 1, 5]).toContain(a), expect([0, 1, 5]).toContain(b);
  });

  test("ignores a wanted order naming a window that is gone", () => {
    const plan = swapPlan([0, 1], [9, 1, 0]);
    expect(apply([0, 1], plan)).toEqual([1, 0]);
  });
});

describe("orderSessions", () => {
  const s = (name: string, order?: number) => ({ name, order }) as any;

  test("sorts by @muxnexus_order when it is set", () => {
    expect(orderSessions([s("c", 2), s("a", 0), s("b", 1)]).map((x) => x.name)).toEqual(["a", "b", "c"]);
  });

  test("puts unordered sessions after ordered ones, by name", () => {
    // A session made outside muxnexus has no stamp; it belongs at the end
    // rather than wherever tmux's name sort happens to drop it.
    expect(orderSessions([s("zed"), s("amy"), s("keep", 5)]).map((x) => x.name)).toEqual(["keep", "amy", "zed"]);
  });

  test("is stable for equal orders", () => {
    expect(orderSessions([s("b", 1), s("a", 1)]).map((x) => x.name)).toEqual(["b", "a"]);
  });
});

describe("Tmux split views", () => {
  /** A base session with two windows; returns their ids, first window current. */
  async function base(name = "ws") {
    await tmux.run(["new-session", "-d", "-s", name, "-x", "80", "-y", "24"]);
    await tmux.run(["new-window", "-d", "-t", `=${name}:`]);
    const ids = lines(await tmux.run(["list-windows", "-t", `=${name}:`, "-F", "#{window_id}"]));
    return { first: ids[0], second: ids[1] };
  }
  const lines = (s: string) => s.split("\n").filter(Boolean);
  const sessionIds = async () => lines(await tmux.run(["list-sessions", "-F", "#{session_id}"]));
  const windowIds = async () => lines(await tmux.run(["list-windows", "-a", "-F", "#{window_id}"])).sort();

  test("a view shows its own window and leaves the base's current one alone", async () => {
    const w = await base();
    const view = await tmux.openView("ws", w.second);
    expect((await tmux.run(["display-message", "-p", "-t", view, "#{window_id}"])).trim()).toBe(w.second);
    expect((await tmux.run(["display-message", "-p", "-t", "=ws:", "#{window_id}"])).trim()).toBe(w.first);
  });

  test("a view is neither a sidebar row nor another attached client", async () => {
    const w = await base();
    const view = await tmux.openView("ws", w.second);
    const { attachSession } = await import("../src/server/pty");
    const pty = attachSession({ target: view, socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
    try {
      await waitFor(async () => (await tmux.run(["list-clients", "-t", view])).trim() !== "", 3000, "view attached");
      const sessions = await tmux.listSessions();
      expect(sessions.map((s) => s.name)).toEqual(["ws"]);
      expect(sessions[0].attached).toBe(0);
    } finally {
      pty.kill();
    }
  });

  test("a base whose name has '.' or ':' still gets its own view", async () => {
    const w = await base("api.v2");
    const view = await tmux.openView("api.v2", w.second);
    expect((await tmux.run(["display-message", "-p", "-t", view, "#{session_group}"])).trim()).toBe("api.v2");
  });

  test("closing a view removes it and never a window", async () => {
    const w = await base();
    const before = await windowIds();
    const view = await tmux.openView("ws", w.second);
    await tmux.closeView(view);
    expect(await sessionIds()).not.toContain(view);
    expect(await windowIds()).toEqual(before);
  });

  test("a view that is the last of its group is left standing, windows and all", async () => {
    const w = await base();
    const before = await windowIds();
    const view = await tmux.openView("ws", w.second);
    await tmux.run(["kill-session", "-t", "=ws"]);
    await tmux.closeView(view);
    expect(await sessionIds()).toEqual([view]);
    expect(await windowIds()).toEqual(before);
  });

  test("once released, a view goes when its client does", async () => {
    const w = await base();
    const before = await windowIds();
    const view = await tmux.openView("ws", w.second);
    const { attachSession } = await import("../src/server/pty");
    const pty = attachSession({ target: view, socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
    await waitFor(async () => (await tmux.run(["list-clients", "-t", view])).trim() !== "", 3000, "view attached");
    await tmux.releaseView(view);
    pty.kill();
    await waitFor(async () => !(await sessionIds()).includes(view), 3000, "view destroyed");
    expect(await windowIds()).toEqual(before);
  });

  test("a sweep removes views nobody is attached to", async () => {
    const w = await base();
    const view = await tmux.openView("ws", w.second);
    await tmux.sweepViews();
    expect(await sessionIds()).not.toContain(view);
    expect(await sessionIds()).toHaveLength(1);
  });
});
