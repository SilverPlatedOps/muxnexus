import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chat } from "../../shared/chat";

/** Beside the notes, so one folder holds what muxnexus keeps of yours. */
export const CHATS_DIR = join(homedir(), ".local", "share", "muxnexus", "chats");

/** The only ids a client may name. There is no auth, so anything else could walk out of the directory. */
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isChatId = (id: unknown): id is string => typeof id === "string" && CHAT_ID.test(id);

export type ChatStore = ReturnType<typeof createChatStore>;

/**
 * One JSON file per chat. Written beside and renamed over, so a crash
 * mid-write leaves the previous chat whole; writes go one at a time, so the
 * last save is the one on disk.
 */
export function createChatStore(dir: string = CHATS_DIR) {
  const path = (id: string) => join(dir, `${id}.json`);
  let queue: Promise<unknown> = Promise.resolve();

  async function read(id: string): Promise<Chat | null> {
    try {
      const chat = JSON.parse(await readFile(path(id), "utf8")) as Chat;
      return chat && typeof chat === "object" && chat.id === id ? chat : null;
    } catch {
      return null;
    }
  }

  return {
    newId: (): string => crypto.randomUUID(),

    async get(id: string): Promise<Chat | null> {
      if (!isChatId(id)) return null;
      return read(id);
    },

    async list(): Promise<Chat[]> {
      const names = await readdir(dir).catch(() => [] as string[]);
      const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isChatId);
      const chats = await Promise.all(ids.map(read));
      return chats.filter((c): c is Chat => c !== null);
    },

    save(chat: Chat): Promise<void> {
      if (!isChatId(chat.id)) return Promise.reject(new Error("invalid chat id"));
      const data = JSON.stringify(chat);
      const run = queue.then(async () => {
        await mkdir(dir, { recursive: true });
        const file = path(chat.id);
        await writeFile(`${file}.tmp`, data);
        await rename(`${file}.tmp`, file);
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
