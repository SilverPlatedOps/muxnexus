import type { RatePoint, SwapReason, SwapSeverity } from "../shared/protocol";

/**
 * Whether the Mac is swapping badly enough to say so, from the swap-write rate
 * and the kernel's memory pressure. Pure: the sampler feeds it each reading.
 *
 * Getting worse is immediate; getting better takes a whole window in which the
 * condition for it held on every reading, so the line does not flap, and a
 * reading that is unknown -- sleep, a failed read -- starts that window over. An episode runs from leaving calm until
 * returning to it, and is named by the time it began, so an acknowledgement
 * sent for an old episode cannot silence a new one, even across a restart.
 */

const MB = 1024 ** 2;
/** Writes worth a yellow line, sustained over `ENTER_MS`. */
export const BUSY_RATE = 5 * MB;
/** Writes worth the whole page. */
export const URGENT_RATE = 20 * MB;
/**
 * What leaving takes, under what entering does: a rate that hovers at a line
 * would otherwise drop the level and raise it again a reading later.
 */
export const URGENT_LEAVE_RATE = 15 * MB;
export const BUSY_LEAVE_RATE = 4 * MB;
/** Below this over `LEAVE_BUSY_MS`, the episode ends green rather than quietly. */
export const QUIET_RATE = 1 * MB;
export const ENTER_MS = 60_000;
export const LEAVE_BUSY_MS = 120_000;
export const LEAVE_URGENT_MS = 60_000;
/** How long the green line stays. */
export const RECOVERED_MS = 600_000;

export type Pressure = "normal" | "warning" | "critical";

export interface LevelState {
  severity: SwapSeverity;
  reason: SwapReason | null;
  /** When the current episode began, in ms; 0 before the first. */
  episode: number;
  acked: boolean;
  /** When `severity` last changed. */
  since: number;
  /**
   * Since when the condition for leaving the current severity has held on
   * every reading; null while it does not. Leaving needs it to have held for a
   * whole window, so a rate that dips for one reading -- or an average that
   * lags behind the one that raised the level -- cannot drop it.
   */
  leaveSince: number | null;
}

export const INITIAL_LEVEL: LevelState = {
  severity: "calm", reason: null, episode: 0, acked: false, since: 0, leaveSince: null,
};

/**
 * The time-weighted mean rate over the `spanMs` ending at `now`, or null unless
 * the readings cover it: one must be at or before its start, and every one
 * inside it must be known. Each point's rate covers the time since the point
 * before it.
 */
export function windowAverage(history: readonly RatePoint[], now: number, spanMs: number): number | null {
  const start = now - spanMs;
  let before: RatePoint | null = null;
  let sum = 0;
  let time = 0;
  for (const p of history) {
    if (p.at > now) break;
    if (p.at <= start) {
      before = p;
      continue;
    }
    if (p.rate === null || before === null) return null;
    const dt = p.at - before.at;
    sum += p.rate * dt;
    time += dt;
    before = p;
  }
  return time > 0 ? sum / time : null;
}

export function stepLevel(prev: LevelState, at: number, history: readonly RatePoint[], pressure: Pressure | undefined): LevelState {
  const avg = windowAverage(history, at, ENTER_MS);
  const writes = avg !== null && avg >= BUSY_RATE;
  const pressured = pressure === "warning" || pressure === "critical";
  const reason: SwapReason | null = writes && pressured ? "both" : writes ? "writes" : pressured ? "pressure" : null;
  const active = prev.severity === "busy" || prev.severity === "urgent";
  const begin = (severity: SwapSeverity): LevelState => ({
    ...prev, severity, reason, since: at, leaveSince: null,
    episode: active ? prev.episode : at, acked: active ? prev.acked : false,
  });
  const holding = (holds: boolean) => (holds ? prev.leaveSince ?? at : null);

  if (((avg !== null && avg >= URGENT_RATE) || pressure === "critical") && prev.severity !== "urgent") return begin("urgent");
  if ((writes || pressured) && !active) return begin("busy");

  if (prev.severity === "urgent") {
    // Eased: the minute's writes well under the urgent line and pressure known and not critical, reading after reading.
    const since = holding(avg !== null && avg < URGENT_LEAVE_RATE && pressure !== undefined && pressure !== "critical");
    if (since !== null && at - since >= LEAVE_URGENT_MS) return { ...prev, severity: "busy", reason: reason ?? prev.reason, since: at, leaveSince: null };
    return { ...prev, reason: reason ?? prev.reason, leaveSince: since };
  }
  if (prev.severity === "busy") {
    // Calmed: writes well under the busy line, and pressure normal, reading after reading.
    const since = holding(avg !== null && avg < BUSY_LEAVE_RATE && pressure === "normal");
    const long = windowAverage(history, at, LEAVE_BUSY_MS);
    if (since === null || at - since < LEAVE_BUSY_MS || long === null) return { ...prev, reason: reason ?? prev.reason, leaveSince: since };
    return long < QUIET_RATE
      ? { ...prev, severity: "recovered", since: at, leaveSince: null }
      : { ...prev, severity: "calm", reason: null, since: at, leaveSince: null };
  }
  if (prev.severity === "recovered" && at - prev.since >= RECOVERED_MS) return { ...prev, severity: "calm", reason: null, since: at, leaveSince: null };
  return prev;
}
