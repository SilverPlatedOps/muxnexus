// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { fileTarget } from "../file-links";

/**
 * Files attached in the conversation view: uploaded to the machine the agent
 * runs on as soon as they are picked, and sent with the next message by the
 * name the server gave them. Images go in as images (the agent sees them);
 * other files are named in the message by their path, for the agent to read.
 */

/** A file attached to the next message: uploading, or on the server under `name`. */
export interface Attachment {
  id: number;
  /** The file's own name, as picked. */
  label: string;
  /** Known once uploaded: whether the server took it for an image. */
  image: boolean;
  /** Set once uploaded. */
  name?: string;
  path?: string;
}

/** What the agents take as an image: anything else picked as an image (an iPhone's HEIC) is redrawn as a JPEG. */
const AGENT_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Under the server's 10 MB for an image, with room to spare. Larger photos are redrawn smaller. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** The longest side a redrawn photo keeps: more than an agent looks at. */
const LONG_SIDE = 2048;
/** How many files one message takes (the server's limit). */
export const MAX_ATTACHMENTS = 10;

/** The bytes to upload: the file itself, or for an image an agent can't take (or too large), a JPEG of it. */
async function prepared(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || (AGENT_IMAGE.has(file.type) && file.size <= MAX_IMAGE_BYTES)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext("2d")!;
    // A JPEG keeps no transparency: white under it, as a page shows it, not black.
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("no JPEG"))), "image/jpeg", 0.88));
  } catch {
    // A browser that can't draw it: sent as it is, a file the agent is told the path of.
    return file;
  }
}

/** Uploads `file`; the server's name for it, where it is, and whether it went in as an image. */
export async function uploadFile(file: File): Promise<{ name: string; path: string; image: boolean }> {
  const body = await prepared(file);
  const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": body.type || "application/octet-stream" },
    body,
  });
  const r = (await res.json().catch(() => null)) as { ok?: boolean; name?: string; path?: string; image?: boolean; error?: string } | null;
  if (!res.ok || !r?.ok || !r.name || !r.path) throw new Error(r?.error ?? `Couldn't upload ${file.name} (${res.status})`);
  return { name: r.name, path: r.path, image: r.image === true };
}

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i;

/** The files a step sent the user (Claude Code's SendUserFile), by path; none for any other step. */
export function sentFiles(it: { tool: string; input: string }): string[] {
  if (it.tool !== "SendUserFile") return [];
  try {
    const files = (JSON.parse(it.input) as { files?: unknown }).files;
    return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** Whether a path names an image the page can show (a png, jpeg, gif or webp). */
export function isImagePath(path: string): boolean {
  return IMAGE_PATH.test(path);
}

/** The path a `/file?` address names, or null for any other address. */
export function linkedPath(href: string): string | null {
  return href.startsWith("/file?") ? new URLSearchParams(href.slice("/file?".length)).get("path") : null;
}

/**
 * A local image as a thumbnail, opening full size in a new tab. Its height is
 * set before it loads, so the list doesn't jump; one gone from disk (pastes
 * are kept a week) shows its file name instead.
 */
export function thumbnail(path: string, windowId?: string | null): HTMLElement | null {
  // A relative path is read from the folder the tab's pane is in.
  const href = fileTarget(path, windowId);
  if (!href) return null;
  const a = document.createElement("a");
  a.className = "conv-thumb";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.src = href;
  img.alt = path.split("/").pop() ?? "image";
  img.loading = "lazy";
  img.decoding = "async";
  img.onerror = () => {
    a.classList.add("gone");
    a.replaceChildren(`${img.alt} (no longer on disk)`);
  };
  a.append(img);
  return a;
}

/** A row of thumbnails, or null when none of `paths` is an image. */
export function thumbnails(paths: string[], windowId?: string | null): HTMLElement | null {
  const shown = [...new Set(paths)].filter(isImagePath).map((p) => thumbnail(p, windowId)).filter((t): t is HTMLElement => t !== null);
  if (shown.length === 0) return null;
  const row = document.createElement("div");
  row.className = "conv-thumbs";
  row.append(...shown);
  return row;
}
