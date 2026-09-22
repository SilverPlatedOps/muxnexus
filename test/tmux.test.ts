import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { orderSessions, swapPlan, Tmux, TmuxError, windowLabel } from "../src/server/tmux";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-tmux";
const tmux = new Tmux(SOCKET);

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

  test("renameWindow, selectWindow, killWindow target by exact index", async () => {
    await tmux.newSession("s");
    await tmux.newWindow("s");
    await tmux.newWindow("s");
    await tmux.renameWindow("s", 1, "renamed one");
    await tmux.selectWindow("s", 1);
    await tmux.killWindow("s", 2);
    const [s] = await tmux.listSessions();
    expect(s.windows.map((w) => [w.index, w.name, w.active])).toEqual([
      [0, expect.any(String), false],
      [1, "renamed one", true],
    ]);
  });

  test("rename to a name starting with a dash", async () => {
    await tmux.newSession("s");
    await tmux.renameSession("s", "-dash");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["-dash"]);
    await tmux.newWindow("-dash");
    await tmux.renameWindow("-dash", 1, "-w");
    const [session] = await tmux.listSessions();
    expect(session.windows.find((w) => w.index === 1)?.name).toBe("-w");
  });

  test("renameSession and killSession", async () => {
    await tmux.newSession("old name");
    await tmux.renameSession("old name", "new name");
    expect((await tmux.listSessions()).map((s) => s.name)).toEqual(["new name"]);
    await tmux.killSession("new name");
    expect(await tmux.listSessions()).toEqual([]);
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

  test("rethrows tmux errors that are not not-found", async () => {
    await tmux.newSession("s");
    // An empty name yields target "=", which tmux rejects with an unrelated error.
    await expect(tmux.hasSession("")).rejects.toThrow(/no mouse target/);
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
    const pty = attachSession({ session: "ws~a1b2c3d4", socketName: SOCKET, cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
    try {
      await waitFor(async () => (await tmux.listSessions())[0]?.attached === 1, 3000, "group attached");
    } finally {
      pty.kill();
    }
  });

  test("target() is the base when present, else the sidebar shows the oldest surviving member", async () => {
    await makeGroup();
    expect(await tmux.target("ws")).toBe("ws");
    await tmux.run(["kill-session", "-t", "=ws"]);
    const sessions = await tmux.listSessions();
    // the group still answers to "ws", but only real session names are shown
    expect(sessions.map((s) => s.name)).toEqual(["ws~a1b2c3d4"]);
    expect(await tmux.target("ws~a1b2c3d4")).toBe("ws~a1b2c3d4");
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
    expect(await tmux.target("proj")).toBe("proj");
    // still one group: a window added through the new name reaches every member
    await tmux.newWindow("proj");
    expect((await tmux.listSessions())[0].windows).toHaveLength(3);
    expect((await tmux.run(["list-windows", "-t", "=ws~a1b2c3d4", "-F", "#{window_index}"])).trim().split("\n")).toHaveLength(3);
  });

  test("plain sessions are unaffected", async () => {
    await tmux.newSession("plain");
    const [s] = await tmux.listSessions();
    expect(s.name).toBe("plain");
    expect(await tmux.target("plain")).toBe("plain");
  });
});

describe("windowLabel", () => {
  const HOST = "Demo-MacBook-Pro.local";

  test("prefers a title the program set over tmux's command-derived name", () => {
    // Claude Code names every window after its version, so the pane title is
    // the only thing that distinguishes one tab from another.
    expect(windowLabel("2.1.278", "✳ Sonar issues review", HOST)).toBe("✳ Sonar issues review");
    expect(windowLabel("2.1.278", "✳ Image analysis", HOST)).toBe("✳ Image analysis");
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
