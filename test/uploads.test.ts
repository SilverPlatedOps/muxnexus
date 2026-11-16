import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MS } from "../src/server/pastes";
import { createServer, type RunningServer } from "../src/server/server";
import { createUploadStore, MAX_UPLOAD, uploadName } from "../src/server/uploads";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TEXT = new TextEncoder().encode("hello\n");

describe("the upload store", () => {
  const root = mkdtempSync(join(tmpdir(), "mxn-upload-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "uploads");
  const store = createUploadStore(dir);

  test("keeps a file under its own name made one word, for this user only", async () => {
    const r = await store.save(TEXT, "Meeting notes (final).txt");
    if (!r.ok) throw new Error(r.error);
    expect(r.name).toMatch(/^\d{13}-[0-9a-f]{8}-Meeting-notes-final\.txt$/);
    expect(r.path).toBe(join(dir, r.name));
    expect(readFileSync(r.path, "utf8")).toBe("hello\n");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(store.pathOf(r.name)).toBe(r.path);
  });

  test("a name never walks out of the folder, and bytes that aren't an image never keep an image's extension", () => {
    expect(uploadName("../../etc/passwd", 1)).toMatch(/^1-[0-9a-f]{8}-passwd$/);
    expect(uploadName("C:\\Users\\x\\report.pdf", 1)).toMatch(/-report\.pdf$/);
    expect(uploadName("..", 1)).toMatch(/-file$/);
    expect(uploadName("", 1)).toMatch(/-file$/);
    // The agents take a pasted path ending .png or .jpg for an image: a file that isn't one is named as text.
    expect(uploadName("photo.PNG", 1)).toMatch(/-photo\.PNG\.txt$/);
    expect(uploadName("IMG_0001.HEIC", 1)).toMatch(/-IMG_0001\.HEIC$/);
    expect(uploadName(`${"a".repeat(300)}.csv`, 1)).toMatch(/^1-[0-9a-f]{8}-a+\.csv$/);
    expect(uploadName(`${"a".repeat(300)}.csv`, 1).length).toBeLessThanOrEqual(13 + 1 + 8 + 1 + 80);
    // A name in another script keeps its extension; dot files and a bare dot are names too.
    expect(uploadName("报告.pdf", 1)).toMatch(/^1-[0-9a-f]{8}-file\.pdf$/);
    expect(uploadName("Résumé.docx", 1)).toMatch(/-Resume\.docx$/);
    expect(uploadName(".bashrc", 1)).toMatch(/-bashrc$/);
    // Long, and an image's extension made text: still a name the store knows again.
    const long = uploadName(`${"b".repeat(300)}.png`, 1_700_000_000_000);
    expect(long).toMatch(/-b+\.png\.txt$/);
    expect(store.pathOf(long)).not.toBeNull();
    // Names this store didn't make are no file of its.
    expect(store.pathOf("../x")).toBeNull();
    expect(store.pathOf("1700000000000-deadbeef.png")).toBeNull();
  });

  test("refuses empty and oversize files", async () => {
    expect(await store.save(new Uint8Array(0), "a.txt")).toMatchObject({ ok: false, status: 400 });
    expect(await store.save(new Uint8Array(MAX_UPLOAD + 1), "a.bin")).toMatchObject({ ok: false, status: 413 });
  });

  test("a file older than a week goes when the next is saved; anything else stays", async () => {
    const now = Date.now();
    const old = `${now - KEEP_MS - 1000}-deadbeef-old.txt`;
    const fresh = `${now - 1000}-cafef00d-fresh.txt`;
    for (const name of [old, fresh, "mine.txt"]) writeFileSync(join(dir, name), TEXT);
    expect((await store.save(TEXT, "next.txt", now)).ok).toBe(true);
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, fresh))).toBe(true);
    expect(existsSync(join(dir, "mine.txt"))).toBe(true);
  });
});

describe("the upload route", () => {
  let server: RunningServer;
  let bare: RunningServer;
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mxn-uploadsrv-"));
    server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: "mxn-uploads-test", pollMs: 200, pastesDir: join(dir, "pastes"), uploadsDir: join(dir, "uploads") });
    bare = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: "mxn-uploads-test", pollMs: 200, pastesDir: join(dir, "pastes") });
  });
  afterAll(() => { server.stop(); bare.stop(); rmSync(dir, { recursive: true, force: true }); });
  const url = (s: RunningServer, name = "") => `http://127.0.0.1:${s.port}/api/upload${name ? `?name=${encodeURIComponent(name)}` : ""}`;
  const post = (s: RunningServer, body: Uint8Array<ArrayBuffer>, name?: string, headers: Record<string, string> = {}) =>
    fetch(url(s, name), { method: "POST", headers: { origin: `http://127.0.0.1:${s.port}`, ...headers }, body });

  test("an image goes in as an image, whatever it was called; anything else as a file under its own name", async () => {
    const image = (await (await post(server, PNG, "notes.txt")).json()) as { ok: boolean; name: string; path: string; image: boolean };
    expect(image).toMatchObject({ ok: true, image: true });
    expect(image.path).toBe(join(dir, "pastes", image.name));
    expect(image.name).toMatch(/^\d{13}-[0-9a-f]{8}\.png$/);
    const file = (await (await post(server, TEXT, "notes.txt")).json()) as { ok: boolean; name: string; path: string; image: boolean };
    expect(file).toMatchObject({ ok: true, image: false });
    expect(file.path).toBe(join(dir, "uploads", file.name));
    expect(readFileSync(file.path, "utf8")).toBe("hello\n");
  });

  test("another site cannot post, an empty file is refused, and only POST is answered", async () => {
    expect((await post(server, TEXT, "a.txt", { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(server, TEXT, "a.txt", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(server, new Uint8Array(0), "a.txt")).status).toBe(400);
    expect((await fetch(url(server))).status).toBe(405);
  });

  test("a server with no uploads folder has no such route", async () => {
    expect((await post(bare, TEXT, "a.txt")).status).toBe(404);
  });
});
