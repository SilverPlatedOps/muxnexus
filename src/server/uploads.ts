// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEEP_MS } from "./pastes";

/**
 * Files attached in the conversation view that aren't images: kept on this
 * machine, where the agent runs, and named in the message by their path for the
 * agent to read. Images go to the paste store, whose paths an agent takes as the
 * image itself.
 */
export const UPLOADS_DIR = join(homedir(), ".local", "share", "muxnexus", "uploads");

export const MAX_UPLOAD = 25 * 1024 * 1024;

/** The longest part of a name kept from the file's own. */
const KEPT = 80;
/** Only names this store made: their first 13 digits are when. */
const NAME = new RegExp(`^(\\d{13})-[0-9a-f]{8}-[A-Za-z0-9._-]{1,${KEPT}}$`);
/** What Claude Code and Codex take a pasted path for an image by (measured: png, jpg, jpeg; heic, bmp, svg, pdf stay text). */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;

export type UploadResult = { ok: true; name: string; path: string } | { ok: false; status: number; error: string };

/**
 * The name a file is kept under: when, a random part, then its own name with
 * anything but letters, digits, `.`, `_` and `-` made `-`, so the path reads as
 * one word wherever it is pasted. Bytes that aren't an image under an image's
 * extension get `.txt` added: the agent would take the path for an image and
 * fail to read it.
 */
export function uploadName(original: string, now: number): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  let kept = base.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  if (IMAGE_EXT.test(kept)) kept += ".txt";
  kept = kept.slice(-KEPT).replace(/^[.-]+/, "") || "file";
  return `${now}-${crypto.randomUUID().slice(0, 8)}-${kept}`;
}

export function createUploadStore(dir: string) {
  return {
    async save(bytes: Uint8Array, original: string, now = Date.now()): Promise<UploadResult> {
      if (bytes.length === 0) return { ok: false, status: 400, error: "That file is empty." };
      if (bytes.length > MAX_UPLOAD) {
        return { ok: false, status: 413, error: `That file is ${(bytes.length / 1048576).toFixed(1)} MB; the most is ${MAX_UPLOAD / 1048576} MB.` };
      }
      // The user's files: nobody else's to read.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const old of await readdir(dir)) {
        const when = NAME.exec(old)?.[1];
        if (when && now - Number(when) > KEEP_MS) await unlink(join(dir, old)).catch(() => {});
      }
      const name = uploadName(original, now);
      const path = join(dir, name);
      await writeFile(path, bytes, { mode: 0o600 });
      return { ok: true, name, path };
    },
    /** Where a name this store gave is kept, or null for any other name. */
    pathOf(name: string): string | null {
      return NAME.test(name) ? join(dir, name) : null;
    },
  };
}
