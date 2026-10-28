import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatService, parseChatMessage } from "../src/server/chat/service";
import { createChatStore } from "../src/server/chat/store";
import { MAX_NOTES, type Chat } from "../src/shared/chat";

const T = "2026-10-28T12:00:00.000Z";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxn-notes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A chat with a Claude and a Codex; `failSave` makes the next writes to disk fail. */
async function service() {
  const sends: string[] = [];
  const disk = createChatStore(dir);
  const fail = { on: false };
  /** A write of notes with this text waits for `until`, then fails if `reject`. */
  const hold: { text?: string; until?: Promise<void>; reject?: boolean } = {};
  const store = {
    ...disk,
    save: async (c: Chat) => {
      if (fail.on) throw new Error("disk full");
      if (hold.text && c.notes?.text === hold.text) {
        await hold.until;
        if (hold.reject) throw new Error("disk full");
      }
      return disk.save(c);
    },
  };
  const info = (kind: "claude" | "codex", pane: string) => ({ paneId: pane, kind, pid: kind === "claude" ? 11 : 22, state: "done" as const, since: 1, fresh: true, ...(kind === "codex" ? { thread: { id: "th", path: "/tmp/r.jsonl" } } : { conversation: { sessionId: "s", transcriptPath: "/tmp/c.jsonl" } }) });
  const svc = createChatService({
    store,
    tmux: {
      windowOfPane: async (p) => ({ windowId: p === "%1" ? "@1" : "@2", session: "shop" }),
      agentOfWindow: async (w) => (w === "@1" ? info("claude", "%1") : info("codex", "%2")) as never,
    },
    states: async () => new Map([["@1", { state: "done" as const, session: "shop" }], ["@2", { state: "done" as const, session: "shop" }]]),
    adapters: {
      claude: { kind: "claude", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
      codex: { kind: "codex", send: async (_t, text) => { sends.push(text); return { ok: true }; } },
    },
    socketOf: async () => null,
    receipt: async () => true,
    alive: () => true,
    now: () => T,
    home: "/Users/me",
  });
  const r = await svc.handle({ t: "chat-create", name: "t", members: [{ windowId: "@1" }, { windowId: "@2" }] });
  return { svc, id: (r as { chatId: string }).chatId, sends, fail, hold };
}

describe("chat notes", () => {
  test("a save on the current revision is the next revision, on disk, and adds no line to the chat", async () => {
    const { svc, id } = await service();
    const before = (await svc.view(id))!.chat.messages.length;
    const r = await svc.handle({ t: "chat-notes", id, text: "todo: check the cap", rev: 0, req: "a" });
    expect(r).toEqual({ ok: true, chatId: id, notes: { text: "todo: check the cap", rev: 1, updatedAt: T } });
    expect((await svc.view(id))!.chat.messages.length).toBe(before);
    const saved = (await createChatStore(dir).list()).find((c) => c.id === id)!;
    expect(saved.notes).toEqual({ text: "todo: check the cap", rev: 1, updatedAt: T });
  });

  test("a save from a stale revision is turned back with the newer notes, which stay", async () => {
    const { svc, id } = await service();
    await svc.handle({ t: "chat-notes", id, text: "from window A", rev: 0, req: "a" });
    const r = await svc.handle({ t: "chat-notes", id, text: "from window B", rev: 0, req: "b" });
    expect(r).toEqual({ ok: false, conflict: true, error: "These notes changed in another window.", notes: { text: "from window A", rev: 1, updatedAt: T } });
    expect((await svc.view(id))!.chat.notes?.text).toBe("from window A");
  });

  test("two saves on one revision at once: the first lands, the second is a conflict", async () => {
    const { svc, id } = await service();
    const [a, b] = await Promise.all([
      svc.handle({ t: "chat-notes", id, text: "A", rev: 0, req: "a" }),
      svc.handle({ t: "chat-notes", id, text: "B", rev: 0, req: "b" }),
    ]);
    expect(a).toMatchObject({ ok: true, notes: { text: "A", rev: 1 } });
    expect(b).toMatchObject({ ok: false, conflict: true, notes: { text: "A", rev: 1 } });
  });

  test("the same text again is no new revision", async () => {
    const { svc, id } = await service();
    await svc.handle({ t: "chat-notes", id, text: "same", rev: 0, req: "a" });
    expect(await svc.handle({ t: "chat-notes", id, text: "same", rev: 1, req: "b" })).toMatchObject({ ok: true, notes: { rev: 1 } });
  });

  test("notes on their way to disk aren't shown or searchable until written", async () => {
    const { svc, id, hold } = await service();
    let release!: () => void;
    Object.assign(hold, { text: "pending zebra", until: new Promise<void>((r) => (release = r)) });
    const saving = svc.handle({ t: "chat-notes", id, text: "pending zebra", rev: 0, req: "a" });
    await Bun.sleep(5);
    expect((await svc.view(id))!.chat.notes).toBeUndefined();
    expect((await svc.search("zebra", {})).hits).toEqual([]);
    release();
    expect(await saving).toMatchObject({ ok: true, notes: { rev: 1 } });
    expect((await svc.search("zebra", {})).hits).toHaveLength(1);
  });

  test("a failed notes write with a post saved meanwhile leaves the old notes in memory and on disk", async () => {
    const { svc, id, hold } = await service();
    await svc.handle({ t: "chat-notes", id, text: "kept", rev: 0, req: "a" });
    let release!: () => void;
    Object.assign(hold, { text: "rejected", reject: true, until: new Promise<void>((r) => (release = r)) });
    const saving = svc.handle({ t: "chat-notes", id, text: "rejected", rev: 1, req: "b" });
    await Bun.sleep(5);
    const posting = svc.handle({ t: "chat-post", id, text: "a post meanwhile" });
    release();
    expect((await saving).ok).toBe(false);
    expect((await posting).ok).toBe(true);
    expect((await svc.view(id))!.chat.notes).toMatchObject({ text: "kept", rev: 1 });
    const disk = (await createChatStore(dir).list()).find((c) => c.id === id)!;
    expect(disk.notes).toMatchObject({ text: "kept", rev: 1 });
    expect(disk.messages.some((m) => m.text === "a post meanwhile")).toBe(true);
  });

  test("notes over the limit are refused", async () => {
    const { svc, id } = await service();
    const r = await svc.handle({ t: "chat-notes", id, text: "x".repeat(MAX_NOTES + 1), rev: 0, req: "a" });
    expect(r.ok).toBe(false);
    expect((await svc.view(id))!.chat.notes).toBeUndefined();
  });

  test("a failed write leaves the revision where it was, so the retry still fits", async () => {
    const { svc, id, fail } = await service();
    await svc.handle({ t: "chat-notes", id, text: "one", rev: 0, req: "a" });
    fail.on = true;
    const r = await svc.handle({ t: "chat-notes", id, text: "two", rev: 1, req: "b" });
    expect(r).toMatchObject({ ok: false, error: "Couldn't save the notes: disk full" });
    expect((await svc.view(id))!.chat.notes).toEqual({ text: "one", rev: 1, updatedAt: T });
    fail.on = false;
    expect(await svc.handle({ t: "chat-notes", id, text: "two", rev: 1, req: "c" })).toMatchObject({ ok: true, notes: { rev: 2 } });
  });

  test("notes never reach an agent, nor the sidebar summary", async () => {
    const { svc, id, sends } = await service();
    await svc.handle({ t: "chat-notes", id, text: "SECRET-NOTE", rev: 0, req: "a" });
    await svc.handle({ t: "chat-post", id, text: "@claude1 @codex1 hello" });
    await svc.tick();
    expect(sends.length).toBeGreaterThan(0);
    expect(sends.some((s) => s.includes("SECRET-NOTE"))).toBe(false);
    expect(JSON.stringify(await svc.summaries())).not.toContain("SECRET-NOTE");
  });

  test("a message needs a request id and a whole revision; empty notes are allowed", () => {
    expect(parseChatMessage({ t: "chat-notes", id: "x", text: "", rev: 0, req: "r" })).not.toBeNull();
    expect(parseChatMessage({ t: "chat-notes", id: "x", text: "a", rev: 0 })).toBeNull();
    expect(parseChatMessage({ t: "chat-notes", id: "x", text: "a", rev: 1.5, req: "r" })).toBeNull();
    expect(parseChatMessage({ t: "chat-notes", id: "x", text: "a", rev: -1, req: "r" })).toBeNull();
  });
});

describe("brief revision", () => {
  test("a brief saved from a stale copy is refused; one without a revision still saves", async () => {
    const { svc, id } = await service();
    expect(await svc.handle({ t: "chat-brief", id, text: "first", expectRev: 0 })).toEqual({ ok: true, chatId: id });
    expect((await svc.handle({ t: "chat-brief", id, text: "stale", expectRev: 0 })).ok).toBe(false);
    expect((await svc.view(id))!.chat.brief?.text).toBe("first");
    expect(await svc.handle({ t: "chat-brief", id, text: "legacy" })).toEqual({ ok: true, chatId: id });
    expect((await svc.view(id))!.chat.brief).toMatchObject({ text: "legacy", rev: 2 });
  });
});
