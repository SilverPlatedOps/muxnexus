import { expect, test } from "bun:test";
import { CMUX_TMUX_SOCKET, magicDnsNames, parseArgs, resolveHosts, resolveSocketPath } from "../src/server/main";

test("defaults to port 7681 and no host", () => {
  expect(parseArgs([])).toEqual({ hosts: [], port: 7681, socket: undefined, allowHosts: [] });
});

test("parses --host and --port in either order", () => {
  expect(parseArgs(["--port", "9000", "--host", "127.0.0.1"])).toEqual({ hosts: ["127.0.0.1"], port: 9000, socket: undefined, allowHosts: [] });
  expect(parseArgs(["--host=0.0.0.0", "--port=1"])).toEqual({ hosts: ["0.0.0.0"], port: 1, socket: undefined, allowHosts: [] });
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

test("collects --allow-host, which may be repeated", () => {
  expect(parseArgs(["--allow-host", "macbook"]).allowHosts).toEqual(["macbook"]);
  expect(parseArgs(["--allow-host=a.ts.net", "--allow-host", "b.example"]).allowHosts).toEqual(["a.ts.net", "b.example"]);
  expect(() => parseArgs(["--allow-host"])).toThrow(/missing value for --allow-host/);
});

test("magicDnsNames reads the node's own name, long and short, without the trailing dot", () => {
  const json = JSON.stringify({ Self: { DNSName: "macbook.tail1234ab.ts.net." } });
  expect(magicDnsNames(json)).toEqual(["macbook.tail1234ab.ts.net", "macbook"]);
});

test("magicDnsNames yields nothing when Tailscale reports no name", () => {
  expect(magicDnsNames("")).toEqual([]);
  expect(magicDnsNames("not json")).toEqual([]);
  expect(magicDnsNames(JSON.stringify({ Self: {} }))).toEqual([]);
});

test("resolveHosts adds loopback so localhost keeps working alongside the tailnet", () => {
  expect(resolveHosts([], "100.101.102.103")).toEqual(["100.101.102.103", "127.0.0.1"]);
  expect(resolveHosts(["100.101.102.103"], "100.101.102.103")).toEqual(["100.101.102.103", "127.0.0.1"]);
});

test("resolveHosts does not bind the same address twice", () => {
  expect(resolveHosts(["127.0.0.1"], "100.101.102.103")).toEqual(["127.0.0.1"]);
  expect(resolveHosts(["127.0.0.1", "127.0.0.1"], "100.101.102.103")).toEqual(["127.0.0.1"]);
});

test("resolveHosts leaves a wildcard bind alone, since it already covers loopback", () => {
  expect(resolveHosts(["0.0.0.0"], "100.101.102.103")).toEqual(["0.0.0.0"]);
  expect(resolveHosts(["::"], "100.101.102.103")).toEqual(["::"]);
});
