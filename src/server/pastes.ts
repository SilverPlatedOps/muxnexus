// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { imageName, type ImageResult } from "./chat/images";

/**
 * Images pasted into a terminal. A program in a pane reads the clipboard of the
 * machine it runs on (Claude Code's Ctrl+V), and a page on another machine has
 * its own. So the page sends the image here and types the path it was saved
 * at, which Claude Code takes as the image itself.
 */
export const PASTES_DIR = join(homedir(), ".local", "share", "muxnexus", "pastes");

/** Long past the paste: an agent reads the image as it arrives. The folder must not only grow. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Only names this store made, whatever the image type: their first 13 digits are when. */
const NAME = /^(\d{13})-[0-9a-f]{8}\.[a-z]+$/;

export function createPasteStore(dir: string) {
  return {
    async save(bytes: Uint8Array, now = Date.now()): Promise<ImageResult> {
      const named = imageName(bytes, now);
      if (!named.ok) return named;
      // Screenshots: nobody else's to read.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      for (const old of await readdir(dir)) {
        const when = NAME.exec(old)?.[1];
        if (when && now - Number(when) > KEEP_MS) await unlink(join(dir, old)).catch(() => {});
      }
      const path = join(dir, named.name);
      await writeFile(path, bytes, { mode: 0o600 });
      return { ok: true, name: named.name, path };
    },
  };
}
