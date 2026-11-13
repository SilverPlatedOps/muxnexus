// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { AgentKind } from "../../shared/chat";
import type { ConvItem, StepResult } from "../../shared/conversation";
import { adapterFor } from "./adapter";

/**
 * Reads a transcript from byte offsets, never the whole file: the newest page
 * first, older pages by walking backwards, appended rows by offset. muxnexus
 * only reads these files.
 */

type Item = ConvItem | StepResult;

export interface Page {
  items: Item[];
  /** Byte offset of the first row's line start. */
  start: number;
  /** Byte offset just past the last complete row. */
  end: number;
  /** How many bytes were read from disk to build this page. */
  bytesRead?: number;
}

const PAGE_CHUNK = 256 * 1024;
const SCAN_CHUNK = 1024 * 1024;
const DEFAULT_LIMIT = 60;

interface Line {
  offset: number;
  text: string;
  /** Followed by a newline. Only the file's last line can lack one: it may still be being written. */
  terminated: boolean;
}

/** Lines of the file before byte `end`, newest first, reading `chunk` bytes at a time. */
async function* linesBack(fh: FileHandle, end: number, chunk: number, counter: { n: number }): AsyncGenerator<Line> {
  let pos = end;
  let carry: Buffer = Buffer.alloc(0);
  let first = true;
  while (pos > 0) {
    const lo = Math.max(0, pos - chunk);
    const part = Buffer.alloc(pos - lo);
    const { bytesRead } = await fh.read(part, 0, part.length, lo);
    counter.n += bytesRead;
    const buf = Buffer.concat([part.subarray(0, bytesRead), carry]);
    pos = lo;
    let from = 0;
    if (lo > 0) {
      const i = buf.indexOf(10);
      if (i < 0) {
        carry = buf;
        continue;
      }
      from = i + 1;
    }
    carry = buf.subarray(0, from);
    const region = buf.subarray(from);
    let e = region.length;
    let terminated = true;
    if (first) {
      first = false;
      if (e > 0 && region[e - 1] !== 10) terminated = false;
    }
    if (e > 0 && region[e - 1] === 10) e--;
    while (e > 0) {
      const s = region.lastIndexOf(10, e - 1) + 1;
      if (e > s) yield { offset: lo + from + s, text: region.subarray(s, e).toString("utf8"), terminated };
      terminated = true;
      if (s === 0) break;
      e = s - 1;
    }
  }
}

function parseRow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The newest `limit` items before byte `end`, on row boundaries. */
async function backFrom(fh: FileHandle, kind: AgentKind, end: number, size: number, limit: number): Promise<Page> {
  const adapter = adapterFor(kind);
  const counter = { n: 0 };
  const rows: Item[][] = [];
  let count = 0;
  let pageEnd = end;
  let start = end;
  let reachedStart = true;
  for await (const line of linesBack(fh, end, PAGE_CHUNK, counter)) {
    const row = parseRow(line.text);
    if (end === size && !line.terminated && row === undefined) {
      pageEnd = line.offset;
      start = line.offset;
      continue;
    }
    start = line.offset;
    if (row !== undefined) {
      const items = adapter.rowItems(row);
      rows.push(items);
      count += items.length;
    }
    if (count >= limit) {
      reachedStart = false;
      break;
    }
  }
  if (reachedStart) start = 0;
  return { items: rows.reverse().flat(), start, end: pageEnd, bytesRead: counter.n };
}

/** Start of the line holding byte `at`. */
async function lineStart(fh: FileHandle, at: number): Promise<number> {
  let hi = at;
  while (hi > 0) {
    const lo = Math.max(0, hi - PAGE_CHUNK);
    const buf = Buffer.alloc(hi - lo);
    const { bytesRead } = await fh.read(buf, 0, buf.length, lo);
    const i = buf.subarray(0, bytesRead).lastIndexOf(10);
    if (i >= 0) return lo + i + 1;
    hi = lo;
  }
  return 0;
}

/** Complete rows from byte `from` to the end of the last full line (a final line with no newline counts only if it parses). */
async function forwardFrom(fh: FileHandle, kind: AgentKind, from: number, size: number, maxItems = Infinity): Promise<Page> {
  const adapter = adapterFor(kind);
  const items: Item[] = [];
  let pos = from;
  let rest: Buffer = Buffer.alloc(0);
  let restStart = from;
  let bytes = 0;
  while (pos < size && items.length < maxItems) {
    const buf = Buffer.alloc(Math.min(SCAN_CHUNK, size - pos));
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    bytes += bytesRead;
    pos += bytesRead;
    rest = Buffer.concat([rest, buf.subarray(0, bytesRead)]);
    let s = 0;
    for (let i = rest.indexOf(10, s); i >= 0 && items.length < maxItems; i = rest.indexOf(10, s)) {
      const text = rest.subarray(s, i).toString("utf8");
      s = i + 1;
      const row = text ? parseRow(text) : undefined;
      if (row !== undefined) items.push(...adapter.rowItems(row));
    }
    restStart += s;
    rest = rest.subarray(s);
    if (items.length >= maxItems) return { items, start: from, end: restStart, bytesRead: bytes };
  }
  if (rest.length > 0) {
    const row = parseRow(rest.toString("utf8"));
    if (row !== undefined) {
      items.push(...adapter.rowItems(row));
      restStart += rest.length;
    }
  }
  return { items, start: from, end: restStart, bytesRead: bytes };
}

/** How far back an around page looks for the call of a result it holds: a long-running call can be far behind its result. */
const CALL_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * The calls (steps) of the results in `items` whose call isn't among them,
 * looked for in the rows before byte `before`, newest first, as far back as
 * `CALL_SCAN_BYTES`. A call not found by then is left out.
 */
async function callsOf(fh: FileHandle, kind: AgentKind, items: Item[], before: number): Promise<{ calls: Item[]; bytes: number }> {
  const steps = new Set(items.flatMap((i) => (i.kind === "step" ? [i.id] : [])));
  const wanted = new Set(items.flatMap((i) => (i.kind === "step-result" && !steps.has(i.id) ? [i.id] : [])));
  const calls: Item[] = [];
  const counter = { n: 0 };
  if (wanted.size === 0) return { calls, bytes: 0 };
  const adapter = adapterFor(kind);
  for await (const line of linesBack(fh, before, SCAN_CHUNK, counter)) {
    // An id is in its row as a JSON string: only a row holding one is parsed.
    if (![...wanted].some((id) => line.text.includes(JSON.stringify(id)))) {
      if (counter.n >= CALL_SCAN_BYTES) break;
      continue;
    }
    const row = parseRow(line.text);
    const found = row === undefined ? [] : adapter.rowItems(row).filter((i) => i.kind === "step" && wanted.has(i.id));
    for (const call of found) wanted.delete(call.id);
    calls.unshift(...found);
    if (wanted.size === 0 || counter.n >= CALL_SCAN_BYTES) break;
  }
  return { calls, bytes: counter.n };
}

export async function readPage(kind: AgentKind, path: string, opts: { before?: number; around?: number; limit?: number }): Promise<Page> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    if (opts.around !== undefined) {
      const at = Math.min(Math.max(0, opts.around), size);
      const mid = await lineStart(fh, at);
      const half = Math.max(1, Math.floor(limit / 2));
      const after = await forwardFrom(fh, kind, mid, size, half);
      const before = await backFrom(fh, kind, mid, size, half);
      const items = [...before.items, ...after.items];
      // A search hit in a result whose call is further back than the page: the call comes too, first (it is older
      // than every row the page holds), so the hit shows as the step it completes. `start` stays the page's own.
      const { calls, bytes } = await callsOf(fh, kind, items, before.start);
      return { items: [...calls, ...items], start: before.start, end: after.end, bytesRead: (before.bytesRead ?? 0) + (after.bytesRead ?? 0) + bytes };
    }
    const end = Math.min(opts.before ?? size, size);
    return await backFrom(fh, kind, end, size, limit);
  } finally {
    await fh.close();
  }
}

/** What was appended after byte `from`. A file shorter than `from` was replaced: read it from 0. */
export async function readSince(kind: AgentKind, path: string, from: number): Promise<Page> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    return await forwardFrom(fh, kind, from > size ? 0 : from, size);
  } finally {
    await fh.close();
  }
}

function textsOf(it: Item): string[] {
  switch (it.kind) {
    case "step":
      return [it.summary, it.input, it.result?.output ?? ""];
    case "step-result":
      return [it.output];
    default:
      return [it.text];
  }
}

function snippet(text: string, at: number, len: number): string {
  const lo = Math.max(0, at - 40);
  const hi = Math.min(text.length, at + len + 40);
  return `${lo > 0 ? "…" : ""}${text.slice(lo, hi).replace(/\s+/g, " ")}${hi < text.length ? "…" : ""}`;
}

/** Newest-first search in agent prose and step output. `next` is the cursor to continue from, absent when the file is exhausted. */
export async function searchFile(
  kind: AgentKind,
  path: string,
  query: string,
  opts: { cursor?: number; max?: number } = {},
): Promise<{ hits: { id: string; offset: number; snippet: string }[]; next?: number }> {
  const hits: { id: string; offset: number; snippet: string }[] = [];
  const needle = query.toLowerCase();
  if (!needle) return { hits };
  const max = opts.max ?? 20;
  // JSON escapes quotes and backslashes in the raw line, so only a plain query can be tested before parsing.
  const plain = /^[\w .-]+$/.test(needle);
  const adapter = adapterFor(kind);
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const counter = { n: 0 };
    for await (const line of linesBack(fh, Math.min(opts.cursor ?? size, size), SCAN_CHUNK, counter)) {
      if (plain && !line.text.toLowerCase().includes(needle)) continue;
      const row = parseRow(line.text);
      if (row === undefined) continue;
      for (const it of adapter.rowItems(row)) {
        const found = textsOf(it)
          .map((t) => ({ t, i: t.toLowerCase().indexOf(needle) }))
          .find((x) => x.i >= 0);
        if (found) {
          hits.push({ id: it.id, offset: line.offset, snippet: snippet(found.t, found.i, needle.length) });
          break;
        }
      }
      if (hits.length >= max) {
        const last = hits[hits.length - 1].offset;
        // Continue before this row, unless it was the first.
        return last > 0 ? { hits, next: last } : { hits };
      }
    }
    return { hits };
  } finally {
    await fh.close();
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]\\]+/g;
const PR_RE = /\/pull\/\d+|\/merge_requests\/\d+/;

/** Every URL in the conversation once, pull and merge requests first, each group newest first. */
export async function linksIn(kind: AgentKind, path: string): Promise<{ url: string; pr: boolean }[]> {
  const adapter = adapterFor(kind);
  const seen = new Set<string>();
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const counter = { n: 0 };
    for await (const line of linesBack(fh, size, SCAN_CHUNK, counter)) {
      if (!line.text.includes("http")) continue;
      const row = parseRow(line.text);
      if (row === undefined) continue;
      for (const it of adapter.rowItems(row))
        for (const t of textsOf(it)) for (const m of t.matchAll(URL_RE)) seen.add(m[0].replace(/[.,;:!?]+$/, ""));
    }
  } finally {
    await fh.close();
  }
  const all = [...seen].map((url) => ({ url, pr: PR_RE.test(url) }));
  return [...all.filter((l) => l.pr), ...all.filter((l) => !l.pr)];
}
