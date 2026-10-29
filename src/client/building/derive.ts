// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { profileBadge } from "../agent";
import { atLimit, badgedLabels, summaryWindow } from "../usage";
import type { WindowRef, World, WorldSession, WorldWindow } from "../world";

/**
 * The building as a model: which floor each session stands on, how each person
 * sits, what each sheet says. Pure, so every rule in the spec's state section
 * is tested here and the view only draws.
 */

export const THRESHOLDS = { handDownMs: 10 * 60_000, dozeMs: 30 * 60_000, amberPct: 85 };
/** Sheet and fuel colours, by the badge slot the sidebar gives the account. */
export const PALETTE = ["#b9a6ff", "#8fdcb0", "#f0c24a"] as const;
export const NEUTRAL = "#cdd3df";

export type SheetState = "waiting" | "working" | "idle" | "inferred";
export interface Sheet {
  ref: WindowRef;
  name: string;
  /** 1-based: what ⌘1…⌘9 will pick. */
  n: number;
  state: SheetState;
  account: string | null;
  slot: number | null;
  /** The oldest wait on this desk: the job that needs you. */
  flag: boolean;
  /** Nobody reported on it. */
  dashed: boolean;
  /** Its account is past the amber line. */
  amber: boolean;
  since?: string;
}
export type PersonState = "waiting" | "working" | "idle" | "ghost";
export type Pose = "hand-up" | "calm" | "typing" | "away" | "asleep" | "ghost";
export interface Person {
  id: string;
  label: string;
  current: boolean;
  state: PersonState;
  pose: Pose;
  since?: string;
  sheets: Sheet[];
  /** What Enter opens: the flagged sheet, else the first. */
  target: WindowRef | null;
  status: string;
  jobs: string;
  alt: string;
}
/** A floor's room: its walls and props, and the desks its people spawn with. Decor, chosen per floor. */
export type RoomType = "office" | "glass" | "war" | "study" | "lounge" | "storage";
/** What the plate's picker offers; storage is the basement's alone. */
export const ROOM_CHOICES: readonly RoomType[] = ["office", "glass", "war", "study", "lounge"];
export const ROOM_LABEL: Record<RoomType, string> = { office: "open office", glass: "glass office", war: "war room", study: "study", lounge: "lounge", storage: "storage" };

export interface Floor { key: string; name: string; kind: "group" | "lobby" | "basement"; room: RoomType; people: Person[] }
export interface QueueEntry { ref: WindowRef; label: string; wait: string }
export interface Fuel {
  label: string;
  provider: World["accounts"][number]["provider"];
  letter: string;
  slot: number | null;
  percent: number | null;
  resetsAt?: string;
  level: "ok" | "amber" | "empty" | "none";
  signedOut: boolean;
}
export interface Building {
  floors: Floor[];
  queue: QueueEntry[];
  fuel: Fuel[];
  /** The session that has waited longest, where the dog sits; null when nobody waits. */
  longestWait: string | null;
}

/** Elapsed time as the tags say it. Never drawn as a length. */
export function span(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const ARCHIVE = "archived";
const at = (iso: string) => Date.parse(iso);

function sheetOf(s: WorldSession, w: WorldWindow, n: number, labels: readonly string[], amber: ReadonlySet<string>): Sheet {
  const a = w.agent;
  // `quiet` is the server overriding a running stamp on a window gone silent: a guess, not a report.
  const state: SheetState = !a || a.source === "quiet" ? "inferred" : a.state;
  const since = !a ? undefined : state === "idle" ? a.turnEndedAt ?? a.since : a.since;
  const account = a?.account ?? null;
  return {
    ref: { session: s.id, window: w.id },
    name: w.name,
    n,
    state,
    account,
    slot: account === null ? null : profileBadge(account, labels).slot,
    flag: false,
    dashed: state === "inferred",
    amber: account !== null && amber.has(account),
    ...(since ? { since } : {}),
  };
}

function personOf(s: WorldSession, now: number, labels: readonly string[], amber: ReadonlySet<string>): Person {
  const sheets = s.windows.map((w, i) => sheetOf(s, w, i + 1, labels, amber));
  const of = (st: SheetState) => sheets.filter((x) => x.state === st && x.since).sort((a, b) => at(a.since!) - at(b.since!));
  const waiting = of("waiting");
  let state: PersonState;
  let pose: Pose;
  let since: string | undefined;
  let status: string;
  if (sheets.some((x) => x.state === "waiting")) {
    state = "waiting";
    since = waiting[0]?.since;
    const flagged = waiting[0] ?? sheets.find((x) => x.state === "waiting")!;
    flagged.flag = true;
    const ms = since ? now - at(since) : 0;
    pose = ms >= THRESHOLDS.handDownMs ? "calm" : "hand-up";
    status = since ? `waiting ${span(ms)}` : "waiting";
  } else if (sheets.some((x) => x.state === "working")) {
    state = "working";
    since = of("working")[0]?.since;
    pose = "typing";
    status = "working";
  } else if (sheets.length > 0 && sheets.every((x) => x.state === "inferred")) {
    state = "ghost";
    since = of("inferred").at(-1)?.since;
    pose = "ghost";
    status = since ? `quiet ${span(now - at(since))} · inferred` : "quiet · inferred";
  } else {
    state = "idle";
    since = of("idle").at(-1)?.since;
    const ms = since ? now - at(since) : 0;
    pose = since && ms >= THRESHOLDS.dozeMs ? "asleep" : "away";
    status = since ? `idle ${span(ms)}` : "idle";
  }
  const jobs = `${sheets.length} ${sheets.length === 1 ? "job" : "jobs"}`;
  return {
    id: s.id,
    label: s.label,
    current: s.current,
    state,
    pose,
    ...(since ? { since } : {}),
    sheets,
    target: (sheets.find((x) => x.flag) ?? sheets[0])?.ref ?? null,
    status,
    jobs,
    alt: `${s.label} · ${status} · ${jobs}`,
  };
}

function roomOf(key: string, kind: Floor["kind"], chosen: Readonly<Record<string, RoomType>>): RoomType {
  if (kind === "basement") return "storage";
  const pick = chosen[key];
  if (pick && ROOM_CHOICES.includes(pick)) return pick;
  return kind === "lobby" ? "lounge" : key === "personal" ? "study" : "office";
}

/** `rooms`: the room picked for each floor, by floor key; a floor nobody furnished gets its default. */
export function deriveBuilding(world: World, now: number, rooms: Readonly<Record<string, RoomType>> = {}): Building {
  const labels = badgedLabels(world.accounts);
  const fuel: Fuel[] = world.accounts.map((a) => {
    const w = summaryWindow(a.windows, now);
    const percent = w ? w.percent : null;
    const badge = profileBadge(a.label, labels);
    return {
      label: a.label,
      provider: a.provider,
      letter: badge?.initial ?? a.label.slice(0, 1).toUpperCase(),
      slot: badge?.slot ?? null,
      percent,
      ...(w?.resetsAt ? { resetsAt: w.resetsAt } : {}),
      level: !w ? "none" : atLimit(w) ? "empty" : w.percent >= THRESHOLDS.amberPct ? "amber" : "ok",
      signedOut: a.state === "signed-out",
    };
  });
  const amber = new Set(fuel.filter((f) => f.level === "amber" || f.level === "empty").map((f) => f.label));
  const people = (sessions: readonly WorldSession[]) => sessions.map((s) => personOf(s, now, labels, amber));

  const floors: Floor[] = world.groups
    .filter((g) => g.key !== null && g.key !== ARCHIVE)
    .map((g) => ({ key: g.key!, name: g.name ?? g.key!, kind: "group", room: roomOf(g.key!, "group", rooms), people: people(g.sessions) }));
  const solo = world.groups.filter((g) => g.key === null).flatMap((g) => g.sessions);
  if (solo.length) floors.push({ key: "lobby", name: "Lobby", kind: "lobby", room: roomOf("lobby", "lobby", rooms), people: people(solo) });
  const archive = world.groups.find((g) => g.key === ARCHIVE);
  if (archive) floors.push({ key: ARCHIVE, name: archive.name ?? "Archived", kind: "basement", room: "storage", people: people(archive.sessions) });

  const sheetsById = new Map(floors.flatMap((f) => f.people.flatMap((p) => p.sheets.map((x) => [x.ref.window, { p, x }] as const))));
  const queue = world.queue.flatMap((ref): QueueEntry[] => {
    const hit = sheetsById.get(ref.window);
    if (!hit) return [];
    return [{ ref, label: hit.p.label, wait: hit.x.since ? span(now - at(hit.x.since)) : "" }];
  });
  return { floors, queue, fuel, longestWait: queue[0]?.ref.session ?? null };
}
