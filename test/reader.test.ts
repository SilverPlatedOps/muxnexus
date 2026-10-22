import { expect, test } from "bun:test";
import { textChange } from "../src/client/reader";

const apply = (prev: string, c: { from: number; to: number; insert: string }) => prev.slice(0, c.from) + c.insert + prev.slice(c.to);

test("the same text is no change", () => {
  expect(textChange("# Plan\n", "# Plan\n")).toBeNull();
});

test("an edit is only the span that differs, so what is above it stays put", () => {
  expect(textChange("# Plan\n- one\n- two\n", "# Plan\n- one\n- 2\n")).toEqual({ from: 15, to: 18, insert: "2" });
  expect(textChange("abc", "abXc")).toEqual({ from: 2, to: 2, insert: "X" });
  expect(textChange("abXc", "abc")).toEqual({ from: 2, to: 3, insert: "" });
});

test("a repeat at the seam is never counted twice", () => {
  for (const [prev, next] of [["aaa", "aa"], ["aa", "aaa"], ["abab", "ab"], ["x", ""], ["", "x"]] as const) {
    expect(apply(prev, textChange(prev, next)!)).toBe(next);
  }
});

test("a file saved with CRLF line breaks is the same text as its document, which keeps \\n", () => {
  expect(textChange("# Plan\n- one\n", "# Plan\r\n- one\r\n")).toBeNull();
  expect(textChange("# Plan\n- one\n", "# Plan\r\n- two\r\n")).toEqual({ from: 9, to: 12, insert: "two" });
});
