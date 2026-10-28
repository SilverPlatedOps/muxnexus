import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isChatId } from "./store";

/**
 * Images pasted into a chat: kept beside the chat, under its own folder, so
 * deleting the chat takes them with it. An agent reads one by its path, which
 * the message carries; the browser shows it from the same file.
 */

/** Large enough for a retina screenshot, small enough that a paste can't fill the disk. */
export const MAX_IMAGE = 10 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The only names a client may ask for: nothing here can walk out of the folder. */
const NAME = /^\d{13}-[0-9a-f]{8}\.(png|jpg|gif|webp)$/;

/** What the bytes say they are, whatever the request called them. */
export function sniff(b: Uint8Array): keyof typeof IMAGE_TYPES | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (b.length >= 6 && at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export type ImageResult = { ok: true; name: string; path: string } | { ok: false; status: number; error: string };

export function createImageStore(chatsDir: string) {
  const folder = (id: string) => join(chatsDir, id, "images");
  return {
    async save(chatId: string, bytes: Uint8Array): Promise<ImageResult> {
      if (!isChatId(chatId)) return { ok: false, status: 400, error: "No such chat." };
      if (bytes.length === 0) return { ok: false, status: 400, error: "That image is empty." };
      if (bytes.length > MAX_IMAGE) return { ok: false, status: 413, error: `That image is ${(bytes.length / 1048576).toFixed(1)} MB; the most is ${MAX_IMAGE / 1048576} MB.` };
      const kind = sniff(bytes);
      if (!kind) return { ok: false, status: 415, error: "Only png, jpeg, gif and webp images can be pasted." };
      const name = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${kind}`;
      await mkdir(folder(chatId), { recursive: true });
      await writeFile(join(folder(chatId), name), bytes);
      return { ok: true, name, path: join(folder(chatId), name) };
    },
    async read(chatId: string, name: string): Promise<{ bytes: Uint8Array; type: string } | null> {
      if (!isChatId(chatId) || !NAME.test(name)) return null;
      const bytes = await readFile(join(folder(chatId), name)).catch(() => null);
      return bytes ? { bytes, type: IMAGE_TYPES[name.split(".").pop()!]! } : null;
    },
  };
}
