// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * What this server is set to, as against what each browser remembers for
 * itself: one file, so the phone and the laptop see the same. Today it holds
 * the folders the New agent form looks in for repos.
 */
import { readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ServerSettings } from "../shared/protocol";

export const SETTINGS_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muxnexus", "settings.json");

/** More than anyone types by hand; a cap so a bad save cannot make every scan slow. */
const MAX_FOLDERS = 20;

/** A path as a terminal shows it: `~/github`, not `/Users/me/github`. */
export function tildePath(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** `~/github` → `/Users/me/github`; a full path stays as it is. */
export function expandPath(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** Where to look when nobody has chosen: every `~/github*` folder, so `~/github-work` counts too. */
export function defaultScanFolders(home: string, list: (dir: string) => { name: string; isDirectory(): boolean }[] = (d) => readdirSync(d, { withFileTypes: true })): string[] {
  let entries: { name: string; isDirectory(): boolean }[];
  try { entries = list(home); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && e.name.startsWith("github")).map((e) => `~/${e.name}`).sort();
}

/**
 * The folders as saved: trimmed, without a trailing slash, each once, in the
 * order given. Throws, saying which, on one that is not `~`, `~/…` or a full
 * path: the form shows the message as it is.
 */
export function cleanScanFolders(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((f) => typeof f !== "string")) throw new Error("folders must be a list of paths");
  const out: string[] = [];
  for (const f of raw as string[]) {
    const p = f.trim().replace(/(.)\/+$/, "$1");
    if (!p) continue;
    if (p !== "~" && !p.startsWith("~/") && !isAbsolute(p)) throw new Error(`not a full path: ${p}. Use one like ~/github`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_FOLDERS) throw new Error(`at most ${MAX_FOLDERS} folders`);
  return out;
}

export interface SettingsStore {
  read(): Promise<ServerSettings>;
  /** Checks, saves and returns what was saved; throws a message fit to show when it cannot. */
  save(raw: unknown): Promise<ServerSettings>;
  home: string;
}

export function createSettingsStore(file: string = SETTINGS_FILE, home: string = homedir()): SettingsStore {
  /** Saves run one at a time: two at once would write the same file aside and race to move it. */
  let saving: Promise<unknown> = Promise.resolve();
  return {
    home,
    async read() {
      const saved = await readFile(file, "utf8").then((t) => JSON.parse(t) as unknown).catch(() => null);
      const folders = (saved as { scanFolders?: unknown } | null)?.scanFolders;
      // A file edited by hand into nonsense reads as never saved, not as no folders.
      try { if (folders !== undefined) return { scanFolders: cleanScanFolders(folders) }; } catch { /* fall through */ }
      return { scanFolders: defaultScanFolders(home) };
    },
    save(raw) {
      const run = saving.then(async () => {
        const scanFolders = cleanScanFolders((raw as { scanFolders?: unknown } | null)?.scanFolders);
        for (const f of scanFolders) {
          if (!(await stat(expandPath(f, home)).catch(() => null))?.isDirectory()) throw new Error(`no such folder: ${f}`);
        }
        const settings: ServerSettings = { scanFolders };
        await mkdir(dirname(file), { recursive: true });
        // Written aside and moved into place: a crash mid-write never leaves half a file.
        const aside = `${file}.${process.pid}`;
        await writeFile(aside, `${JSON.stringify(settings, null, 2)}\n`);
        await rename(aside, file);
        return settings;
      });
      saving = run.catch(() => {});
      return run;
    },
  };
}

/**
 * The git checkouts in each folder, and the folder itself if it is one: one
 * level down, as `~/github/shop-api`, sorted by name. A worktree counts (its
 * `.git` is a file), and so does a link to a checkout elsewhere; a hidden
 * folder does not. A folder that is gone is skipped.
 */
export async function scanRepos(folders: readonly string[], home: string): Promise<string[]> {
  const isRepo = async (dir: string) => (await stat(join(dir, ".git")).catch(() => null)) !== null;
  const found = new Set<string>();
  for (const f of folders) {
    const dir = expandPath(f, home);
    if (await isRepo(dir)) found.add(tildePath(dir, home));
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const repos = await Promise.all(entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map(async (e) => ((await isRepo(join(dir, e.name))) ? join(dir, e.name) : null)));
    for (const r of repos) if (r) found.add(tildePath(r, home));
  }
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  return [...found].sort((a, b) => name(a).localeCompare(name(b)) || a.localeCompare(b));
}
