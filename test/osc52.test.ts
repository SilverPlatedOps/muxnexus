import { expect, test } from "bun:test";
import { osc52Text } from "../src/client/terminal";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("tmux's copy of Claude's selection, with no selection letter, becomes its text", () => {
  // As captured from warrior: ESC ] 52 ; ; IHYyLjEuMzI1 BEL
  expect(osc52Text(";IHYyLjEuMzI1")).toBe(" v2.1.325");
});

test("a named selection and UTF-8 text decode too", () => {
  expect(osc52Text(`c;${b64("Jenkins is green ✓ — café")}`)).toBe("Jenkins is green ✓ — café");
});

test("a request to read the clipboard, a clear, and garbage are ignored", () => {
  expect(osc52Text("c;?")).toBeNull();
  expect(osc52Text("c;")).toBeNull();
  expect(osc52Text("no separator")).toBeNull();
  expect(osc52Text("c;%%%not base64%%%")).toBeNull();
});
