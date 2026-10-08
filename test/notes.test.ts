import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/shared/protocol";
import { createNoteStore, isNoteId, pickOrphan } from "../src/server/notes";
import { createServer } from "../src/server/server";
import { conversationIds, Tmux } from "../src/server/tmux";
import { takesRemote } from "../src/client/notes";
import { clampWidth } from "../src/client/resize";
import { ago, excerpt, noteMatches, noteTitle } from "../src/client/explorer";
import { waitFor } from "./helpers";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "mx-notes-"));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("only a uuid names a note", () => {
  expect(isNoteId(ID)).toBe(true);
  expect(isNoteId("../../etc/passwd")).toBe(false);
  expect(isNoteId(`${ID}/x`)).toBe(false);
  expect(isNoteId(42)).toBe(false);
});

test("a note never written reads empty, and is not created by reading", async () => {
  const dir = join(scratch(), "notes");
  const store = createNoteStore(dir);
  expect(await store.read(ID)).toEqual({ text: "", updated: "" });
  expect(existsSync(dir)).toBe(false);
});

test("a write keeps the text and where it came from, and the first time it was made", async () => {
  const dir = join(scratch(), "notes");
  const store = createNoteStore(dir);
  await store.write(ID, "first", { session: "Work", window: "claude", cwd: "/Users/me/x" });
  const created = JSON.parse(readFileSync(join(dir, `${ID}.json`), "utf8")).created;
  // The window is gone by the second save: what it was is kept.
  await store.write(ID, "second", null);
  expect(readFileSync(join(dir, `${ID}.md`), "utf8")).toBe("second");
  const meta = JSON.parse(readFileSync(join(dir, `${ID}.json`), "utf8"));
  expect(meta).toMatchObject({ session: "Work", window: "claude", cwd: "/Users/me/x", created });
  expect(existsSync(join(dir, `${ID}.md.tmp`))).toBe(false);
  expect((await store.read(ID)).text).toBe("second");
});

test("a bad id is refused before it reaches the disk", async () => {
  const store = createNoteStore(scratch());
  await expect(store.write("../x", "hi", null)).rejects.toThrow("invalid note id");
});

test("a panel keeps to its limits", () => {
  expect(clampWidth(100, 200, 480)).toBe(200);
  expect(clampWidth(333.4, 200, 480)).toBe(333);
  expect(clampWidth(900, 260, 640)).toBe(640);
});

test("another device's save waits for the editor to be left alone", () => {
  expect(takesRemote({ focused: false, dirty: false })).toBe(true);
  expect(takesRemote({ focused: true, dirty: false })).toBe(false);
  expect(takesRemote({ focused: false, dirty: true })).toBe(false);
});

const SOCKET = "cmux-viewer-test-notes";

test("opening a note stamps the window; a save reaches the other browsers and marks the tab", async () => {
  const tmux = new Tmux(SOCKET);
  await tmux.killServer();
  const dir = scratch();
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 100, notesDir: dir });
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } } as any);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
    await new Promise<void>((res) => { ws.onopen = () => res(); });
    return { ws, got, send: (m: object) => ws.send(JSON.stringify(m)) };
  };
  try {
    await tmux.newSession("notes");
    const a = await open();
    const b = await open();
    const win = await waitFor(() => {
      const s = [...a.got].reverse().find((m) => m.t === "state");
      return s?.t === "state" ? s.sessions[0]?.windows[0] : undefined;
    }, 3000, "a window");

    a.send({ t: "note-open", session: "notes", id: win.id });
    const opened = await waitFor(() => a.got.find((m) => m.t === "note"), 3000, "note");
    if (opened.t !== "note") throw new Error("unreachable");
    expect(opened).toMatchObject({ windowId: win.id, text: "" });
    expect(isNoteId(opened.noteId)).toBe(true);

    // Asked again, the window keeps the note it was given.
    a.send({ t: "note-open", session: "notes", id: win.id });
    await waitFor(() => a.got.filter((m) => m.t === "note").length === 2, 3000, "second open");
    const again = a.got.filter((m) => m.t === "note")[1];
    expect(again.t === "note" && again.noteId).toBe(opened.noteId);

    a.send({ t: "note-save", noteId: opened.noteId, text: "fix the 504 first" });
    const echoed = await waitFor(() => b.got.find((m) => m.t === "note"), 3000, "broadcast");
    expect(echoed).toMatchObject({ noteId: opened.noteId, text: "fix the 504 first" });
    expect(a.got.filter((m) => m.t === "note").length).toBe(2); // not echoed to the writer
    expect(readFileSync(join(dir, `${opened.noteId}.md`), "utf8")).toBe("fix the 504 first");

    await waitFor(() => {
      const s = [...b.got].reverse().find((m) => m.t === "state");
      const w = s?.t === "state" ? s.sessions[0]?.windows[0] : undefined;
      return w?.noteId === opened.noteId && !w.noteEmpty;
    }, 3000, "tab marked");

    a.send({ t: "note-save", noteId: "../../x", text: "nope" });
    await waitFor(() => a.got.find((m) => m.t === "error"), 3000, "refused");
    a.ws.close();
    b.ws.close();
  } finally {
    srv.stop();
    await tmux.killServer();
  }
});

const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

test("the store lists every note and forgets a deleted one", async () => {
  const dir = scratch();
  const store = createNoteStore(dir);
  expect(await store.list()).toEqual([]);
  await store.write(ID, "one", { session: "Work", window: "claude" });
  await store.write(ID2, "two", null);
  const listed = (await store.list()).sort((a, b) => a.text.localeCompare(b.text));
  expect(listed.map((n) => [n.noteId, n.text, n.meta])).toEqual([[ID, "one", { session: "Work", window: "claude" }], [ID2, "two", {}]]);
  await store.remove(ID);
  expect((await store.list()).map((n) => n.noteId)).toEqual([ID2]);
  await expect(store.remove("../x")).rejects.toThrow("invalid note id");
});

const note = (over: Partial<Parameters<typeof noteMatches>[0]> = {}) => ({
  noteId: ID, session: "[Work] Enclave", window: "claude", text: "Fix the 504 in the backend first.\nThen trim plan_list.", updated: "", ...over,
});

test("a search needs every word, from the title or the text, in any case", () => {
  expect(noteTitle(note())).toBe("[Work] Enclave › claude");
  expect(noteTitle(note({ session: "", window: "" }))).toBe("Untitled");
  expect(noteMatches(note(), "")).toBe(true);
  expect(noteMatches(note(), "enclave 504")).toBe(true);
  expect(noteMatches(note(), "PLAN_LIST")).toBe(true);
  expect(noteMatches(note(), "enclave voucher")).toBe(false);
});

test("the excerpt sits around the first match, or opens the note", () => {
  const long = `${"a ".repeat(100)}needle ${"b ".repeat(100)}`;
  const ex = excerpt(long, "needle", 10);
  expect(ex.startsWith("…")).toBe(true);
  expect(ex.endsWith("…")).toBe(true);
  expect(ex).toContain("needle");
  expect(excerpt("line one\n\nline two", "")).toBe("line one line two");
  expect(excerpt("x".repeat(200), "zzz", 10)).toBe(`${"x".repeat(20)}…`);
});

test("ago reads like the rest of the page", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  expect(ago("2026-10-02T11:59:30Z", now)).toBe("now");
  expect(ago("2026-10-02T11:55:00Z", now)).toBe("5m ago");
  expect(ago("2026-10-02T09:00:00Z", now)).toBe("3h ago");
  expect(ago("2026-09-30T12:00:00Z", now)).toBe("2d ago");
  expect(ago("nonsense", now)).toBe("");
});

test("the explorer lists notes with their window, and a delete frees the window", async () => {
  const tmux = new Tmux(SOCKET);
  await tmux.killServer();
  const dir = scratch();
  const store = createNoteStore(dir);
  // A note whose window is long gone, and an empty one that is not listed.
  await store.write(ID2, "old thoughts", { session: "Gone", window: "zsh" });
  await store.write(ID, "   ", null);
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 100, notesDir: dir });
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } } as any);
  const got: ServerMessage[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
  const send = (m: object) => ws.send(JSON.stringify(m));
  try {
    await new Promise<void>((res) => { ws.onopen = () => res(); });
    await tmux.newSession("live");
    const win = await waitFor(() => {
      const s = [...got].reverse().find((m) => m.t === "state");
      return s?.t === "state" ? s.sessions[0]?.windows[0] : undefined;
    }, 3000, "a window");
    send({ t: "note-open", session: "live", id: win.id });
    const opened = await waitFor(() => got.find((m) => m.t === "note"), 3000, "note");
    if (opened.t !== "note") throw new Error("unreachable");
    send({ t: "note-save", noteId: opened.noteId, text: "fresh plan" });
    await waitFor(() => existsSync(join(dir, `${opened.noteId}.md`)), 3000, "saved");

    send({ t: "notes-list" });
    const listed = await waitFor(() => got.find((m) => m.t === "notes"), 3000, "list");
    if (listed.t !== "notes") throw new Error("unreachable");
    expect(listed.notes.map((n) => n.text)).toEqual(["fresh plan", "old thoughts"]);
    expect(listed.notes[0]).toMatchObject({ session: "live", live: { session: "live", windowId: win.id } });
    expect(listed.notes[1]).toMatchObject({ session: "Gone", window: "zsh" });
    expect(listed.notes[1].live).toBeUndefined();

    send({ t: "note-delete", noteId: opened.noteId });
    await waitFor(() => got.find((m) => m.t === "note-deleted"), 3000, "deleted");
    expect(existsSync(join(dir, `${opened.noteId}.md`))).toBe(false);
    // The window gives up the id: its next note is a new one.
    send({ t: "note-open", session: "live", id: win.id });
    await waitFor(() => got.filter((m) => m.t === "note").length === 2, 3000, "reopen");
    const reopened = got.filter((m) => m.t === "note")[1];
    expect(reopened.t === "note" && reopened.noteId).not.toBe(opened.noteId);
    expect(reopened.t === "note" && reopened.text).toBe("");
  } finally {
    ws.close();
    srv.stop();
    await tmux.killServer();
  }
});

// ---- a note follows its conversation into a new window ----

test("a window's conversation ids: the one it holds, and the one it was forked from", () => {
  expect(conversationIds({ sessionId: "F", transcriptPath: "/a/F.jsonl" }, { sessionId: "F", transcriptPath: "/b/S.jsonl" })).toEqual(["F", "S"]);
  expect(conversationIds({ sessionId: "S", transcriptPath: "/a/S.jsonl" }, null)).toEqual(["S"]);
  expect(conversationIds(null, null)).toEqual([]);
});

test("a note remembers every conversation it was written beside, without being touched", async () => {
  const dir = scratch();
  const store = createNoteStore(dir);
  await store.link(ID, ["S"]); // nothing written yet: nothing to remember
  expect(existsSync(join(dir, `${ID}.json`))).toBe(false);
  await store.write(ID, "text", { session: "s", window: "w", conversations: ["S"] });
  const updated = (await store.read(ID)).updated;
  await store.link(ID, ["F", "S"]);
  await store.write(ID, "text", { session: "s", window: "w", conversations: ["G"] });
  const [n] = await store.list();
  expect(n!.meta.conversations).toEqual(["S", "F", "G"]);
  await store.link(ID, ["S"]);
  expect((await store.read(ID)).updated >= updated).toBe(true);
});

test("an orphan is a written note no window wears, newest first, of the same conversation", () => {
  const note = (noteId: string, text: string, updated: string, conversations: string[]) =>
    ({ noteId, text, updated, meta: { conversations } });
  const stored = [
    note("old", "older", "2026-10-01T00:00:00Z", ["S"]),
    note("new", "newer", "2026-10-08T00:00:00Z", ["S", "F"]),
    note("blank", " ", "2026-10-09T00:00:00Z", ["S"]),
    note("other", "x", "2026-10-09T00:00:00Z", ["T"]),
  ];
  expect(pickOrphan(stored, new Set(), ["F"])).toBe("new");
  expect(pickOrphan(stored, new Set(["new"]), ["S"])).toBe("old");
  expect(pickOrphan(stored, new Set(["new", "old"]), ["S"])).toBeNull();
  expect(pickOrphan(stored, new Set(), [])).toBeNull();
});

test("a note follows its conversation to a new window, never taken from a live one, never over a written one", async () => {
  const SOCK = "cmux-viewer-test-notes-follow";
  const tmux = new Tmux(SOCK);
  await tmux.killServer();
  const dir = scratch();
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCK, pollMs: 100, notesDir: dir });
  const sh = (...a: string[]) => Bun.spawnSync(["tmux", "-L", SOCK, ...a]).stdout.toString().trim();
  const holding = (win: string, session: string) => sh("set-option", "-p", "-t", win, "@muxnexus_session", `${session} /tmp/${session}.jsonl`);
  const newWindow = () => sh("new-window", "-d", "-t", "follow:", "-P", "-F", "#{window_id}");
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } } as any);
  const got: ServerMessage[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  const open = async (id: string) => {
    const before = got.filter((m) => m.t === "note").length;
    ws.send(JSON.stringify({ t: "note-open", session: "follow", id }));
    await waitFor(() => got.filter((m) => m.t === "note").length > before, 3000, "note");
    const m = got.filter((x) => x.t === "note").at(-1)!;
    if (m.t !== "note") throw new Error("unreachable");
    return m;
  };
  const save = async (noteId: string, text: string) => {
    ws.send(JSON.stringify({ t: "note-save", noteId, text }));
    await waitFor(() => existsSync(join(dir, `${noteId}.md`)) && readFileSync(join(dir, `${noteId}.md`), "utf8") === text, 3000, "saved");
  };
  try {
    await tmux.newSession("follow");
    const first = sh("display", "-p", "-t", "follow:", "#{window_id}");
    holding(first, "S1");
    const kept = await open(first);
    await save(kept.noteId, "keep me");

    // The tab dies; the conversation is resumed in a new one.
    const second = newWindow();
    sh("kill-window", "-t", first);
    holding(second, "S1");
    const followed = await open(second);
    expect(followed).toMatchObject({ noteId: kept.noteId, text: "keep me" });

    // A third tab of the same conversation does not take it from the second.
    const third = newWindow();
    holding(third, "S1");
    expect((await open(third)).noteId).not.toBe(kept.noteId);

    // A blank note, opened before the resume, gives way to the orphan...
    const fourth = newWindow();
    const blank = await open(fourth);
    expect(blank.text).toBe("");
    sh("kill-window", "-t", second);
    holding(fourth, "S1");
    expect(await open(fourth)).toMatchObject({ noteId: kept.noteId, text: "keep me" });

    // ...but a written one is never replaced.
    const fifth = newWindow();
    const mine = await open(fifth);
    await save(mine.noteId, "mine");
    sh("kill-window", "-t", fourth);
    holding(fifth, "S1");
    expect(await open(fifth)).toMatchObject({ noteId: mine.noteId, text: "mine" });
    ws.close();
  } finally {
    srv.stop();
    await tmux.killServer();
  }
});
