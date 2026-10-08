import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A window's note, kept on disk under a random id stamped on the window
 * (`@muxnexus_note`). Not tmux's window id: tmux hands `@3` out again after a
 * restart, and a note keyed by it would turn up on a stranger's window.
 */
export const NOTES_DIR = join(homedir(), ".local", "share", "muxnexus", "notes");

/** The only ids a client may name. There is no auth, so anything else could walk out of the directory. */
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isNoteId = (id: unknown): id is string => typeof id === "string" && NOTE_ID.test(id);

/**
 * Where the note was written, as it was at the time. Kept beside the text so a
 * note whose window is long gone can still be found by what it was about.
 */
export interface NoteMeta {
  session: string;
  window: string;
  cwd?: string;
  /**
   * The Claude conversations the window held while the note was beside it. A
   * tab that dies leaves its note behind; the tab its conversation is resumed
   * in finds it again by these (pickOrphan).
   */
  conversations?: string[];
}

export interface Note {
  text: string;
  updated: string;
}

/** A note as the explorer lists it: its text, and where it was last written. */
export interface StoredNote extends Note {
  noteId: string;
  meta: Partial<NoteMeta>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

/**
 * The note a window holding one of `ids` should wear instead of a blank one:
 * a written note no window wears, recorded beside one of those conversations,
 * the newest if several are. Never one a live window still wears.
 */
export function pickOrphan(stored: readonly StoredNote[], worn: ReadonlySet<string>, ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const hit = stored
    .filter((n) => !worn.has(n.noteId) && n.text.trim() !== "" && (n.meta.conversations ?? []).some((c) => ids.includes(c)))
    .sort((a, b) => b.updated.localeCompare(a.updated))[0];
  return hit?.noteId ?? null;
}

export function createNoteStore(dir: string = NOTES_DIR) {
  const path = (id: string, ext: string) => join(dir, `${id}.${ext}`);

  /** Written beside, then renamed over: a crash mid-write leaves the old note, not half of it. */
  async function put(file: string, data: string) {
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
  }

  return {
    async read(id: string): Promise<Note> {
      if (!isNoteId(id)) throw new Error("invalid note id");
      try {
        const text = await readFile(path(id, "md"), "utf8");
        const meta = JSON.parse(await readFile(path(id, "json"), "utf8").catch(() => "{}"));
        return { text, updated: typeof meta.updated === "string" ? meta.updated : "" };
      } catch {
        return { text: "", updated: "" };
      }
    },

    /** Every note on disk. Small enough to read whole: a few hundred drafts are a few hundred kilobytes. */
    async list(): Promise<StoredNote[]> {
      const names = await readdir(dir).catch(() => [] as string[]);
      const ids = names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3)).filter(isNoteId);
      return Promise.all(ids.map(async (noteId) => {
        const text = await readFile(path(noteId, "md"), "utf8").catch(() => "");
        const raw = JSON.parse(await readFile(path(noteId, "json"), "utf8").catch(() => "{}"));
        const meta: Partial<NoteMeta> = {};
        if (typeof raw.session === "string") meta.session = raw.session;
        if (typeof raw.window === "string") meta.window = raw.window;
        if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
        if (Array.isArray(raw.conversations)) meta.conversations = strings(raw.conversations);
        return { noteId, text, updated: typeof raw.updated === "string" ? raw.updated : "", meta };
      }));
    },

    async remove(id: string): Promise<void> {
      if (!isNoteId(id)) throw new Error("invalid note id");
      await rm(path(id, "md"), { force: true });
      await rm(path(id, "json"), { force: true });
    },

    async write(id: string, text: string, meta: NoteMeta | null): Promise<Note> {
      if (!isNoteId(id)) throw new Error("invalid note id");
      await mkdir(dir, { recursive: true });
      const old = JSON.parse(await readFile(path(id, "json"), "utf8").catch(() => "{}"));
      const updated = new Date().toISOString();
      await put(path(id, "md"), text);
      // A window killed while its note was open still saves; the last known
      // place it came from is kept rather than blanked.
      const conversations = union(strings(old.conversations), meta?.conversations ?? []);
      await put(path(id, "json"), JSON.stringify({
        ...old, ...(meta ?? {}), ...(conversations.length ? { conversations } : {}), created: old.created ?? updated, updated,
      }, null, 2));
      return { text, updated };
    },

    /** Remember `ids` beside a written note, leaving its text and time as they were. */
    async link(id: string, ids: readonly string[]): Promise<void> {
      if (!isNoteId(id) || !ids.length || !existsSync(path(id, "md"))) return;
      const old = JSON.parse(await readFile(path(id, "json"), "utf8").catch(() => "{}"));
      const had = strings(old.conversations);
      if (ids.every((c) => had.includes(c))) return;
      await put(path(id, "json"), JSON.stringify({ ...old, conversations: union(had, ids) }, null, 2));
    },
  };
}

export type NoteStore = ReturnType<typeof createNoteStore>;
