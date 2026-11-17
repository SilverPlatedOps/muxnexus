import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesLine, diffRows } from "../src/client/conversation/changes";
import { changesIn, diffOf, isListedPath, MAX_DIFF_LINES } from "../src/server/conversation/changes";

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "mnx-changes-"));
  made.push(d);
  return d;
}
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=lab@example.invalid", "-c", "user.name=Lab", "-c", "commit.gpgsign=false", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}
/** A repository with one commit: cart.ts, notes.md, old.txt and a .gitignore. */
function repo(): string {
  const d = folder();
  git(d, "init", "-q");
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src/cart.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(d, "notes.md"), "# notes\n");
  writeFileSync(join(d, "old.txt"), "one\ntwo\n");
  writeFileSync(join(d, ".gitignore"), "*.log\n");
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
}

test("a folder outside any repository says so", async () => {
  expect(await changesIn(folder())).toEqual({ error: "not-git" });
});

test("a clean repository has no changes, and names its branch", async () => {
  const d = repo();
  git(d, "checkout", "-qb", "feature/cart");
  const r = await changesIn(join(d, "src"));
  expect("error" in r).toBe(false);
  if ("error" in r) return;
  expect(r.files).toEqual([]);
  expect(r.branch).toBe("feature/cart");
  expect(r.more).toBe(0);
});

test("every kind of change is listed by path, with its counts, read from a subfolder", async () => {
  const d = repo();
  writeFileSync(join(d, "src/cart.ts"), "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  writeFileSync(join(d, "src/tax.ts"), "export const rate = 0.11;\n");
  git(d, "add", "src/tax.ts");
  unlinkSync(join(d, "old.txt"));
  writeFileSync(join(d, "draft.txt"), "a\nb\nc");
  writeFileSync(join(d, "logo.bin"), new Uint8Array([137, 80, 0, 1, 2]));
  writeFileSync(join(d, "debug.log"), "ignored\n");
  const r = await changesIn(join(d, "src"));
  if ("error" in r) throw new Error(r.error);
  expect(r.files).toEqual([
    { path: "draft.txt", status: "untracked", added: 3, removed: 0, binary: false },
    { path: "logo.bin", status: "untracked", added: null, removed: null, binary: true },
    { path: "old.txt", status: "deleted", added: 0, removed: 2, binary: false },
    { path: "src/cart.ts", status: "modified", added: 2, removed: 1, binary: false },
    { path: "src/tax.ts", status: "added", added: 1, removed: 0, binary: false },
  ]);
});

test("a repository with no commit yet compares with nothing", async () => {
  const d = folder();
  git(d, "init", "-q");
  writeFileSync(join(d, "a.txt"), "x\n");
  git(d, "add", "a.txt");
  writeFileSync(join(d, "b.txt"), "y\n");
  const r = await changesIn(d);
  if ("error" in r) throw new Error(r.error);
  expect(r.files.map((f) => [f.path, f.status])).toEqual([["a.txt", "added"], ["b.txt", "untracked"]]);
  const diff = await diffOf(d, "a.txt");
  expect("error" in diff ? diff.error : diff.diff).toContain("+x");
});

test("a file's diff: tracked against the last commit, untracked as all added, binary as no text", async () => {
  const d = repo();
  writeFileSync(join(d, "src/cart.ts"), "export const a = 1;\nexport const b = 3;\n");
  unlinkSync(join(d, "old.txt"));
  writeFileSync(join(d, "draft.txt"), "first\nsecond");
  writeFileSync(join(d, "logo.bin"), new Uint8Array([137, 80, 0, 1, 2]));
  const mod = await diffOf(d, "src/cart.ts");
  if ("error" in mod) throw new Error(mod.error);
  expect(mod.diff).toContain("@@");
  expect(mod.diff).toContain("-export const b = 2;");
  expect(mod.diff).toContain("+export const b = 3;");
  expect(mod.truncated).toBe(false);
  const del = await diffOf(d, "old.txt");
  expect("error" in del ? del.error : del.diff).toContain("-two");
  expect(await diffOf(d, "draft.txt")).toEqual({ diff: "@@ -0,0 +1,2 @@\n+first\n+second\n", truncated: false, binary: false });
  expect(await diffOf(d, "logo.bin")).toEqual({ diff: "", truncated: false, binary: true });
});

test("only a changed or untracked file is read: never any other path in or out of the folder", async () => {
  const d = repo();
  writeFileSync(join(d, "debug.log"), "ignored\n");
  expect(await diffOf(d, "notes.md")).toEqual({ error: "gone" }); // tracked, unchanged
  expect(await diffOf(d, "debug.log")).toEqual({ error: "gone" }); // ignored
  expect(await diffOf(d, "missing.txt")).toEqual({ error: "gone" });
  for (const bad of ["../x", "/etc/hosts", "src//cart.ts", "src/../notes.md", "", "a\0b"]) {
    expect(isListedPath(bad)).toBe(false);
    expect(await diffOf(d, bad)).toEqual({ error: "gone" });
  }
  // An untracked link shows where it points, as git does, not the file it points at.
  const outside = join(folder(), "secret.txt");
  writeFileSync(outside, "do not show\n");
  symlinkSync(outside, join(d, "link.txt"));
  const link = await diffOf(d, "link.txt");
  if ("error" in link) throw new Error(link.error);
  expect(link.diff).toBe(`@@ -0,0 +1 @@\n+${outside}\n`);
  expect(link.diff).not.toContain("do not show");
});

test("a long diff is cut for the phone", async () => {
  const d = repo();
  writeFileSync(join(d, "notes.md"), Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const r = await diffOf(d, "notes.md");
  if ("error" in r) throw new Error(r.error);
  expect(r.truncated).toBe(true);
  expect(r.diff.split("\n").length).toBeLessThanOrEqual(MAX_DIFF_LINES);
});


test("a diff is drawn from its first hunk, each line by kind", () => {
  const diff = [
    "diff --git a/src/cart.ts b/src/cart.ts",
    "index 1111111..2222222 100644",
    "--- a/src/cart.ts",
    "+++ b/src/cart.ts",
    "@@ -1,2 +1,2 @@ export function total",
    " export const a = 1;",
    "-export const b = 2;",
    "+export const b = 3;",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  expect(diffRows(diff)).toEqual([
    { kind: "hunk", text: "@@ -1,2 +1,2 @@ export function total" },
    { kind: "ctx", text: "export const a = 1;" },
    { kind: "del", text: "export const b = 2;" },
    { kind: "add", text: "export const b = 3;" },
    { kind: "note", text: "No newline at end of file" },
  ]);
  // A line that only looks like a header, inside a hunk, is a line.
  expect(diffRows("@@ -1 +1 @@\n---- a heading\n+++ plus\n").map((r) => r.kind)).toEqual(["hunk", "del", "add"]);
  expect(diffRows("")).toEqual([]);
  expect(diffRows("Binary files a/x and b/x differ\n")).toEqual([]);
});

test("the sheet's line adds up files and lines, unknown counts as none", () => {
  expect(changesLine([
    { path: "a", status: "modified", added: 10, removed: 4, binary: false },
    { path: "b", status: "untracked", added: null, removed: 0, binary: false },
    { path: "c", status: "untracked", added: null, removed: null, binary: true },
  ], 0)).toBe("3 files · +10 −4");
  expect(changesLine([{ path: "a", status: "deleted", added: 0, removed: 2, binary: false }], 2)).toBe("3 files · +0 −2");
  expect(changesLine([{ path: "a", status: "added", added: 1, removed: 0, binary: false }], 0)).toBe("1 file · +1 −0");
});
