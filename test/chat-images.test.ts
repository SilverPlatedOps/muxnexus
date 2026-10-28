import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownNodes, type MarkdownNode } from "../src/client/chat/markdown";
import { createImageStore, MAX_IMAGE, sniff } from "../src/server/chat/images";
import { createChatStore } from "../src/server/chat/store";
import { newChat } from "../src/server/chat/model";
import { createServer, type RunningServer } from "../src/server/server";
import type { ServerMessage } from "../src/shared/protocol";
import { waitFor } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ID = "11111111-2222-3333-4444-555555555555";
const walk = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);

describe("image bytes", () => {
  test("a type is what the bytes say, not what the request claims", () => {
    expect(sniff(PNG)).toBe("png");
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniff(new TextEncoder().encode("GIF89a.."))).toBe("gif");
    expect(sniff(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniff(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(sniff(new Uint8Array([]))).toBeNull();
  });
});

describe("the image store", () => {
  const dir = mkdtempSync(join(tmpdir(), "mxn-img-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const store = createImageStore(dir);

  test("saves an image under its chat and reads it back", async () => {
    const r = await store.save(ID, PNG);
    if (!r.ok) throw new Error(r.error);
    expect(r.path).toBe(join(dir, ID, "images", r.name));
    expect(r.name).toMatch(/^\d{13}-[0-9a-f]{8}\.png$/);
    expect(existsSync(r.path)).toBe(true);
    const got = await store.read(ID, r.name);
    expect(got?.type).toBe("image/png");
    expect([...got!.bytes]).toEqual([...PNG]);
  });

  test("refuses empty, oversize, non-image and unnamed-chat uploads", async () => {
    expect(await store.save(ID, new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
    expect(await store.save(ID, new Uint8Array(MAX_IMAGE + 1))).toMatchObject({ ok: false, status: 413 });
    expect(await store.save(ID, new TextEncoder().encode("<svg/>"))).toMatchObject({ ok: false, status: 415 });
    expect(await store.save("../etc", PNG)).toMatchObject({ ok: false, status: 400 });
  });

  test("deleting a chat takes its images with it", async () => {
    const chats = createChatStore(dir);
    const id = "99999999-2222-3333-4444-555555555555";
    await chats.save(newChat(id, "gone", new Date().toISOString()));
    const r = await store.save(id, PNG);
    if (!r.ok) throw new Error(r.error);
    await chats.remove(id);
    expect(existsSync(r.path)).toBe(false);
    expect(await store.read(id, r.name)).toBeNull();
  });

  test("reads only names it made, in a real chat id", async () => {
    for (const name of ["../x.png", "a.png", "1234567890123-deadbeef.svg", "1234567890123-deadbeef.png/../../x"]) expect(await store.read(ID, name)).toBeNull();
    expect(await store.read("..", "1234567890123-deadbeef.png")).toBeNull();
  });
});

describe("a pasted image in a post", () => {
  test("is shown from the server's file; any other image stays text", () => {
    const all = walk(markdownNodes(`look\n\n![pasted image](</Users/me/.local/share/muxnexus/chats/${ID}/images/1790000000000-abcdef12.png>)\n\n![x](https://tracker.test/p.png)\n\n![y](</etc/passwd>)`));
    const imgs = all.filter((n) => n.tag === "img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.attrs).toMatchObject({ src: `/api/chat/image/${ID}/1790000000000-abcdef12.png`, class: "chat-image" });
    expect(all.some((n) => (n.attrs?.src ?? "").includes("tracker.test"))).toBe(false);
  });
});

describe("the image routes", () => {
  let server: RunningServer;
  let dir = "";
  let chatId = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mxn-imgsrv-"));
    server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: "mxn-chat-images-test", pollMs: 200, chatsDir: dir });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: `http://127.0.0.1:${server.port}` } } as any);
    const msgs: ServerMessage[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") msgs.push(JSON.parse(e.data)); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
    ws.send(JSON.stringify({ t: "chat-create", name: "pics", members: [] }));
    const made = await waitFor(async () => msgs.find((m) => m.t === "chat-created") as Extract<ServerMessage, { t: "chat-created" }> | undefined, 3000, "chat-created");
    chatId = made.id;
    ws.close();
  });
  afterAll(() => { server.stop(); rmSync(dir, { recursive: true, force: true }); });
  const url = (rest = "") => `http://127.0.0.1:${server.port}/api/chat/image/${chatId}${rest}`;

  test("a page of this server can post an image and fetch it", async () => {
    const res = await fetch(url(), { method: "POST", headers: { origin: `http://127.0.0.1:${server.port}`, "content-type": "image/png" }, body: PNG });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string; path: string; url: string };
    expect(body.url).toBe(`/api/chat/image/${chatId}/${body.name}`);
    expect(body.path).toBe(join(dir, chatId, "images", body.name));
    const got = await fetch(`http://127.0.0.1:${server.port}${body.url}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([...PNG]);
  });

  test("another site cannot post or read, and a non-image is refused", async () => {
    expect((await fetch(url(), { method: "POST", headers: { origin: "http://evil.example" }, body: PNG })).status).toBe(403);
    expect((await fetch(url(), { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: PNG })).status).toBe(403);
    expect((await fetch(url("/1790000000000-abcdef12.png"), { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(url(), { method: "POST", body: "<svg/>" })).status).toBe(415);
  });

  test("an unknown chat or name is not found", async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/chat/image/${ID}`, { method: "POST", body: PNG })).status).toBe(404);
    expect((await fetch(url("/1790000000000-abcdef12.png"))).status).toBe(404);
  });
});
