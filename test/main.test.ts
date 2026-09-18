import { expect, test } from "bun:test";
import { parseArgs } from "../src/server/main";

test("defaults to port 7681 and no host", () => {
  expect(parseArgs([])).toEqual({ host: undefined, port: 7681 });
});

test("parses --host and --port in either order", () => {
  expect(parseArgs(["--port", "9000", "--host", "127.0.0.1"])).toEqual({ host: "127.0.0.1", port: 9000 });
  expect(parseArgs(["--host=0.0.0.0", "--port=1"])).toEqual({ host: "0.0.0.0", port: 1 });
});

test("rejects a non-numeric port", () => {
  expect(() => parseArgs(["--port", "abc"])).toThrow(/port/);
});
