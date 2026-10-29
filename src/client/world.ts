// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type {
  AgentInfo, AgentSource, BoundarySource, SessionInfo, UsageSource, UsageWindow, WindowInfo,
} from "../shared/protocol";
import { nextAttention, sharedCheckouts } from "./agent";
import { groupSessions, visualOrder } from "./groups";
import { sessionLabel, tabLabel } from "./labels";
import { categoryKey, splitCategory } from "../shared/category";

/**
 * The world every alternative view draws from: muxnexus's sessions, agents and
 * quota with no presentation in them -- no metaphor, no layout, no animation.
 * Rebuilt only when data changes; durations are timestamps a view counts with
 * its own clock. Built from the same helpers the sidebar uses, so the two can
 * never disagree about what wants you.
 */

/** A window, by ids: a session's `$N` and a window's `@N`. Names change; ids hold within one tmux server. */
export interface WindowRef {
  session: string;
  window: string;
}

export interface WorldAttention {
  /** Windows waiting on you. */
  waiting: number;
  /** When the longest of those waits began. */
  oldestWaitSince?: string;
  /** Windows that rang their bell since anyone looked. */
  unread: number;
}

export interface WorldAgent {
  kind: "claude" | "codex";
  /** The account it spends, as the quota panel names it; null when the hook did not say. */
  account: string | null;
  state: "working" | "waiting" | "idle";
  source: AgentSource;
  /** When this state began, as best known: the turn's start, the wait's start, or the stamp. */
  since: string;
  turnStartedAt?: string;
  turnSource?: BoundarySource;
  /** Idle only: with `turnStartedAt`, how long the last turn took. */
  turnEndedAt?: string;
  /** Waiting only. */
  waitingSince?: string;
  waitSource?: BoundarySource;
  /** Idle only. */
  endedBy?: "finished" | "interrupted" | "stale";
}

export interface WorldWindow {
  id: string;
  name: string;
  /** What a replacement window can be recognised by: its conversation, the one it forked from, its note. */
  lineage: { conversation?: string; from?: string; note?: string };
  unread: boolean;
  /** Other live agents in the same git checkout. */
  sharedWith: WindowRef[];
  agent?: WorldAgent;
}

export interface WorldSession {
  id: string;
  /** tmux's name: what actions target. */
  name: string;
  /** What to show, the tag dropped as the sidebar drops it under its header. */
  label: string;
  current: boolean;
  windows: WorldWindow[];
  attention: WorldAttention;
}

export interface WorldGroup {
  /** `categoryKey` of the tag; null for an untagged session's own block. */
  key: string | null;
  /** The tag as its first session spells it. */
  name: string | null;
  folded: boolean;
  sessions: WorldSession[];
  /** Counted whether folded or not: a fold never hides that something wants you. */
  attention: WorldAttention;
}

export interface WorldAccount {
  label: string;
  provider: UsageSource["provider"];
  windows: UsageWindow[];
}

export interface World {
  tmuxServer: string | null;
  /** In sidebar order. */
  groups: WorldGroup[];
  attention: WorldAttention;
  /** Every waiting window, longest wait first. */
  queue: WindowRef[];
  /** One per quota source, in the panel's order. */
  accounts: WorldAccount[];
}

export interface WorldInput {
  sessions: readonly SessionInfo[];
  tmuxServer: string | null;
  usage: readonly UsageSource[];
  folded: ReadonlySet<string>;
  current: string | null;
  /** The Display switch for the shared-checkout mark: off, nobody is said to share. */
  marksShown: boolean;
}

const STATE = { input: "waiting", running: "working", done: "idle" } as const;

function worldAgent(a: AgentInfo): WorldAgent {
  const state = STATE[a.state];
  const source = a.source ?? "hook";
  const since = state === "working" ? a.turnStartedAt ?? a.since
    : state === "waiting" ? a.waitingSince ?? a.since
    : a.since;
  return {
    kind: a.profile?.startsWith("codex") ? "codex" : "claude",
    account: a.profile ?? null,
    state,
    source,
    since,
    ...(a.turnStartedAt ? { turnStartedAt: a.turnStartedAt, turnSource: a.turnSource ?? "hook" } : {}),
    ...(state === "idle" && a.turnEndedAt ? { turnEndedAt: a.turnEndedAt } : {}),
    ...(state === "waiting" && a.waitingSince ? { waitingSince: a.waitingSince, waitSource: a.waitSource ?? "hook" } : {}),
    ...(state === "idle"
      ? { endedBy: source === "transcript" ? "interrupted" : source === "quiet" ? "stale" : "finished" }
      : {}),
  };
}

function attentionOf(windows: readonly WorldWindow[]): WorldAttention {
  let waiting = 0;
  let unread = 0;
  let oldest: string | undefined;
  for (const w of windows) {
    if (w.unread) unread++;
    if (w.agent?.state !== "waiting") continue;
    waiting++;
    if (!oldest || Date.parse(w.agent.since) < Date.parse(oldest)) oldest = w.agent.since;
  }
  return { waiting, unread, ...(oldest ? { oldestWaitSince: oldest } : {}) };
}

function sumAttention(parts: readonly WorldAttention[]): WorldAttention {
  let waiting = 0;
  let unread = 0;
  let oldest: string | undefined;
  for (const p of parts) {
    waiting += p.waiting;
    unread += p.unread;
    if (p.oldestWaitSince && (!oldest || Date.parse(p.oldestWaitSince) < Date.parse(oldest))) oldest = p.oldestWaitSince;
  }
  return { waiting, unread, ...(oldest ? { oldestWaitSince: oldest } : {}) };
}

/** `sharedCheckouts` names each sharer with this, so its answer can be turned back into refs. */
const refKey = (s: SessionInfo, w: WindowInfo) => `${s.id}|${w.id}`;
const refOf = (key: string): WindowRef => {
  const [session, window] = key.split("|");
  return { session, window };
};

export function buildWorld(input: WorldInput): World {
  const sharing = input.marksShown ? sharedCheckouts(input.sessions, refKey) : new Map();

  const worldSession = (s: SessionInfo): WorldSession => {
    const shown = sessionLabel(s);
    const windows = s.windows.map((w): WorldWindow => ({
      id: w.id,
      name: tabLabel(w),
      lineage: {
        ...(w.conversation ? { conversation: w.conversation.sessionId } : {}),
        ...(w.forkedFrom ? { from: w.forkedFrom } : {}),
        ...(w.noteId ? { note: w.noteId } : {}),
      },
      unread: w.unread === true,
      sharedWith: (sharing.get(w.id)?.others ?? []).map(refOf),
      ...(w.agent ? { agent: worldAgent(w.agent) } : {}),
    }));
    return {
      id: s.id,
      name: s.name,
      label: splitCategory(shown)?.rest ?? shown,
      current: s.name === input.current,
      windows,
      attention: attentionOf(windows),
    };
  };

  const groups = groupSessions(input.sessions, sessionLabel).map((block): WorldGroup => {
    const key = block.category === null ? null : categoryKey(block.category);
    const sessions = block.sessions.map(worldSession);
    return {
      key,
      name: block.category,
      folded: key !== null && input.folded.has(key),
      sessions,
      attention: sumAttention(sessions.map((s) => s.attention)),
    };
  });

  const queue = groups
    .flatMap((g) => g.sessions.flatMap((s) => s.windows
      .filter((w) => w.agent?.state === "waiting")
      .map((w) => ({ ref: { session: s.id, window: w.id }, at: Date.parse(w.agent!.since) }))))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.ref);

  return {
    tmuxServer: input.tmuxServer,
    groups,
    attention: sumAttention(groups.map((g) => g.attention)),
    queue,
    accounts: input.usage.map((u) => ({ label: u.label, provider: u.provider, windows: u.windows })),
  };
}

const waitStart = (w: WindowInfo) => Date.parse(w.agent!.waitingSince ?? w.agent!.since);

/**
 * ⌘J's target as a window: the session `nextAttention` picks -- so the two can
 * never disagree -- at its longest-waiting window, else its first unread one.
 */
export function nextWaiting(sessions: readonly SessionInfo[], current: string | null): WindowRef | null {
  const name = nextAttention(visualOrder(sessions, sessionLabel), current);
  if (!name) return null;
  const s = sessions.find((x) => x.name === name);
  if (!s) return null;
  const waiting = s.windows.filter((w) => w.agent?.state === "input").sort((a, b) => waitStart(a) - waitStart(b));
  const w = waiting[0] ?? s.windows.find((x) => x.unread) ?? s.windows.find((x) => x.active) ?? s.windows[0];
  return w ? { session: s.id, window: w.id } : null;
}
