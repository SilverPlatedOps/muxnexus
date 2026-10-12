import { describe, expect, test } from "bun:test";
import { skyAt } from "../src/client/building/sky";
import { planErrand, type PetPlace, type PetWorld } from "../src/client/building/pets";

const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);

describe("skyAt: the real time of day outside", () => {
  test("dawn, day, dusk and night by the local clock", () => {
    expect([at(4, 59), at(5), at(6, 59), at(7), at(16, 59), at(17), at(18, 59), at(19), at(23)].map(skyAt))
      .toEqual(["night", "dawn", "dawn", "day", "day", "dusk", "dusk", "night", "night"]);
  });
});

describe("planErrand", () => {
  const place = (floor: string, x: number): PetPlace => ({ floor, x });
  const world: PetWorld = {
    floors: [{ key: "a", width: 900 }, { key: "b", width: 700 }],
    bowl: place("b", 600),
    bed: place("b", 660),
    longestWait: null,
    longestIdle: null,
  };
  const rand = (v: number) => () => v;

  test("the dog goes to whoever has waited longest, and stays", () => {
    const e = planErrand("dog", place("b", 10), { ...world, longestWait: place("a", 300) }, rand(0.9));
    expect(e).toEqual({ to: place("a", 272), then: "sit", stayMs: 20_000 });
  });

  test("nobody waiting: the dog eats or wanders on its own floor", () => {
    expect(planErrand("dog", place("a", 10), world, rand(0.1))).toEqual({ to: place("b", 580), then: "eat", stayMs: 6_000 });
    const w = planErrand("dog", place("a", 10), world, rand(0.8));
    expect([w.to.floor, w.then]).toEqual(["a", "sit"]);
    expect(w.to.x).toBeGreaterThanOrEqual(120);
    expect(w.to.x).toBeLessThanOrEqual(900 - 60);
  });

  test("the cat naps in its bed, eats, visits the longest idle, or wanders", () => {
    expect(planErrand("cat", place("a", 10), world, rand(0.1)).then).toBe("nap");
    expect(planErrand("cat", place("a", 10), world, rand(0.1)).to).toEqual(place("b", 660));
    expect(planErrand("cat", place("a", 10), world, rand(0.45)).then).toBe("eat");
    expect(planErrand("cat", place("a", 10), { ...world, longestIdle: place("a", 400) }, rand(0.65)))
      .toEqual({ to: place("a", 424), then: "visit", stayMs: 15_000 });
    expect(planErrand("cat", place("a", 10), world, rand(0.65)).then).toBe("sit");
  });

  test("a floor that is gone is never a destination", () => {
    const gone = { ...world, bowl: place("zz", 5), bed: place("zz", 5) };
    expect(planErrand("cat", place("a", 10), gone, rand(0.1)).to.floor).toBe("a");
  });
});
