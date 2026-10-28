import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRestore, createSnapshotter, liveFrom, type Live, PANE_FIELDS, parsePanes, parseRestoreArgs, pendingRestore,
  pickSnapshot, planRestore, restoredFrom, restoreHint, restorePlan, type Snapshot, type SnapWindow, stalePaths,
  takeSnapshot,
} from "../src/server/restore";
import { Tmux } from "../src/server/tmux";
import { sleep, waitFor } from "./helpers";

/** One `list-panes` row, fields in PANE_FIELDS order, with the separator parsePanes expects. */
function row(values: Partial<Record<string, string>>): string {
  return PANE_FIELDS.map((f) => values[f] ?? "").join("\x1f");
}

describe("Codex windows", () => {
  const CODEX = (id: string, over: Partial<SnapWindow> = {}) =>
    SNAP({ command: "codex", thread: { id, path: `${HOME}/.codex/sessions/2026/10/rollout-${id}.jsonl` }, ...over });

  test("parsePanes reads the thread a Codex hook stamped", () => {
    const out = row({ session_name: "s", window_id: "@1", window_index: "0", pane_index: "0", pane_current_command: "codex", "@muxnexus_thread": "th-1 /h/.codex/sessions/r.jsonl" });
    expect(parsePanes(out)[0]!.thread).toEqual({ id: "th-1", path: "/h/.codex/sessions/r.jsonl" });
    expect(parsePanes(row({ session_name: "s", window_id: "@2", window_index: "0", pane_index: "0" }))[0]!.thread).toBeUndefined();
  });

  test("a window still running codex resumes its thread, not a Claude conversation", () => {
    const [step] = plan([CODEX("th-1")]);
    expect(step!.codex).toMatchObject({ thread: "th-1", home: null });
    expect(step!.resume).toBeUndefined();
  });

  test("a thread under another CODEX_HOME is resumed there", () => {
    const [step] = plan([CODEX("th-2", { thread: { id: "th-2", path: `${HOME}/.codex-work/sessions/2026/r.jsonl` } })]);
    expect(step!.codex).toMatchObject({ thread: "th-2", home: `${HOME}/.codex-work` });
  });

  test("a codex window back at its shell stays quit, and a thread already live is not started twice", () => {
    expect(plan([CODEX("th-1", { command: "zsh" })])[0]!.codex).toBeUndefined();
    expect(plan([CODEX("th-1")], { conversations: ["th-1"] })).toEqual([]);
  });

  test("a typed Codex resume that never ran survives a second reboot, even at a shell", () => {
    const w = SNAP({ command: "zsh", pendingThread: { id: "th-9", path: `${HOME}/.codex-work/sessions/r.jsonl` } });
    expect(plan([w])[0]!.codex).toEqual({ thread: "th-9", home: `${HOME}/.codex-work`, path: `${HOME}/.codex-work/sessions/r.jsonl` });
    expect(liveFrom([w]).conversations.has("th-9")).toBe(true);
    expect(plan([w], { conversations: ["th-9"] })).toEqual([]);
  });

  test("parsePanes reads the pending thread", () => {
    const out = row({ session_name: "s", window_id: "@1", window_index: "0", pane_index: "0", "@muxnexus_pending_thread": "th-9 /h/.codex/sessions/r.jsonl" });
    expect(parsePanes(out)[0]!.pendingThread).toEqual({ id: "th-9", path: "/h/.codex/sessions/r.jsonl" });
  });

  test("a pane that went Claude to Codex resumes the Codex thread, not the stale Claude stamp", () => {
    const w = CODEX("th-1", { ...AGENT("old-claude"), command: "codex", agent: `running 1790000000 777 ${HOME}/.codex` });
    const [step] = plan([w]);
    expect(step!.codex).toMatchObject({ thread: "th-1" });
    expect(step!.resume).toBeUndefined();
  });

  test("a pane that went Codex to Claude resumes the Claude conversation", () => {
    const w = SNAP({ ...AGENT("abc"), thread: { id: "th-old", path: `${HOME}/.codex/sessions/r.jsonl` }, agent: `running 1790000000 4242 ${HOME}/.claude` });
    const [step] = plan([w]);
    expect(step!.resume?.transcript).toContain("abc.jsonl");
    expect(step!.codex).toBeUndefined();
  });

  test("with both stamps and a shell, the last stamp's config directory decides", () => {
    const base = { ...AGENT("old-claude"), thread: { id: "th-1", path: `${HOME}/.codex/sessions/r.jsonl` }, command: "zsh" };
    expect(plan([SNAP({ ...base, agent: `done 1 7 ${HOME}/.codex` })])[0]!.codex).toBeUndefined();
    expect(plan([SNAP({ ...base, agent: `done 1 7 ${HOME}/.claude` })])[0]!.resume).toBeUndefined();
  });

  test("liveFrom counts a running thread as held", () => {
    expect(liveFrom([CODEX("th-1")]).conversations.has("th-1")).toBe(true);
  });

  test("a snapshot from before threads were recorded still plans (no codex step)", () => {
    expect(plan([SNAP({ command: "codex" })])[0]!.codex).toBeUndefined();
  });
});

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

  test("resumes a window whose typed resume never ran", () => {
    const pending = { sessionId: "abc", transcriptPath: `${HOME}/.claude/projects/p/abc.jsonl` };

    const steps = plan([SNAP({ pending })]);

    expect(steps[0].resume).toEqual({ configDir: null, transcript: pending.transcriptPath });
  });

  test("leaves an agent that was started and then quit as a plain shell, typed resume or not", () => {
    const window = SNAP({ ...AGENT("abc"), command: "zsh", pending: AGENT("abc").conversation });

    expect(plan([window])[0].resume).toBeUndefined();
  });

  test("skips a window whose typed resume is already running elsewhere", () => {
    const pending = { sessionId: "abc", transcriptPath: `${HOME}/.claude/projects/p/abc.jsonl` };

    expect(plan([SNAP({ pending })], { conversations: ["abc"] })).toEqual([]);
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

  test("counts a typed resume that has not run as held", () => {
    const pending = { sessionId: "def", transcriptPath: `${HOME}/.claude/projects/p/def.jsonl` };

    expect([...liveFrom([SNAP({ pending })]).conversations]).toEqual(["def"]);
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

  test("with start: false, types the resume and leaves it for Enter -- and the next snapshot still knows it", async () => {
    const transcript = join(dir, "projects", "p", "abc.jsonl");
    await Bun.write(transcript, "");
    const snap: Snapshot = {
      stamp: "100-1", taken: "2026-10-01T00:00:00Z",
      windows: [SNAP({ cwd: dir, command: "2.1.287", conversation: { sessionId: "abc", transcriptPath: transcript } })],
    };

    await applyRestore(tmux, snap, { start: false });

    const screen = await waitFor(async () => {
      // -J: the typed line is longer than the pane is wide.
      const s = await tmux.run(["capture-pane", "-p", "-J", "-t", "=work:0"]);
      return s.includes("claude --resume") ? s : null;
    }, 3000, "the typed resume");
    expect(screen).toContain(transcript);
    // Long enough for an Enter to have started something, had one been sent.
    await sleep(300);
    expect((await tmux.run(["display", "-p", "-t", "=work:0", "#{pane_current_command}"])).trim()).toMatch(/^(zsh|bash|sh|fish)$/);
    const again = (await takeSnapshot(tmux, dir))!;
    expect(again.windows[0].pending).toEqual({ sessionId: "abc", transcriptPath: transcript });
    const replanned = restorePlan(again.windows, { sessions: new Set(), conversations: new Set() }, { home: HOME, exists: () => true });
    expect(replanned[0].resume?.transcript).toBe(transcript);
  });

  test("with start: false, a Codex resume is typed with the default home unset, and a second snapshot keeps its thread", async () => {
    const rollout = join(dir, ".codex", "sessions", "2026", "r.jsonl");
    const snap: Snapshot = {
      stamp: "100-2", taken: "2026-10-01T00:00:00Z",
      windows: [SNAP({ cwd: dir, command: "codex", thread: { id: "th-7", path: rollout } })],
    };

    // Not under this test's HOME, so its home reads as another one: the typed line sets it.
    await applyRestore(tmux, snap, { start: false });
    const screen = await waitFor(async () => {
      const s = await tmux.run(["capture-pane", "-p", "-J", "-t", "=work:0"]);
      return s.includes("resume") ? s : null;
    }, 3000, "the typed Codex resume");
    expect(screen).toContain("resume 'th-7'");
    expect(screen).toContain("--no-daemon");
    const again = (await takeSnapshot(tmux, dir))!;
    expect(again.windows[0].pendingThread).toEqual({ id: "th-7", path: rollout });
    const replanned = restorePlan(again.windows, { sessions: new Set(), conversations: new Set() }, { home: HOME, exists: () => true });
    expect(replanned[0].codex?.thread).toBe("th-7");
  });

  test("the typed Codex resume actually runs: default home unset, other home set", async () => {
    const bin = join(dir, "bin");
    await Bun.write(join(bin, "codex"), '#!/bin/sh\necho "ARGS:$*"\necho "HOME:${CODEX_HOME-unset}"\n');
    await Bun.$`chmod +x ${join(bin, "codex")}`;
    // A shell that already has an account's CODEX_HOME (a server must exist to hold it); a fake codex, never the real one.
    await tmux.newSession("keep");
    await tmux.run(["set-environment", "-g", "CODEX_HOME", "/inherited"]);
    for (const [name, path, want] of [["a", `${homedir()}/.codex/sessions/r.jsonl`, "HOME:unset"], ["b", `${dir}/.codex-work/sessions/r.jsonl`, `HOME:${dir}/.codex-work`]] as const) {
      const snap: Snapshot = { stamp: `100-${name}`, taken: "2026-10-01T00:00:00Z", windows: [SNAP({ session: `s-${name}`, cwd: dir, command: "codex", thread: { id: `th-${name}`, path } })] };
      await applyRestore(tmux, snap, { codexBin: join(bin, "codex") });
      const screen = await waitFor(async () => {
        const s = await tmux.run(["capture-pane", "-p", "-J", "-t", `=s-${name}:0`]);
        return s.includes("HOME:") && s.split("\n").some((l) => l.startsWith("HOME:")) ? s : null;
      }, 4000, "the fake codex output").catch(async (e) => { throw new Error(`${e.message}\n${await tmux.run(["capture-pane", "-p", "-J", "-t", `=s-${name}:0`])}`); });
      expect(screen).toContain(`ARGS:--no-daemon -c tui.alternate_screen="never" resume th-${name}`);
      expect(screen.split("\n")).toContain(want);
    }
  });

  test("a default-home Codex resume unsets CODEX_HOME", async () => {
    const snap: Snapshot = {
      stamp: "100-3", taken: "2026-10-01T00:00:00Z",
      windows: [SNAP({ cwd: dir, command: "codex", thread: { id: "th-8", path: `${homedir()}/.codex/sessions/r.jsonl` } })],
    };
    await applyRestore(tmux, snap, { start: false });
    const screen = await waitFor(async () => {
      const s = await tmux.run(["capture-pane", "-p", "-J", "-t", "=work:0"]);
      return s.includes("resume") ? s : null;
    }, 3000, "the typed Codex resume");
    expect(screen).toContain("env -u CODEX_HOME codex --no-daemon");
  });
});

describe("planRestore", () => {
  test("plans against the tmux that is running now", async () => {
    await tmux.newSession("work", dir);
    const snap = (await takeSnapshot(tmux, dir))!;
    await tmux.killServer();

    expect(await planRestore(tmux, snap)).toHaveLength(1);
    await applyRestore(tmux, snap);
    expect(await planRestore(tmux, snap)).toEqual([]);
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

  test("stays quiet after a restored session is closed again", async () => {
    await tmux.newSession("work", dir);
    await tmux.newSession("scratch", dir);
    const snap = (await takeSnapshot(tmux, dir))!;
    await tmux.killServer();
    await applyRestore(tmux, snap);

    await tmux.killSession("scratch");

    expect(await pendingRestore(tmux, dir)).toBeNull();
  });
});

describe("restoredFrom", () => {
  test("is empty on a tmux server nothing has been restored into", async () => {
    await tmux.newSession("work", dir);

    expect(await restoredFrom(tmux)).toBeNull();
  });

  test("names the snapshot a restore ran from", async () => {
    await tmux.newSession("work", dir);
    const snap = (await takeSnapshot(tmux, dir))!;
    await tmux.killServer();

    await applyRestore(tmux, snap);

    expect(await restoredFrom(tmux)).toBe(snap.stamp);
  });

  test("is empty again on a fresh tmux server", async () => {
    await tmux.newSession("work", dir);
    const snap = (await takeSnapshot(tmux, dir))!;
    await tmux.killServer();
    await applyRestore(tmux, snap);

    await tmux.killServer();
    await tmux.newSession("work", dir);

    expect(await restoredFrom(tmux)).toBeNull();
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
    expect(parseRestoreArgs(["snapshot"])).toEqual({ command: "snapshot", dryRun: false, start: true, path: undefined });
  });

  test("reads a restore that types each resume without running it", () => {
    expect(parseRestoreArgs(["restore", "--no-start"])).toMatchObject({ command: "restore", start: false });
  });

  test("reads the snapshots listing", () => {
    expect(parseRestoreArgs(["snapshots"])).toMatchObject({ command: "snapshots" });
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
