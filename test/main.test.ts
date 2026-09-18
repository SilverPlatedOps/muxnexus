import { expect, test } from "bun:test";
import { CMUX_TMUX_SOCKET, parseArgs, resolveSocketPath } from "../src/server/main";

test("defaults to port 7681 and no host", () => {
  expect(parseArgs([])).toEqual({ host: undefined, port: 7681, socket: undefined });
});

test("parses --host and --port in either order", () => {
  expect(parseArgs(["--port", "9000", "--host", "127.0.0.1"])).toEqual({ host: "127.0.0.1", port: 9000, socket: undefined });
  expect(parseArgs(["--host=0.0.0.0", "--port=1"])).toEqual({ host: "0.0.0.0", port: 1, socket: undefined });
});

test("rejects a non-numeric port", () => {
  expect(() => parseArgs(["--port", "abc"])).toThrow(/port/);
});

test("rejects a flag with a missing value", () => {
  expect(() => parseArgs(["--host"])).toThrow(/missing value for --host/);
  expect(() => parseArgs(["--host", "--port", "9000"])).toThrow(/missing value for --host/);
  expect(() => parseArgs(["--port"])).toThrow(/missing value for --port/);
  expect(() => parseArgs(["--port="])).toThrow(/missing value for --port/);
  expect(() => parseArgs(["--host="])).toThrow(/missing value for --host/);
});

test("parses --socket as a tmux socket path", () => {
  expect(parseArgs(["--socket", "/tmp/x.sock"]).socket).toBe("/tmp/x.sock");
  expect(parseArgs(["--socket=/tmp/y.sock"]).socket).toBe("/tmp/y.sock");
  expect(() => parseArgs(["--socket"])).toThrow(/missing value for --socket/);
});

test("resolveSocketPath prefers an explicit path, then cmux's socket, then tmux's default", () => {
  expect(resolveSocketPath("/tmp/x.sock", true)).toBe("/tmp/x.sock");
  expect(resolveSocketPath(undefined, true)).toBe(CMUX_TMUX_SOCKET);
  expect(resolveSocketPath(undefined, false)).toBeUndefined();
  expect(CMUX_TMUX_SOCKET.endsWith("/.cmux/local-tmux/server.sock")).toBe(true);
});
