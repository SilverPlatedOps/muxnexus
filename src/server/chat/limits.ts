import { open, stat } from "node:fs/promises";

/**
 * Whether a Codex conversation's last turn ended on the account's usage limit,
 * read from the end of its rollout. Codex leaves its tab stamped as running
 * then, so without this a chat calls it Working until the user looks.
 */

/** How far back from the end a turn's end is looked for: the error is the last thing written. */
const TAIL = 256 * 1024;
/** A limit whose end can't be read is assumed over after this long: Codex's shorter window, so a stop is never permanent. */
const UNKNOWN_END_MS = 5 * 3600_000;

export interface UsageLimit {
  /** When Codex said to try again, as it put it ("6:42 PM"); empty when it didn't say. */
  until: string;
  /** That moment, when it could be read; past it, the limit no longer holds. */
  untilMs?: number;
  /** When the turn ended on it. */
  at: string;
}

/** "6:42 PM" on the day of the error, or the next day if that is already past; a full date as it stands. */
export function untilMs(until: string, at: string): number | undefined {
  const base = new Date(at);
  if (Number.isNaN(base.getTime())) return undefined;
  const clock = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(until.trim());
  if (clock) {
    const d = new Date(base);
    let h = Number(clock[1]) % 12;
    if (clock[3]!.toUpperCase() === "PM") h += 12;
    d.setHours(h, Number(clock[2]), 0, 0);
    if (d.getTime() < base.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const full = Date.parse(until.replace(/(\d)(st|nd|rd|th)\b/g, "$1"));
  return Number.isNaN(full) ? undefined : full;
}

/** The limit a rollout's last turn ended on, if any and if no turn has started since. */
export function limitIn(tail: string): UsageLimit | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.includes('"usage_limit_exceeded"')) {
      // Only Codex's own event says so: the words quoted in a message or a tool's output don't.
      let e: { timestamp?: string; type?: string; payload?: { error?: { message?: string; codex_error_info?: string }; codex_error_info?: string; message?: string } };
      try { e = JSON.parse(line); } catch { continue; }
      const info = e.payload?.error?.codex_error_info ?? e.payload?.codex_error_info;
      if (e.type !== "event_msg" || info !== "usage_limit_exceeded") continue;
      const message = (e.payload?.error?.message ?? e.payload?.message ?? "").trim();
      const until = /try again at (.+?)\.?$/.exec(message)?.[1]?.trim() ?? "";
      const at = e.timestamp ?? "";
      const ms = (until ? untilMs(until, at) : undefined) ?? (Date.parse(at) ? Date.parse(at) + UNKNOWN_END_MS : undefined);
      return { until, at, ...(ms !== undefined ? { untilMs: ms } : {}) };
    }
    // A turn begun after it: the limit has passed, or the user is dealing with it.
    if (line.includes('"type":"task_started"') || line.includes('"type":"user_message"')) return null;
  }
  return null;
}

const cache = new Map<string, { size: number; mtime: number; limit: UsageLimit | null }>();

export async function usageLimit(path: string): Promise<UsageLimit | null> {
  const s = await stat(path).catch(() => null);
  if (!s) return null;
  const hit = cache.get(path);
  if (hit && hit.size === s.size && hit.mtime === s.mtimeMs) return hit.limit;
  const f = await open(path, "r").catch(() => null);
  if (!f) return null;
  try {
    const len = Math.min(TAIL, s.size);
    const buf = Buffer.alloc(len);
    await f.read(buf, 0, len, s.size - len);
    const limit = limitIn(buf.toString("utf8"));
    cache.set(path, { size: s.size, mtime: s.mtimeMs, limit });
    return limit;
  } finally {
    await f.close();
  }
}
