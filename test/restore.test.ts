import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRestore, createSnapshotter, liveFrom, type Live, PANE_FIELDS, parsePanes, parseRestoreArgs, pendingRestore,
  pickSnapshot, restoreHint, restorePlan, type Snapshot, type SnapWindow, stalePaths, takeSnapshot,
} from "../src/server/restore";
import { Tmux } from "../src/server/tmux";
import { sleep, waitFor } from "./helpers";

/** One `list-panes` row, fields in PANE_FIELDS order, with the separator parsePanes expects. */
function row(values: Partial<Record<string, string>>): string {
  return PANE_FIELDS.map((f) => values[f] ?? "").join("\x1f");
}

describe("parsePanes", () => {
  test("records a window's session, directory, name and conversation", () => {
    const out = row({
      session_name: "work",
      window_id: "@1",
      window_index: "2",
      "@muxnexus_window_name": "Banner Group",
      pane_current_path: "/Users/me/repo",
      pane_current_command: "2.1.287",
      pane_index: "0",
      "@muxnexus_session": "abc-123 /Users/me/.claude/projects/p/abc-123.jsonl",
    });

    expect(parsePanes(out)).toEqual([
      {
        session: "work",
        sessionName: undefined,
        order: undefined,
        index: 2,
        windowName: "Banner Group",
        cwd: "/Users/me/repo",
        command: "2.1.287",
        note: undefined,
        noteEmpty: undefined,
        conversation: { sessionId: "abc-123", transcriptPath: "/Users/me/.claude/projects/p/abc-123.jsonl" },
        from: undefined,
      },
    ]);
  });

  test("keeps a window once when several sessions link it", () => {
    const pane = { session_name: "work", window_id: "@1", window_index: "0", pane_index: "0", pane_current_path: "/tmp", pane_current_command: "zsh" };
    const out = [row(pane), row({ ...pane, session_name: "work-grouped" })].join("\n");

    const windows = parsePanes(out);

    expect(windows).toHaveLength(1);
    expect(windows[0].session).toBe("work");
  });

  test("skips a split-pane view session", () => {
    const out = row({
      session_name: "view-1",
      "@muxnexus_view": "1",
      window_id: "@9",
      window_index: "0",
      pane_index: "0",
      pane_current_path: "/tmp",
      pane_current_command: "zsh",
    });

    expect(parsePanes(out)).toEqual([]);
  });
});

const HOME = "/Users/me";
const SNAP = (over: Partial<SnapWindow> = {}): SnapWindow => ({
  session: "work", index: 0, cwd: "/Users/me/repo", command: "zsh", ...over,
});
const AGENT = (sessionId: string, dir = `${HOME}/.claude`): Partial<SnapWindow> => ({
  command: "2.1.287",
  conversation: { sessionId, transcriptPath: `${dir}/projects/p/${sessionId}.jsonl` },
});
const plan = (windows: SnapWindow[], live: Partial<Record<keyof Live, string[]>> = {}, exists: (p: string) => boolean = () => true) =>
  restorePlan(windows, { sessions: new Set(live.sessions ?? []), conversations: new Set(live.conversations ?? []) }, { home: HOME, exists });

describe("restorePlan", () => {
  test("creates the session for its first window and adds the rest", () => {
    const steps = plan([SNAP({ index: 1 }), SNAP({ index: 0 })]);

    expect(steps.map((s) => [s.window.index, s.createSession])).toEqual([[0, true], [1, false]]);
  });

  test("skips a session that is already there", () => {
    expect(plan([SNAP()], { sessions: ["work"] })).toEqual([]);
  });

  test("skips a window whose conversation is already running", () => {
    const windows = [SNAP({ ...AGENT("abc") }), SNAP({ index: 1, ...AGENT("def") })];

    const steps = plan(windows, { conversations: ["abc"] });

    expect(steps).toHaveLength(1);
    expect(steps[0].window.conversation?.sessionId).toBe("def");
  });

  test("restoring twice is a no-op", () => {
    const windows = [SNAP({ ...AGENT("abc") }), SNAP({ session: "other", ...AGENT("def") })];

    expect(plan(windows, { sessions: ["work", "other"], conversations: ["abc", "def"] })).toEqual([]);
  });

  test("falls back to home when the recorded directory is gone", () => {
    const steps = plan([SNAP({ cwd: "/gone" })], {}, (p) => p !== "/gone");

    expect(steps[0].cwd).toBe(HOME);
  });

  test("resumes a work conversation with its own config directory", () => {
    const steps = plan([SNAP(AGENT("abc", `${HOME}/.claude-work`))]);

    expect(steps[0].resume).toEqual({ configDir: `${HOME}/.claude-work`, transcript: `${HOME}/.claude-work/projects/p/abc.jsonl` });
  });

  test("resumes a personal conversation with the default config directory", () => {
    const steps = plan([SNAP(AGENT("abc"))]);

    expect(steps[0].resume?.configDir).toBeNull();
  });

  test("leaves a window whose transcript is gone as a plain shell", () => {
    const steps = plan([SNAP(AGENT("abc"))], {}, () => false);

    expect(steps).toHaveLength(1);
    expect(steps[0].resume).toBeUndefined();
  });

  test("leaves a window that held no agent as a plain shell", () => {
    expect(plan([SNAP()])[0].resume).toBeUndefined();
  });

  test("falls back to the fork this conversation was made from", () => {
    const window = SNAP({
      ...AGENT("abc"),
      from: { sessionId: "abc", transcriptPath: `${HOME}/.claude/projects/p/forked.jsonl` },
    });

    const steps = plan([window], {}, (p) => p.endsWith("forked.jsonl"));

    expect(steps[0].resume?.transcript).toBe(`${HOME}/.claude/projects/p/forked.jsonl`);
  });

  test("ignores a fork recorded for a different conversation", () => {
    const window = SNAP({
      ...AGENT("abc"),
      from: { sessionId: "other", transcriptPath: `${HOME}/.claude/projects/p/other.jsonl` },
    });

    const steps = plan([window], {}, (p) => p.endsWith("other.jsonl"));

    expect(steps[0].resume).toBeUndefined();
  });
});

const SNAPSHOT = (stamp: string, taken: string): Snapshot => ({ stamp, taken, windows: [] });

describe("pickSnapshot", () => {
  test("picks the newest snapshot a previous server left behind", () => {
    const snaps = [SNAPSHOT("100-1", "2026-10-01T00:00:00Z"), SNAPSHOT("200-2", "2026-10-02T00:00:00Z")];

    expect(pickSnapshot(snaps, "300-3")?.stamp).toBe("200-2");
  });

  test("ignores the running server's own snapshot", () => {
    const snaps = [SNAPSHOT("100-1", "2026-10-01T00:00:00Z"), SNAPSHOT("300-3", "2026-10-02T00:00:00Z")];

    expect(pickSnapshot(snaps, "300-3")?.stamp).toBe("100-1");
  });

  test("finds nothing when only the running server has a snapshot", () => {
    expect(pickSnapshot([SNAPSHOT("300-3", "2026-10-02T00:00:00Z")], "300-3")).toBeNull();
  });

  test("finds nothing when there are no snapshots", () => {
    expect(pickSnapshot([], "300-3")).toBeNull();
  });
});

describe("stalePaths", () => {
  test("keeps the newest few and names the rest", () => {
    const entries = [
      { path: "a", taken: "2026-10-01T00:00:00Z" },
      { path: "b", taken: "2026-10-04T00:00:00Z" },
      { path: "c", taken: "2026-10-03T00:00:00Z" },
      { path: "d", taken: "2026-10-02T00:00:00Z" },
    ];

    expect(stalePaths(entries, 2)).toEqual(["d", "a"]);
  });

  test("names nothing when there are fewer than the limit", () => {
    expect(stalePaths([{ path: "a", taken: "2026-10-01T00:00:00Z" }], 5)).toEqual([]);
  });
});

describe("liveFrom", () => {
  test("collects the session names and running conversations", () => {
    const windows = [SNAP(), SNAP({ session: "other", ...AGENT("abc") })];

    const live = liveFrom(windows);

    expect([...live.sessions]).toEqual(["work", "other"]);
    expect([...live.conversations]).toEqual(["abc"]);
  });
});

/** Its own socket name: sharing one with another test file would cross the two servers. */
const tmux = new Tmux("muxnexus-restore-test");
let dir = "";

beforeEach(async () => {
  await tmux.killServer();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mxn-snap-")));
});
afterEach(async () => {
  await tmux.killServer();
  rmSync(dir, { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  test("records nothing when no tmux server is running", async () => {
    expect(await takeSnapshot(tmux, dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("writes a stamped file holding the live windows", async () => {
    await tmux.newSession("work", dir);

    const snap = await takeSnapshot(tmux, dir);

    expect(snap?.windows).toHaveLength(1);
    expect(snap?.windows[0]).toMatchObject({ session: "work", index: 0, cwd: dir });
    expect(readdirSync(dir)).toEqual([`${snap?.stamp}.json`]);
  });

  test("a later snapshot of the same server replaces its own file", async () => {
    await tmux.newSession("work", dir);
    const first = await takeSnapshot(tmux, dir);
    await tmux.newWindow("work");

    const second = await takeSnapshot(tmux, dir);

    expect(second?.stamp).toBe(first!.stamp);
    expect(second?.windows).toHaveLength(2);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});

describe("applyRestore", () => {
  /** Snapshot a throwaway server's windows, then stop it: what a reboot leaves behind. */
  async function snapshotThenKill(): Promise<Snapshot> {
    const snap = await takeSnapshot(tmux, dir);
    await tmux.killServer();
    return snap!;
  }

  test("rebuilds the sessions, window names and directories", async () => {
    await tmux.newSession("work", dir);
    const windowId = (await tmux.run(["new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=work:", "-c", dir])).trim();
    await tmux.newSession("other", dir);
    await tmux.renameWindow("work", windowId, "Banner Group");
    const snap = await snapshotThenKill();

    const steps = await applyRestore(tmux, snap);

    expect(steps).toHaveLength(3);
    const sessions = await tmux.listSessions();
    expect(sessions.map((s) => s.name).sort()).toEqual(["other", "work"]);
    const work = sessions.find((s) => s.name === "work")!;
    expect(work.windows).toHaveLength(2);
    expect(await tmux.run(["display", "-p", "-t", "=work:1", "#{pane_current_path}"])).toContain(dir);
  });

  test("puts a window's note back on it", async () => {
    await tmux.newSession("work", dir);
    const windowId = (await tmux.run(["display", "-p", "-t", "=work:0", "#{window_id}"])).trim();
    await tmux.run(["set-option", "-w", "-t", windowId, "@muxnexus_note", "note-1"]);
    const snap = await snapshotThenKill();

    await applyRestore(tmux, snap);

    expect((await tmux.run(["display", "-p", "-t", "=work:0", "#{@muxnexus_note}"])).trim()).toBe("note-1");
  });

  test("restoring a second time adds nothing", async () => {
    await tmux.newSession("work", dir);
    await tmux.newWindow("work");
    const snap = await snapshotThenKill();
    await applyRestore(tmux, snap);

    const steps = await applyRestore(tmux, snap);

    expect(steps).toEqual([]);
    const [session] = await tmux.listSessions();
    expect(session.windows).toHaveLength(2);
  });

  test("adds only what is missing when a session survived", async () => {
    await tmux.newSession("work", dir);
    await tmux.newSession("other", dir);
    const snap = await snapshotThenKill();
    await tmux.newSession("work", dir);

    const steps = await applyRestore(tmux, snap);

    expect(steps.map((s) => s.window.session)).toEqual(["other"]);
  });
});

describe("restoreHint", () => {
  test("counts the windows a restore would bring back", () => {
    const steps = [SNAP(), SNAP({ index: 1 })].map((w) => ({ window: w, cwd: "/tmp", createSession: false }));

    expect(restoreHint(steps)).toBe("2 windows from a previous session — run: muxnexus restore");
  });

  test("says window once when there is only one", () => {
    const steps = [{ window: SNAP(), cwd: "/tmp", createSession: false }];

    expect(restoreHint(steps)).toContain("1 window from");
  });

  test("stays quiet when there is nothing to restore", () => {
    expect(restoreHint([])).toBeNull();
  });
});

describe("pendingRestore", () => {
  test("finds the windows a previous server left behind", async () => {
    await tmux.newSession("work", dir);
    await takeSnapshot(tmux, dir);
    await tmux.killServer();
    await tmux.newSession("unrelated", dir);

    const pending = await pendingRestore(tmux, dir);

    expect(pending?.steps).toHaveLength(1);
    expect(pending?.steps[0].window.session).toBe("work");
  });

  test("finds nothing once the restore has run", async () => {
    await tmux.newSession("work", dir);
    const snap = (await takeSnapshot(tmux, dir))!;
    await tmux.killServer();
    await applyRestore(tmux, snap);

    expect(await pendingRestore(tmux, dir)).toBeNull();
  });
});

describe("createSnapshotter", () => {
  test("keeps taking snapshots while it runs", async () => {
    await tmux.newSession("work", dir);
    const snapshotter = createSnapshotter({ tmux, dir, intervalMs: 20 });
    try {
      await waitFor(() => readdirSync(dir).length === 1, 2000, "a snapshot to be written");
      const first = await Bun.file(join(dir, readdirSync(dir)[0])).json();
      await tmux.newSession("later", dir);

      await waitFor(async () => {
        const snap = await Bun.file(join(dir, readdirSync(dir)[0])).json();
        return snap.taken !== first.taken && snap.windows.length === 2;
      }, 2000, "the snapshot to follow the new session");
    } finally {
      snapshotter.stop();
    }
  });

  test("writes nothing while no tmux server is running", async () => {
    const snapshotter = createSnapshotter({ tmux, dir, intervalMs: 20 });
    try {
      await sleep(120);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      snapshotter.stop();
    }
  });
});

describe("parseRestoreArgs", () => {
  test("reads the command", () => {
    expect(parseRestoreArgs(["snapshot"])).toEqual({ command: "snapshot", dryRun: false, path: undefined });
  });

  test("reads a dry run", () => {
    expect(parseRestoreArgs(["restore", "--dry-run"])).toMatchObject({ command: "restore", dryRun: true });
  });

  test("reads an explicit snapshot to restore from", () => {
    expect(parseRestoreArgs(["restore", "/tmp/s.json"])).toMatchObject({ command: "restore", path: "/tmp/s.json" });
  });

  test("rejects an unknown command", () => {
    expect(() => parseRestoreArgs(["wat"])).toThrow("unknown command: wat");
  });

  test("rejects a missing command", () => {
    expect(() => parseRestoreArgs([])).toThrow("usage:");
  });
});
