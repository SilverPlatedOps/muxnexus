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

  test("urgent holds while pressure was critical in the last minute, then drops to busy", () => {
    const urgent = state({ severity: "urgent", reason: "both", episode: 5, since: NOW - 300_000 });
    expect(stepLevel({ ...urgent, pressureCriticalAt: NOW - 30_000 }, NOW, steady(2, 60), "normal").severity).toBe("urgent");
    expect(stepLevel({ ...urgent, pressureCriticalAt: NOW - 60_000 }, NOW, steady(2, 60), "normal")).toMatchObject({ severity: "busy", episode: 5 });
  });

  test("busy recovers after two quiet minutes, and goes calm without the green line when writes only eased", () => {
    const busy = state({ severity: "busy", reason: "writes", episode: 7, since: NOW - 600_000 });
    expect(stepLevel(busy, NOW, steady(0.5, 120), "normal")).toMatchObject({ severity: "recovered", reason: "writes", episode: 7 });
    expect(stepLevel(busy, NOW, steady(3, 120), "normal")).toMatchObject({ severity: "calm" });
  });

  test("busy does not recover while pressure was raised in the last two minutes", () => {
    const busy = state({ severity: "busy", reason: "pressure", since: NOW - 600_000, pressureAbnormalAt: NOW - 90_000 });
    expect(stepLevel(busy, NOW, steady(0, 120), "normal").severity).toBe("busy");
  });

  test("recovered lasts ten minutes, and new writes start a new episode", () => {
    const recovered = state({ severity: "recovered", reason: "writes", episode: 7, since: NOW - 600_000 });
    expect(stepLevel(recovered, NOW, steady(0, 120), "normal").severity).toBe("calm");
    const again = stepLevel({ ...recovered, since: NOW - 60_000 }, NOW, steady(6, 60), "normal");
    expect(again).toMatchObject({ severity: "busy", episode: NOW, acked: false });
  });

  test("an unknown reading in the leave window keeps busy, however long ago it began", () => {
    const busy = state({ severity: "busy", reason: "writes", since: NOW - 3 * 3600_000 });
    const h = steady(0, 120);
    h[20] = { ...h[20], rate: null };
    expect(stepLevel(busy, NOW, h, "normal").severity).toBe("busy");
  });

  test("an unknown pressure reading keeps busy too", () => {
    const busy = state({ severity: "busy", reason: "pressure", since: NOW - 600_000 });
    expect(stepLevel(busy, NOW, steady(0, 120), undefined).severity).toBe("busy");
  });

  test("busy turning urgent is the same episode, acknowledged or not", () => {
    const busy = state({ severity: "busy", reason: "writes", episode: 123, acked: true, since: NOW - 60_000 });
    expect(stepLevel(busy, NOW, steady(25, 60), "normal")).toMatchObject({ severity: "urgent", episode: 123, acked: true });
  });
});
