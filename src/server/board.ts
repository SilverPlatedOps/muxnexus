// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { basename } from "node:path";
import type { SessionInfo, SystemApp, UsageSource } from "../shared/protocol";
import type { Vitals } from "./vitals";

/**
 * The desk board's view of this machine, for GET /api/board: the line its USB
 * feeder sends (agents and quota, in the same short keys, so the board reads
 * both the same way) plus the system load. Read-only by construction: names,
 * states and numbers, never terminal content, and nothing in it can act.
 */

/** The board drops longer lines (desk-board src/feed.h LineReader). */
export const MAX_BOARD_BYTES = 4096;
const MAX_AGENTS = 24;
const MAX_NAME = 32;
const MAX_WHERE = 40;
/** A memory reading older than this says nothing about now: leave the app list out. */
const MEMORY_FRESH_MS = 30_000;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

type BoardState = "asked" | "finished" | "running";
interface BoardAgent { n: string; p: string; s: BoardState; a: number; d: string; i: string }

export interface BoardQuota {
  k: "personal" | "work" | "codex";
  w5: number;
  r5: number;
  w7: number;
  r7: number;
  c: number;
  ok: boolean;
  p7?: true;
}

export interface BoardInput {
  /** This machine's name, so the board can say whose rows these are. */
  src: string;
  /** Seconds. */
  now: number;
  sessions: SessionInfo[];
  usage: UsageSource[] | null;
  vitals: Vitals | null;
  memory: { at: number; apps: SystemApp[] } | null;
}

const STATES = { input: "asked", done: "finished", running: "running" } as const;
const ORDER: Record<BoardState, number> = { asked: 0, finished: 1, running: 2 };
const PROFILES = new Set(["personal", "work", "codex"]);

const seconds = (iso?: string) => {
  // Microseconds ("…59.785881+00:00") trimmed to milliseconds, as every parser accepts.
  const t = iso ? Date.parse(iso.replace(/(\.\d{3})\d+/, "$1")) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function agents(sessions: SessionInfo[], now: number): BoardAgent[] {
  const found: (BoardAgent & { window: number })[] = [];
  // Grouped sessions list the same window once each.
  const seen = new Set<string>();
  for (const s of sessions) {
    for (const w of s.windows) {
      if (!w.agent || seen.has(w.id)) continue;
      seen.add(w.id);
      const state = STATES[w.agent.state];
      const since = state === "asked" && w.agent.waitingSince ? w.agent.waitingSince : w.agent.since;
      found.push({
        n: s.name.replace(/^\[[^\]]*\]\s*/, ""),
        p: w.agent.profile && PROFILES.has(w.agent.profile) ? w.agent.profile : "other",
        s: state,
        a: Math.max(0, now - seconds(since)),
        d: w.agent.checkout ? basename(w.agent.checkout).slice(0, MAX_WHERE) : "",
        i: w.id,
        window: w.index,
      });
    }
  }
  const count = new Map<string, number>();
  for (const a of found) count.set(a.n, (count.get(a.n) ?? 0) + 1);
  return found
    .map(({ window, ...a }) => ({ ...a, n: (count.get(a.n)! > 1 ? `${a.n} ${window}` : a.n).slice(0, MAX_NAME) }))
    .sort((x, y) => ORDER[x.s] - ORDER[y.s] || y.a - x.a)
    .slice(0, MAX_AGENTS);
}

const FIVE_HOUR = new Set(["session", "5h"]);
const WEEKLY = new Set(["weekly_all", "weekly_scoped", "7d"]);

function kindOf(s: UsageSource): BoardQuota["k"] | null {
  if (s.provider === "codex") return "codex";
  if (s.id.endsWith("/.claude-work")) return "work";
  if (s.id.endsWith("/.claude")) return "personal";
  return null;
}

/** Quota as the board's Quota page reads it: the 5-hour window and the fuller weekly one. */
export function boardQuota(sources: UsageSource[]): BoardQuota[] {
  const out: BoardQuota[] = [];
  for (const s of sources) {
    const k = kindOf(s);
    const five = s.windows.find((w) => FIVE_HOUR.has(w.kind));
    // On a tie the all-models window, so "7d+" means strictly fuller.
    const scopedLast = (kind: string) => (kind === "weekly_scoped" ? 1 : 0);
    const week = s.windows.filter((w) => WEEKLY.has(w.kind)).sort((a, b) => b.percent - a.percent || scopedLast(a.kind) - scopedLast(b.kind))[0];
    if (!k || (!five && !week)) continue;
    out.push({
      k,
      w5: five?.percent ?? 0,
      r5: seconds(five?.resetsAt),
      w7: week?.percent ?? 0,
      r7: seconds(week?.resetsAt),
      c: seconds(s.checkedAt),
      ok: s.state === "ok",
      ...(week?.kind === "weekly_scoped" ? { p7: true as const } : {}),
    });
  }
  return out;
}

function system(v: Vitals, memory: BoardInput["memory"], nowMs: number) {
  const top = memory && nowMs - memory.at <= MEMORY_FRESH_MS
    ? [...memory.apps].filter((a) => !a.unreadable).sort((a, b) => b.cpu - a.cpu).slice(0, 3)
      .map((a) => [a.name.slice(0, MAX_NAME), Math.round(a.cpu), round(a.mem / GiB, 1)])
    : null;
  return {
    ...(v.cpu === undefined ? {} : { cpu: Math.round(v.cpu) }),
    load: v.load.map((l) => round(l, 2)),
    ...(v.mem ? { mem: [round(v.mem.used / GiB, 1), round(v.mem.total / GiB, 1)] } : {}),
    ...(v.mem?.pressure ? { pr: v.mem.pressure } : {}),
    ...(v.rate === null ? {} : { swap: round(v.rate / MiB, 1) }),
    ...(top ? { top } : {}),
  };
}

/** The body of GET /api/board: one JSON line, at most MAX_BOARD_BYTES. */
export function boardMessage(input: BoardInput): string {
  const list = agents(input.sessions, input.now);
  const q = input.usage ? boardQuota(input.usage) : [];
  const sys = input.vitals ? system(input.vitals, input.memory, input.now * 1000) : null;
  const encode = () => `${JSON.stringify({ v: 1, src: input.src, t: input.now, agents: list, ...(q.length ? { q } : {}), ...(sys ? { sys } : {}) })}\n`;
  let body = encode();
  // Long names can push it past what the board takes: drop the lowest-priority
  // agents (running first, as the list is sorted) until it fits.
  while (Buffer.byteLength(body) > MAX_BOARD_BYTES && list.length > 0) {
    list.pop();
    body = encode();
  }
  return body;
}
