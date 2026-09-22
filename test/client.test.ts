import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Connection, backoffDelay, parseServerMessage } from "../src/client/socket";
import type { ServerMessage } from "../src/shared/protocol";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";

describe("parseServerMessage", () => {
  test("parses a valid message", () => {
    expect(parseServerMessage('{"t":"attached","session":"x"}')).toEqual({ t: "attached", session: "x" });
  });
  test("returns null for invalid JSON or missing t", () => {
    expect(parseServerMessage("nope")).toBeNull();
    expect(parseServerMessage('{"x":1}')).toBeNull();
  });
});

describe("backoffDelay", () => {
  test("doubles from 250 ms and caps at 5 s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);
  });
});

describe("Connection against a real server", () => {
  const SOCKET = "cmux-viewer-test-client";
  const tmux = new Tmux(SOCKET);
  let server: RunningServer;
  beforeAll(() => { server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 }); });
  afterAll(() => server.stop());
  beforeEach(async () => { await tmux.killServer(); });
  afterEach(async () => { await tmux.killServer(); });

  test("opens, receives state, attaches, and streams output", async () => {
    await tmux.run(["new-session", "-d", "-s", "s", "sh"]);
    const messages: ServerMessage[] = [];
    let opened = 0;
    let output = "";
    const dec = new TextDecoder();
    const conn = new Connection(`ws://127.0.0.1:${server.port}/ws`, {
      onOpen: () => { opened++; },
      onClose: () => {},
      onMessage: (m) => { messages.push(m); },
      onOutput: (b) => { output += dec.decode(b, { stream: true }); },
    }, { headers: { Origin: `http://127.0.0.1:${server.port}` } });
    conn.connect();
    await waitFor(() => opened === 1, 2000, "open");
    await waitFor(() => messages.some((m) => m.t === "state"), 2000, "state");
    conn.send({ t: "attach", session: "s" });
    await waitFor(() => messages.some((m) => m.t === "attached"), 2000, "attached");
    conn.sendInput("echo CLI_MARK_$((2+2))\r");
    await waitFor(() => output.includes("CLI_MARK_4"), 3000, "output");
    conn.close();
  });

  test("reconnects after the socket drops", async () => {
    let opened = 0;
    let closed = 0;
    const conn = new Connection(`ws://127.0.0.1:${server.port}/ws`, {
      onOpen: () => { opened++; },
      onClose: () => { closed++; },
      onMessage: () => {},
      onOutput: () => {},
    }, { headers: { Origin: `http://127.0.0.1:${server.port}` } });
    conn.connect();
    await waitFor(() => opened === 1, 2000, "first open");
    conn.dropForTest();
    await waitFor(() => closed === 1, 2000, "closed");
    await waitFor(() => opened === 2, 3000, "reopened");
    conn.close();
  });

  test("connect() is a no-op while a socket already exists", async () => {
    let opened = 0;
    const conn = new Connection(`ws://127.0.0.1:${server.port}/ws`, {
      onOpen: () => { opened++; },
      onClose: () => {},
      onMessage: () => {},
      onOutput: () => {},
    }, { headers: { Origin: `http://127.0.0.1:${server.port}` } });
    conn.connect();
    conn.connect();
    await waitFor(() => opened === 1, 2000, "first open");
    await Bun.sleep(300);
    expect(opened).toBe(1);
    conn.close();
  });
});
