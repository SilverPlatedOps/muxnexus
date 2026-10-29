// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentSource } from "../shared/protocol";
import type { WindowRef, World, WorldWindow } from "./world";

/**
 * What changed between two worlds, as events a view can animate however it
 * likes. Each change fires exactly once; nothing fires for a first world, or
 * across a tmux restart, whose reused ids would pair unrelated windows.
 */

export type WorldEventKind =
  | "appeared" | "vanished" | "replaced"
  | "began-working" | "began-waiting" | "resumed" | "finished" | "interrupted"
  | "rang" | "seen"
  | "account-changed";

export interface WorldEvent {
  kind: WorldEventKind;
  ref: WindowRef;
  /** Epoch ms of the world the change was found in. */
  at: number;
  /** `replaced`: the window this one carries on from. */
  previous?: WindowRef;
  /** `finished` / `interrupted`: how the end was known. */
  source?: AgentSource;
  /** `account-changed`: before and after. */
  from?: string | null;
  to?: string | null;
}

function windowsOf(world: World): Map<string, { ref: WindowRef; w: WorldWindow }> {
  const out = new Map<string, { ref: WindowRef; w: WorldWindow }>();
  for (const g of world.groups) {
    for (const s of g.sessions) {
      for (const w of s.windows) out.set(w.id, { ref: { session: s.id, window: w.id }, w });
    }
  }
  return out;
}

/** A conversation and a fork origin are the same kind of key: a fork carries on the conversation it came from. */
function lineageKeys(w: WorldWindow): string[] {
  const l = w.lineage;
  return [l.conversation && `c:${l.conversation}`, l.from && `c:${l.from}`, l.note && `n:${l.note}`]
    .filter((k): k is string => !!k);
}

function changes(was: WorldWindow, now: WorldWindow, ref: WindowRef, at: number): WorldEvent[] {
  const out: WorldEvent[] = [];
  const before = was.agent?.state;
  const after = now.agent?.state;
  if (after === "working" && before !== "working") out.push({ kind: before === "waiting" ? "resumed" : "began-working", ref, at });
  if (after === "waiting" && before !== "waiting") out.push({ kind: "began-waiting", ref, at });
  if (after === "idle" && (before === "working" || before === "waiting")) {
    out.push({ kind: now.agent!.endedBy === "interrupted" ? "interrupted" : "finished", ref, at, source: now.agent!.source });
  }
  if (now.unread !== was.unread) out.push({ kind: now.unread ? "rang" : "seen", ref, at });
  if (was.agent && now.agent && was.agent.account !== now.agent.account) {
    out.push({ kind: "account-changed", ref, at, from: was.agent.account, to: now.agent.account });
  }
  return out;
}

export function diffWorlds(prev: World | null, next: World, at: number): WorldEvent[] {
  if (!prev || prev.tmuxServer !== next.tmuxServer) return [];
  const before = windowsOf(prev);
  const after = windowsOf(next);
  const gone = [...before.values()].filter((x) => !after.has(x.w.id));
  const claimed = new Set<string>();
  const events: WorldEvent[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was) {
      events.push(...changes(was.w, now.w, now.ref, at));
      continue;
    }
    const keys = new Set(lineageKeys(now.w));
    const old = gone.find((g) => !claimed.has(g.w.id) && lineageKeys(g.w).some((k) => keys.has(k)));
    if (old) {
      claimed.add(old.w.id);
      events.push({ kind: "replaced", ref: now.ref, previous: old.ref, at });
    } else {
      events.push({ kind: "appeared", ref: now.ref, at });
    }
  }
  for (const g of gone) if (!claimed.has(g.w.id)) events.push({ kind: "vanished", ref: g.ref, at });
  return events;
}
