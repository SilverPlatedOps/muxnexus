import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE } from "../src/server/chat/images";
import { createPasteStore, KEEP_MS } from "../src/server/pastes";
import { createServer, type RunningServer } from "../src/server/server";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("the paste store", () => {
  const root = mkdtempSync(join(tmpdir(), "mxn-paste-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "pastes");
  const store = createPasteStore(dir);

  test("saves a pasted image where a program on this machine can read it, for this user only", async () => {
    const r = await store.save(PNG);
    if (!r.ok) throw new Error(r.error);
    expect(r.name).toMatch(/^\d{13}-[0-9a-f]{8}\.png$/);
    expect(r.path).toBe(join(dir, r.name));
    expect([...readFileSync(r.path)]).toEqual([...PNG]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
  });

  test("refuses empty, oversize and non-image pastes", async () => {
    expect(await store.save(new Uint8Array(0))).toMatchObject({ ok: false, status: 400 });
    expect(await store.save(new Uint8Array(MAX_IMAGE + 1))).toMatchObject({ ok: false, status: 413 });
    expect(await store.save(new TextEncoder().encode("<svg/>"))).toMatchObject({ ok: false, status: 415 });
  });

  test("a paste older than a week goes when the next is saved; anything else stays", async () => {
    const now = Date.now();
    const old = `${now - KEEP_MS - 1000}-deadbeef.png`;
    const fresh = `${now - 1000}-cafef00d.png`;
    for (const name of [old, fresh, "notes.txt"]) writeFileSync(join(dir, name), PNG);
    const r = await store.save(PNG, now);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, fresh))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});

describe("the paste route", () => {
  let server: RunningServer;
  let bare: RunningServer;
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mxn-pastesrv-"));
    server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: "mxn-pastes-test", pollMs: 200, pastesDir: dir });
    bare = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: "mxn-pastes-test", pollMs: 200 });
  });
  afterAll(() => { server.stop(); bare.stop(); rmSync(dir, { recursive: true, force: true }); });
  const url = (s: RunningServer) => `http://127.0.0.1:${s.port}/api/paste-image`;

  test("a page of this server posts an image and is told where it was saved", async () => {
    const res = await fetch(url(server), { method: "POST", headers: { origin: `http://127.0.0.1:${server.port}`, "content-type": "image/png" }, body: PNG });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path.startsWith(dir + "/")).toBe(true);
    expect([...readFileSync(body.path)]).toEqual([...PNG]);
  });

  test("another site cannot post, a non-image is refused, and only POST is answered", async () => {
    expect((await fetch(url(server), { method: "POST", headers: { origin: "http://evil.example" }, body: PNG })).status).toBe(403);
    expect((await fetch(url(server), { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: PNG })).status).toBe(403);
    const refused = await fetch(url(server), { method: "POST", body: "<svg/>" });
    expect(refused.status).toBe(415);
    expect(((await refused.json()) as { error: string }).error).toMatch(/png, jpeg, gif and webp/);
    expect((await fetch(url(server))).status).toBe(405);
  });

  test("a server given no pastes folder has no such route", async () => {
    expect((await fetch(url(bare), { method: "POST", body: PNG })).status).toBe(404);
  });
});
