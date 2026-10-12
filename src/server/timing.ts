import type { AgentState, BoundarySource } from "../shared/protocol";

/**
 * How long a turn has run and how long a wait has lasted, from the boundaries
 * the hook marks (`@muxnexus_turn`, `@muxnexus_wait`) and, where it marked none,
 * from what the server saw itself. All times are unix seconds.
 */

/** `@muxnexus_turn`: `"<start>"` while the turn runs, `"<start> <end>"` once a Stop ended it. */
export interface Turn {
  start: number;
  end?: number;
}

export function parseTurn(raw: string): Turn | null {
  const m = /^(\d+)(?:\s+(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const start = Number(m[1]);
  return m[2] === undefined ? { start } : { start, end: Number(m[2]) };
}

/** `@muxnexus_wait`: `"<epoch>"`, when the current wait began. */
export function parseWait(raw: string): number | null {
  const m = /^(\d+)$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/** What the server has itself seen of one pane, by stamp times. */
export interface Seen {
  /** When it first saw the current turn running (or waiting). */
  turn?: number;
  /** When it first saw the current wait. */
  wait?: number;
  /** When it last saw the pane done: a hook turn that began before it is over. */
  lastDone?: number;
}

/**
 * The server's own sight of each pane, for turns and waits the hook marked no
 * boundary for: an agent mid-turn when the hook learned to mark them, or a turn
 * a background subagent woke without a prompt. Kept in memory, so a server
 * restart -- the real one runs under `bun --watch` -- starts it again from the
 * next poll; which is why what it reports is marked `first-seen`.
 */
export class FirstSeen {
  private panes = new Map<string, Seen>();
  /**
   * What a pane knew before a `done` on stamp `at`. The quiet guard reads a
   * `running` stamp as done after a pause in redraws -- a laptop waking, a
   * stopped terminal -- and nothing fires when the agent carries on, so the
   * stamp is the same one. Running again on that same stamp was a flap, not an
   * end, and gets this back.
   */
  private held = new Map<string, { seen: Seen; at: number }>();
  private server: string | null = null;

  /** tmux restarted: it hands pane ids out again, so nothing remembered applies. */
  forgetIfNew(server: string | null): void {
    if (server === this.server) return;
    this.server = server;
    this.panes.clear();
    this.held.clear();
  }

  /** This poll's believed state for a pane, at its stamp's time; what is now known of it. */
  observe(pane: string, state: AgentState, at: number): Seen {
    const before = this.panes.get(pane) ?? {};
    const held = this.held.get(pane);
    this.held.delete(pane);
    let s: Seen = { ...before };
    if (state === "done") {
      if (before.turn !== undefined) this.held.set(pane, { seen: { ...before }, at });
      else if (held?.at === at) this.held.set(pane, held); // the same pause, several polls long
      delete s.turn;
      delete s.wait;
      s.lastDone = at;
    } else {
      if (held?.at === at) s = { ...held.seen };
      s.turn ??= at;
      if (state === "input") s.wait ??= at;
      else delete s.wait;
    }
    this.panes.set(pane, s);
    return { ...s };
  }

  /** Forget panes that are gone. */
  keep(live: ReadonlySet<string>): void {
    for (const id of [...this.panes.keys()]) if (!live.has(id)) this.panes.delete(id);
    for (const id of [...this.held.keys()]) if (!live.has(id)) this.held.delete(id);
  }
}

export interface Timing {
  /** The current turn's start; while idle, the last turn's. */
  turnStartedAt?: number;
  /** Only while idle, and only when the hook saw the turn end. */
  turnEndedAt?: number;
  turnSource?: BoundarySource;
  /** Only while waiting. */
  waitingSince?: number;
  waitSource?: BoundarySource;
}

/**
 * The boundaries to believe for a pane in `state`, whose stamp says `stampSince`.
 *
 * A hook turn counts for a running or waiting pane only if it has not ended, is
 * no later than the stamp, and began after the last time the pane was seen done
 * -- an interrupted turn never gets an end, and the next one woken without a
 * prompt must not inherit its start. A hook wait counts if it lies inside the
 * turn. Anything else falls back to first sight, and failing that is not claimed.
 */
export function resolveTiming(
  state: AgentState,
  stampSince: number,
  turn: Turn | null,
  wait: number | null,
  seen: Seen,
): Timing {
  if (state === "done") {
    if (!turn) return {};
    return { turnStartedAt: turn.start, ...(turn.end !== undefined ? { turnEndedAt: turn.end } : {}), turnSource: "hook" };
  }
  const out: Timing = {};
  const current = turn !== null && turn.end === undefined && turn.start <= stampSince
    && (seen.lastDone === undefined || turn.start >= seen.lastDone);
  if (current) {
    out.turnStartedAt = turn.start;
    out.turnSource = "hook";
  } else if (seen.turn !== undefined) {
    out.turnStartedAt = seen.turn;
    out.turnSource = "first-seen";
  }
  if (state === "input") {
    const marked = wait !== null && wait <= stampSince && (out.turnStartedAt === undefined || wait >= out.turnStartedAt);
    if (marked) {
      out.waitingSince = wait;
      out.waitSource = "hook";
    } else if (seen.wait !== undefined) {
      out.waitingSince = seen.wait;
      out.waitSource = "first-seen";
    }
  }
  return out;
}
