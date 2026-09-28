import { expect, test } from "bun:test";
import { debounce, wheelLines } from "../src/client/terminal";

test("debounce collapses rapid calls into the last one", async () => {
  const calls: number[] = [];
  const d = debounce((n: number) => calls.push(n), 30);
  d(1); d(2); d(3);
  await Bun.sleep(60);
  d(4);
  await Bun.sleep(60);
  expect(calls).toEqual([3, 4]);
});

test("the wheel scrolls by whole rows, keeping a trackpad's small deltas until they add up", () => {
  // 15 px rows: a 45 px notch is three rows; a trackpad's 5 px nudges wait.
  expect(wheelLines(0, { deltaY: -45, deltaMode: 0 }, 15)).toEqual({ lines: -3, rest: 0 });
  let r = wheelLines(0, { deltaY: 5, deltaMode: 0 }, 15);
  expect(r.lines).toBe(0);
  r = wheelLines(r.rest, { deltaY: 5, deltaMode: 0 }, 15);
  r = wheelLines(r.rest, { deltaY: 5, deltaMode: 0 }, 15);
  expect(r.lines).toBe(1);
});

test("line and page deltas are rows already, or a screenful of them", () => {
  expect(wheelLines(0, { deltaY: 3, deltaMode: 1 }, 15, 40).lines).toBe(3);
  expect(wheelLines(0, { deltaY: -1, deltaMode: 2 }, 15, 40).lines).toBe(-40);
});
