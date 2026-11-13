import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../src/shared/protocol";
import { cleanScanFolders, createSettingsStore, defaultScanFolders, expandPath, scanRepos, tildePath } from "../src/server/settings";
import { createServer } from "../src/server/server";
import { waitFor } from "./helpers";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "mx-settings-"));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A home with `~/github/{a,b}` as checkouts, `~/github/notes` not one, and `~/github-work/c` a worktree. */
function home(): string {
  const h = scratch();
  for (const r of ["github/b-api", "github/a-ui", "github-work/c-svc"]) mkdirSync(join(h, r), { recursive: true });
  mkdirSync(join(h, "github/b-api/.git"));
  mkdirSync(join(h, "github/a-ui/.git"));
  writeFileSync(join(h, "github-work/c-svc/.git"), "gitdir: elsewhere\n");
  mkdirSync(join(h, "github/notes"));
  mkdirSync(join(h, "github/.hidden/.git"), { recursive: true });
  mkdirSync(join(h, "Documents"));
  return h;
}

test("paths read as a terminal shows them, and back", () => {
  expect(tildePath("/u/me", "/u/me")).toBe("~");
  expect(tildePath("/u/me/github/x", "/u/me")).toBe("~/github/x");
  expect(tildePath("/u/meadow/x", "/u/me")).toBe("/u/meadow/x");
  expect(expandPath("~", "/u/me")).toBe("/u/me");
  expect(expandPath("~/github", "/u/me")).toBe("/u/me/github");
  expect(expandPath("/srv/code", "/u/me")).toBe("/srv/code");
});

test("by default every ~/github* folder is scanned, and nothing else", () => {
  expect(defaultScanFolders(home())).toEqual(["~/github", "~/github-work"]);
  expect(defaultScanFolders(join(scratch(), "missing"))).toEqual([]);
});

test("saved folders are trimmed, deduplicated, and must be full paths", () => {
  expect(cleanScanFolders([" ~/github/ ", "~/github", "", "/srv/code", "~"])).toEqual(["~/github", "/srv/code", "~"]);
  expect(cleanScanFolders(["/"])).toEqual(["/"]);
  expect(() => cleanScanFolders(["github"])).toThrow("not a full path: github");
  expect(() => cleanScanFolders("~/github")).toThrow("a list of paths");
  expect(() => cleanScanFolders([1])).toThrow("a list of paths");
  expect(() => cleanScanFolders(Array.from({ length: 21 }, (_, i) => `/f${i}`))).toThrow("at most 20");
});

test("the scan finds checkouts and worktrees one level down, sorted by name", async () => {
  const h = home();
  expect(await scanRepos(["~/github", "~/github-work", "~/gone"], h)).toEqual(["~/github/a-ui", "~/github/b-api", "~/github-work/c-svc"]);
  // A link to a checkout elsewhere counts; a link to a plain folder does not.
  const elsewhere = scratch();
  mkdirSync(join(elsewhere, "linked/.git"), { recursive: true });
  mkdirSync(join(elsewhere, "plain"));
  symlinkSync(join(elsewhere, "linked"), join(h, "github-work/linked"));
  symlinkSync(join(elsewhere, "plain"), join(h, "github-work/plain"));
  expect(await scanRepos(["~/github-work"], h)).toEqual(["~/github-work/c-svc", "~/github-work/linked"]);
  // A folder that is itself a checkout is offered too, once.
  expect(await scanRepos(["~/github/a-ui", "~/github/a-ui"], h)).toEqual(["~/github/a-ui"]);
});

test("settings read the defaults until saved, and a save survives a new store", async () => {
  const h = home();
  const file = join(scratch(), "conf", "settings.json");
  const store = createSettingsStore(file, h);
  expect(await store.read()).toEqual({ scanFolders: ["~/github", "~/github-work"] });
  expect(await store.save({ scanFolders: ["~/github-work/", "~/github-work"] })).toEqual({ scanFolders: ["~/github-work"] });
  expect(await createSettingsStore(file, h).read()).toEqual({ scanFolders: ["~/github-work"] });
  // Every folder removed is a choice, not a reset to the defaults.
  await store.save({ scanFolders: [] });
  expect(await store.read()).toEqual({ scanFolders: [] });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ scanFolders: [] });
});

test("a save naming a missing folder is refused and changes nothing", async () => {
  const h = home();
  const file = join(scratch(), "settings.json");
  const store = createSettingsStore(file, h);
  await store.save({ scanFolders: ["~/github"] });
  await expect(store.save({ scanFolders: ["~/github", "~/nope"] })).rejects.toThrow("no such folder: ~/nope");
  // A file is not a folder.
  writeFileSync(join(h, "plain.txt"), "");
  await expect(store.save({ scanFolders: ["~/plain.txt"] })).rejects.toThrow("no such folder: ~/plain.txt");
  expect(await store.read()).toEqual({ scanFolders: ["~/github"] });
});

test("saves sent at once all land, in the order sent", async () => {
  const h = home();
  const store = createSettingsStore(join(scratch(), "settings.json"), h);
  const lists = [["~/github"], ["~/nope"], ["~/github-work"], ["~/github", "~/github-work"]];
  const results = await Promise.allSettled(lists.map((scanFolders) => store.save({ scanFolders })));
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  expect(await store.read()).toEqual({ scanFolders: ["~/github", "~/github-work"] });
});

test("a settings file edited into nonsense reads as never saved", async () => {
  const h = home();
  const file = join(scratch(), "settings.json");
  writeFileSync(file, "{ not json");
  expect(await createSettingsStore(file, h).read()).toEqual({ scanFolders: ["~/github", "~/github-work"] });
  writeFileSync(file, JSON.stringify({ scanFolders: ["relative"] }));
  expect(await createSettingsStore(file, h).read()).toEqual({ scanFolders: ["~/github", "~/github-work"] });
});

test("over the socket: settings are read, a save reaches every browser, a bad one only its sender, and repos follow the folders", async () => {
  const h = home();
  const settings = createSettingsStore(join(scratch(), "settings.json"), h);
  const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: `mx-settings-${process.pid}`, pollMs: 60_000, settings });
  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { Origin: `http://127.0.0.1:${srv.port}` } } as any);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
    await new Promise<void>((res) => { ws.onopen = () => res(); });
    return { ws, got, send: (m: object) => ws.send(JSON.stringify(m)) };
  };
  const a = await open();
  const b = await open();
  const last = <T extends ServerMessage["t"]>(got: ServerMessage[], t: T) => [...got].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  try {
    a.send({ t: "settings-get" });
    expect((await waitFor(() => last(a.got, "settings"))).settings).toEqual({ scanFolders: ["~/github", "~/github-work"] });

    a.send({ t: "repos" });
    expect((await waitFor(() => last(a.got, "repos"))).repos).toEqual(["~/github/a-ui", "~/github/b-api", "~/github-work/c-svc"]);

    a.send({ t: "settings-save", settings: { scanFolders: ["~/github-work"] } });
    expect((await waitFor(() => last(b.got, "settings"))).settings).toEqual({ scanFolders: ["~/github-work"] });

    a.got.length = 0;
    a.send({ t: "repos" });
    expect((await waitFor(() => last(a.got, "repos"))).repos).toEqual(["~/github-work/c-svc"]);

    b.got.length = 0;
    a.got.length = 0;
    a.send({ t: "settings-save", settings: { scanFolders: ["~/nope"] } });
    const refused = await waitFor(() => last(a.got, "settings"));
    expect(refused).toEqual({ t: "settings", settings: { scanFolders: ["~/github-work"] }, error: "no such folder: ~/nope" });
    await Bun.sleep(100);
    expect(last(b.got, "settings")).toBeUndefined();
  } finally {
    a.ws.close();
    b.ws.close();
    srv.stop();
  }
});
