import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";

const SOCKET = "mxn-board-test";
const tmux = new Tmux(SOCKET);
let server: RunningServer;

const board = (init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}/api/board`, init);

beforeAll(() => {
  server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200 });
});
afterAll(() => server.stop());
beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

describe("the board endpoint", () => {
  test("lists a stamped agent without any page open", async () => {
    await tmux.newSession("JKB");
    const windowId = (await tmux.run(["display-message", "-p", "-t", "JKB", "#{window_id}"])).trim();
    const since = Math.floor(Date.now() / 1000) - 90;
    await tmux.run(["set-option", "-p", "-t", "JKB", "@muxnexus_agent", `input ${since} ${process.pid} /home/u/.claude-work`]);
    const res = await board();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.v).toBe(1);
    expect(typeof body.src).toBe("string");
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ n: "JKB", p: "work", s: "asked", i: windowId });
    expect(body.agents[0].a).toBeGreaterThanOrEqual(90);
  });

  test("only reads", async () => {
    expect((await board({ method: "POST" })).status).toBe(405);
    expect((await board({ method: "DELETE" })).status).toBe(405);
  });

  test("refuses a name this server was not told it answers to", async () => {
    expect((await board({ headers: { host: "attacker.example" } })).status).toBe(403);
  });
});
