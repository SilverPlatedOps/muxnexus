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
      await put(path(id, "json"), JSON.stringify({ ...old, ...(meta ?? {}), created: old.created ?? updated, updated }, null, 2));
      return { text, updated };
    },
  };
}

export type NoteStore = ReturnType<typeof createNoteStore>;
