import { describe, expect, test } from "bun:test";
import type { RatePoint } from "../src/shared/protocol";
import { INITIAL_LEVEL, stepLevel, windowAverage, type LevelState } from "../src/server/levels";

const MB = 1024 ** 2;
const NOW = 10_000_000;

/** Rates in MB/s, one every `step` ms, the last at `end`. Null is a sample whose delta was unknown. */
function series(mbs: (number | null)[], end = NOW, step = 5000): RatePoint[] {
  return mbs.map((r, i) => ({ at: end - (mbs.length - 1 - i) * step, rate: r === null ? null : r * MB }));
}
const steady = (mb: number, seconds: number) => series(Array(seconds / 5 + 1).fill(mb));
const state = (over: Partial<LevelState>): LevelState => ({ ...INITIAL_LEVEL, ...over });

describe("windowAverage", () => {
  test("is the mean rate over the span", () => {
    expect(windowAverage(steady(6, 60), NOW, 60_000)).toBe(6 * MB);
    expect(windowAverage(series([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]), NOW, 60_000)).toBe(13 * MB);
  });

  test("knows nothing when a sample in the span was unknown", () => {
    const h = steady(6, 60);
    h[7] = { ...h[7], rate: null };
    expect(windowAverage(h, NOW, 60_000)).toBeNull();
  });

  test("knows nothing when the readings do not reach back over the whole span", () => {
    expect(windowAverage(steady(6, 30), NOW, 60_000)).toBeNull();
  });
});

describe("stepLevel", () => {
  test("a minute of writes at 5 MB/s or more is busy, at 20 MB/s or more urgent, each a new episode", () => {
    const busy = stepLevel(INITIAL_LEVEL, NOW, steady(6, 60), "normal");
    expect(busy).toMatchObject({ severity: "busy", reason: "writes", episode: NOW, acked: false });
    expect(stepLevel(INITIAL_LEVEL, NOW, steady(25, 60), "normal")).toMatchObject({ severity: "urgent", reason: "writes", episode: NOW });
  });

  test("memory pressure escalates at once, without waiting for a minute of readings", () => {
    expect(stepLevel(INITIAL_LEVEL, NOW, [], "warning")).toMatchObject({ severity: "busy", reason: "pressure" });
    expect(stepLevel(INITIAL_LEVEL, NOW, [], "critical")).toMatchObject({ severity: "urgent", reason: "pressure" });
    expect(stepLevel(INITIAL_LEVEL, NOW, steady(6, 60), "warning").reason).toBe("both");
  });

  test("urgent drops to busy only once it has eased for a whole minute", () => {
    const urgent = state({ severity: "urgent", reason: "both", episode: 5, since: NOW - 300_000 });
    expect(stepLevel({ ...urgent, leaveSince: NOW - 30_000 }, NOW, steady(2, 60), "normal").severity).toBe("urgent");
    expect(stepLevel({ ...urgent, leaveSince: NOW - 60_000 }, NOW, steady(2, 60), "normal")).toMatchObject({ severity: "busy", episode: 5 });
    // Critical pressure now starts the minute over.
    expect(stepLevel({ ...urgent, leaveSince: NOW - 60_000 }, NOW, steady(2, 60), "critical")).toMatchObject({ severity: "urgent", leaveSince: null });
  });

  test("busy recovers after two quiet minutes, and goes calm without the green line when writes only eased", () => {
    const busy = state({ severity: "busy", reason: "writes", episode: 7, since: NOW - 600_000, leaveSince: NOW - 120_000 });
    expect(stepLevel(busy, NOW, steady(0.5, 120), "normal")).toMatchObject({ severity: "recovered", reason: "writes", episode: 7 });
    expect(stepLevel(busy, NOW, steady(3, 120), "normal")).toMatchObject({ severity: "calm" });
  });

  test("busy does not recover while pressure was raised in the last two minutes", () => {
    const busy = state({ severity: "busy", reason: "pressure", since: NOW - 600_000, leaveSince: NOW - 90_000 });
    expect(stepLevel(busy, NOW, steady(0, 120), "normal").severity).toBe("busy");
  });

  test("recovered lasts ten minutes, and new writes start a new episode", () => {
    const recovered = state({ severity: "recovered", reason: "writes", episode: 7, since: NOW - 600_000 });
    expect(stepLevel(recovered, NOW, steady(0, 120), "normal").severity).toBe("calm");
    const again = stepLevel({ ...recovered, since: NOW - 60_000 }, NOW, steady(6, 60), "normal");
    expect(again).toMatchObject({ severity: "busy", episode: NOW, acked: false });
  });

  test("an unknown reading in the leave window keeps busy, however long ago it began", () => {
    const busy = state({ severity: "busy", reason: "writes", since: NOW - 3 * 3600_000, leaveSince: NOW - 3 * 3600_000 });
    const h = steady(0, 120);
    h[20] = { ...h[20], rate: null };
    expect(stepLevel(busy, NOW, h, "normal").severity).toBe("busy");
  });

  test("an unknown pressure reading keeps busy too", () => {
    const busy = state({ severity: "busy", reason: "pressure", since: NOW - 600_000, leaveSince: NOW - 600_000 });
    expect(stepLevel(busy, NOW, steady(0, 120), undefined)).toMatchObject({ severity: "busy", leaveSince: null });
  });

  test("an episode of writes alone can still end while the pressure reading is missing", () => {
    const busy = state({ severity: "busy", reason: "writes", since: NOW - 600_000, leaveSince: NOW - 120_000 });
    expect(stepLevel(busy, NOW, steady(0.5, 120), undefined).severity).toBe("recovered");
    const urgent = state({ severity: "urgent", reason: "writes", since: NOW - 600_000, leaveSince: NOW - 60_000 });
    expect(stepLevel(urgent, NOW, steady(2, 60), undefined).severity).toBe("busy");
  });

  test("busy turning urgent is the same episode, acknowledged or not", () => {
    const busy = state({ severity: "busy", reason: "writes", episode: 123, acked: true, since: NOW - 60_000 });
    expect(stepLevel(busy, NOW, steady(25, 60), "normal")).toMatchObject({ severity: "urgent", episode: 123, acked: true });
  });
});

describe("stepLevel over time", () => {
  /** Feed one reading every 5 s, as the sampler does; returns each change of severity. */
  function drive(rateAt: (t: number) => number, seconds: number) {
    let level: LevelState = INITIAL_LEVEL;
    const history: RatePoint[] = [];
    const changes: { t: number; to: string; episode: number }[] = [];
    for (let t = 0; t <= seconds; t += 5) {
      const at = 1_000_000 + t * 1000;
      history.push({ at, rate: t === 0 ? null : rateAt(t) * MB });
      const prev = level;
      level = stepLevel(level, at, history.filter((p) => p.at >= at - 300_000), "normal");
      if (level.severity !== prev.severity) changes.push({ t, to: level.severity, episode: level.episode });
    }
    return changes;
  }

  test("writes that begin and keep up are one episode, busy throughout", () => {
    const changes = drive((t) => (t <= 120 ? 0 : 6), 600);
    expect(changes).toHaveLength(1);
    expect(changes[0].to).toBe("busy");
  });

  test("writes that ease well under the urgent line drop it to busy after a minute, and stay one episode", () => {
    const changes = drive((t) => (t <= 200 ? 30 : 10), 600);
    expect(changes.map((c) => c.to)).toEqual(["urgent", "busy"]);
    expect(changes[1].t - 200).toBeGreaterThanOrEqual(60);
    expect(new Set(changes.map((c) => c.episode)).size).toBe(1);
  });

  test("writes alternating either side of the urgent line keep it urgent", () => {
    const changes = drive((t) => (t <= 200 ? 30 : (t / 5) % 2 === 0 ? 22 : 18), 600);
    expect(changes.map((c) => c.to)).toEqual(["urgent"]);
  });

  test("writes hovering around the urgent line do not flip it more than once a minute", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const rates = new Map<number, number>();
    const changes = drive((t) => {
      if (!rates.has(t)) rates.set(t, t <= 200 ? 30 : 20 + (rnd() - 0.5) * 16);
      return rates.get(t)!;
    }, 1200);
    const flips = changes.filter((c) => c.t > 200);
    for (let i = 1; i < flips.length; i++) expect(flips[i].t - flips[i - 1].t).toBeGreaterThanOrEqual(60);
    expect(new Set(changes.map((c) => c.episode)).size).toBe(1);
  });
});
