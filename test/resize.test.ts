import { expect, test } from "bun:test";
import { clampShare, shareAt, storedShare } from "../src/client/resize";

test("the pointer's height above the area's foot is the overview's share", () => {
  expect(shareAt(300, 100, 600)).toBe(0.6);
  expect(shareAt(600, 100, 600)).toBe(0);
});

test("the overview never takes more than half, so the note keeps the larger part", () => {
  expect(clampShare(0.8, 500, 1000, 96)).toBe(0.5);
});

test("nor more than it has to show, so the share kept is the one seen", () => {
  expect(clampShare(0.5, 500, 150, 96)).toBe(0.3);
});

test("nor less than its overview line", () => {
  expect(clampShare(0.05, 500, 400, 96)).toBe(0.192);
});

test("an overview shorter than that line is held to its own height", () => {
  expect(clampShare(0.05, 500, 60, 96)).toBe(0.12);
});

test("a kept share is read back within half, and anything else is the default", () => {
  expect(storedShare("0.3", 0.4)).toBe(0.3);
  expect(storedShare("0.9", 0.4)).toBe(0.5);
  expect(storedShare(null, 0.4)).toBe(0.4);
  expect(storedShare("wide", 0.4)).toBe(0.4);
  expect(storedShare("0", 0.4)).toBe(0.4);
});
