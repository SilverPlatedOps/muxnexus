import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMember, newChat, post } from "../src/server/chat/model";
import { createChatStore, isChatId } from "../src/server/chat/store";

const T = "2026-10-26T12:00:00.000Z";
let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxn-chats-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("chat store", () => {
  test("a saved chat reads back equal", async () => {
    const store = createChatStore(dir);
    const chat = newChat(store.newId(), "shop review", T);
    addMember(chat, { kind: "claude", windowId: "@1" }, T);
    post(chat, "user", "@claude1 go", T);
    await store.save(chat);
    expect(await store.get(chat.id)).toEqual(chat);
  });

  test("list returns every chat, skipping unreadable files", async () => {
    const store = createChatStore(dir);
    const a = newChat(store.newId(), "a", T);
    const b = newChat(store.newId(), "b", T);
    await store.save(a);
    await store.save(b);
    writeFileSync(join(dir, "0123abcd-0000-4000-8000-000000000000.json"), "{not json");
    const names = (await store.list()).map((c) => c.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  test("a bad id is refused", async () => {
    const store = createChatStore(dir);
    expect(isChatId("../x")).toBe(false);
    expect(isChatId(store.newId())).toBe(true);
    expect(await store.get("../x")).toBeNull();
  });

  test("a restart keeps queued deliveries and the cap count", async () => {
    const chat = newChat(createChatStore(dir).newId(), "x", T);
    addMember(chat, { kind: "codex", windowId: "@2" }, T);
    post(chat, "codex1", "thinking aloud", T);
    const m = post(chat, "user", "@codex1 review", T);
    m.deliveries.codex1 = { state: "queued", reason: "sent", at: T };
    await createChatStore(dir).save(chat);
    const back = await createChatStore(dir).get(chat.id);
    expect(back?.messages.at(-1)?.deliveries.codex1).toEqual({ state: "queued", reason: "sent", at: T });
    expect(back?.agentRun).toBe(0);
    expect(back?.nextId).toBe(chat.nextId);
  });

  test("writes are serialised: the last save wins", async () => {
    const store = createChatStore(dir);
    const chat = newChat(store.newId(), "first", T);
    const saves = [];
    for (const name of ["one", "two", "three"]) {
      saves.push(store.save({ ...chat, name }));
    }
    await Promise.all(saves);
    expect((await store.get(chat.id))?.name).toBe("three");
  });

  test("remove deletes the chat's file, after any save queued before it", async () => {
    const store = createChatStore(dir);
    const chat = newChat(store.newId(), "first", T);
    await store.save(chat);
    const late = store.save({ ...chat, name: "late" });
    await store.remove(chat.id);
    await late;
    expect(await store.get(chat.id)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});
