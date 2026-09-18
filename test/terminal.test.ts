import { expect, test } from "bun:test";
import { debounce } from "../src/client/terminal";

test("debounce collapses rapid calls into the last one", async () => {
  const calls: number[] = [];
  const d = debounce((n: number) => calls.push(n), 30);
  d(1); d(2); d(3);
  await Bun.sleep(60);
  d(4);
  await Bun.sleep(60);
  expect(calls).toEqual([3, 4]);
});
