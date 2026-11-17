// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChangedFile, ChangesError } from "../../shared/conversation";

/**
 * The uncommitted changes in the folder a tab's agent works in, for the Changes
 * sheet: what is different from the last commit, staged or not, and the files
 * git doesn't track yet. Read-only, and without git's optional locks, so an
 * agent committing at that moment never finds the index taken.
 */

/** git's empty tree: what a repository with no commit yet is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_MS = 5000;
/** The most files the list names; the rest are only counted. */
export const MAX_FILES = 300;
/** A diff is cut here: a phone reads no further, and a lockfile's would be megabytes. */
export const MAX_DIFF_BYTES = 256 * 1024;
export const MAX_DIFF_LINES = 4000;
/** An untracked file larger than this is listed with no line count. */
const COUNT_BYTES = 1024 * 1024;

/** git's output, read no further than `limit` bytes (`cut` then says it stopped there). */
async function git(cwd: string, args: string[], limit = 8 * 1024 * 1024): Promise<{ ok: boolean; out: string; cut: boolean }> {
  const p = Bun.spawn(["git", "--no-optional-locks", "-c", "core.quotePath=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIT_MS,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  const reader = p.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > limit) {
      cut = true;
      p.kill("SIGKILL");
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const code = await p.exited;
  const out = new TextDecoder().decode(Buffer.concat(chunks)).slice(0, cut ? limit : undefined);
  return { ok: cut || code === 0, out, cut };
}

/** The repository's top folder and what it is compared with, or why there is none. */
async function repoOf(cwd: string): Promise<{ root: string; base: string } | { error: ChangesError }> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => null);
  if (!top) return { error: "git" };
  if (!top.ok) return { error: "not-git" };
  const root = top.out.replace(/\n$/, "");
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return { root, base: head.ok ? "HEAD" : EMPTY_TREE };
}

const fields = (out: string) => out.split("\0").filter((f) => f !== "");

/** Whether these bytes look like a binary file's, as git decides it: a NUL in the first 8000. */
const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

/** An untracked file's line count, or null when it is too large to read for one; binary when it is. */
async function countLines(path: string): Promise<{ added: number | null; binary: boolean }> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return { added: 1, binary: false };
    if (!st.isFile()) return { added: null, binary: false };
    if (st.size > COUNT_BYTES) return { added: null, binary: false };
    const bytes = await Bun.file(path).bytes();
    if (isBinary(bytes)) return { added: null, binary: true };
    let n = 0;
    for (const b of bytes) if (b === 10) n++;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) n++;
    return { added: n, binary: false };
  } catch {
    return { added: null, binary: false };
  }
}

export type ChangesResult = { root: string; branch: string | null; files: ChangedFile[]; more: number } | { error: ChangesError };

/** What has changed in the repository `cwd` is in, against its last commit. */
export async function changesIn(cwd: string): Promise<ChangesResult> {
  const repo = await repoOf(cwd);
  if ("error" in repo) return repo;
  const { root, base } = repo;
  const [names, counts, others, branch] = await Promise.all([
    git(root, ["diff", base, "--name-status", "-z", "--no-renames"]),
    git(root, ["diff", base, "--numstat", "-z", "--no-renames"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
  ]);
  if (!names.ok || !counts.ok || !others.ok || names.cut || counts.cut) return { error: "git" };
  const status = new Map<string, ChangedFile["status"]>();
  const n = fields(names.out);
  for (let i = 0; i + 1 < n.length; i += 2) status.set(n[i + 1]!, n[i] === "A" ? "added" : n[i] === "D" ? "deleted" : "modified");
  const files: ChangedFile[] = [];
  for (const row of fields(counts.out)) {
    const [a, r, ...rest] = row.split("\t");
    const path = rest.join("\t");
    const binary = a === "-" && r === "-";
    files.push({ path, status: status.get(path) ?? "modified", added: binary ? null : Number(a), removed: binary ? null : Number(r), binary });
  }
  // A path git lists by name but not by count (a mode change alone): still changed.
  for (const [path, s] of status) if (!files.some((f) => f.path === path)) files.push({ path, status: s, added: 0, removed: 0, binary: false });
  const untracked = fields(others.out);
  const listed = Math.max(0, MAX_FILES - files.length);
  for (const path of untracked.slice(0, listed)) {
    const c = await countLines(join(root, path));
    files.push({ path, status: "untracked", added: c.added, removed: c.binary ? null : 0, binary: c.binary });
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const more = Math.max(0, files.length - MAX_FILES) + Math.max(0, untracked.length - listed) + (others.cut ? 1 : 0);
  return { root, branch: branch.ok && branch.out.trim() !== "" ? branch.out.trim() : null, files: files.slice(0, MAX_FILES), more };
}

/** A path as `changesIn` lists it: relative to the repository's top, inside it. */
export function isListedPath(path: string): boolean {
  if (path === "" || path.length > 4096 || path.includes("\0") || path.startsWith("/")) return false;
  return !path.split("/").some((s) => s === ".." || s === "");
}

export type DiffResult = { diff: string; truncated: boolean; binary: boolean } | { error: ChangesError };

/** `text` cut to what a phone shows. */
function cut(text: string, already: boolean): { diff: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length > MAX_DIFF_LINES) return { diff: lines.slice(0, MAX_DIFF_LINES).join("\n"), truncated: true };
  return { diff: text, truncated: already };
}

/**
 * One file's change, as a unified diff: a tracked file's against the last
 * commit, an untracked one's whole content as added. Only a file git calls
 * changed or untracked is read; any other path in the folder is `gone`.
 */
export async function diffOf(cwd: string, path: string): Promise<DiffResult> {
  if (!isListedPath(path)) return { error: "gone" };
  const repo = await repoOf(cwd);
  if ("error" in repo) return repo;
  const { root, base } = repo;
  const spec = `:(literal)${path}`;
  const tracked = await git(root, ["diff", base, "--no-color", "--no-ext-diff", "--no-renames", "--", spec], MAX_DIFF_BYTES);
  if (!tracked.ok) return { error: "git" };
  if (tracked.out !== "") {
    if (/^Binary files .* differ$/m.test(tracked.out) && !tracked.out.includes("\n@@")) return { diff: "", truncated: false, binary: true };
    return { ...cut(tracked.out, tracked.cut), binary: false };
  }
  const other = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", spec]);
  if (!other.ok || fields(other.out)[0] !== path) return { error: "gone" };
  const file = join(root, path);
  try {
    const st = await lstat(file);
    // As git shows a link: its target, never the file it points at.
    if (st.isSymbolicLink()) return { diff: `@@ -0,0 +1 @@\n+${await readlink(file)}\n`, truncated: false, binary: false };
    if (!st.isFile()) return { error: "gone" };
    const fh = await open(file, "r");
    const buf = new Uint8Array(Math.min(st.size, MAX_DIFF_BYTES));
    try {
      await fh.read(buf, 0, buf.length, 0);
    } finally {
      await fh.close();
    }
    if (isBinary(buf)) return { diff: "", truncated: false, binary: true };
    const text = new TextDecoder().decode(buf);
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const body = text === "" ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    return { ...cut(body, st.size > MAX_DIFF_BYTES), binary: false };
  } catch {
    return { error: "gone" };
  }
}
