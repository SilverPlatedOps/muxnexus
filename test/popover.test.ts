import { expect, test } from "bun:test";
import { placeMenu } from "../src/client/popover";

test("placeMenu: below, flips up at the bottom, shifts in from the right", () => {
  const view = { w: 1440, h: 900 }, size = { w: 260, h: 300 };
  expect(placeMenu({ x: 100, y: 100, w: 30, h: 30 }, size, view)).toEqual({ x: 100, y: 130 });
  expect(placeMenu({ x: 100, y: 800, w: 30, h: 30 }, size, view)).toEqual({ x: 100, y: 500 });
  expect(placeMenu({ x: 1400, y: 100, w: 30, h: 30 }, size, view)).toEqual({ x: 1172, y: 130 });
});

test("placeMenu: a pointer is a zero-size anchor; never off the top or left", () => {
  const view = { w: 800, h: 400 };
  expect(placeMenu({ x: 50, y: 60, w: 0, h: 0 }, { w: 200, h: 100 }, view)).toEqual({ x: 50, y: 60 });
  expect(placeMenu({ x: 0, y: 200, w: 10, h: 10 }, { w: 200, h: 390 }, view)).toEqual({ x: 8, y: 8 });
});
