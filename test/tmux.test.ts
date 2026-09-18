import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Tmux, TmuxError } from "../src/server/tmux";

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
});
