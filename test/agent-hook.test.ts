import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Tmux } from "../src/server/tmux";

const SOCKET = "mxn-agent-hook-test";
const tmux = new Tmux(SOCKET);
const SCRIPT = join(import.meta.dir, "..", "scripts", "agent-state.sh");

let pane = "";
let socket = "";

beforeEach(async () => {
  await tmux.killServer();
  await tmux.newSession("hook");
  pane = (await tmux.run(["display-message", "-p", "-t", "=hook:", "#{pane_id}"])).trim();
  socket = (await tmux.run(["display-message", "-p", "-t", "=hook:", "#{socket_path}"])).trim();
});
afterEach(async () => { await tmux.killServer(); });

/** Run the hook as Claude Code would, from inside the pane. */
async function fire(event: string, payload: object): Promise<void> {
  const p = Bun.spawn(["sh", SCRIPT, event], {
    stdin: new Blob([JSON.stringify(payload)]),
    env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane },
  });
  await p.exited;
}

const state = async () =>
  (await tmux.run(["show-options", "-p", "-v", "-t", pane, "@muxnexus_agent"]).catch(() => "")).trim().split(" ")[0];

describe("agent-state.sh", () => {
  test("a turn that ends in an API error is over", async () => {
    await fire("UserPromptSubmit", {});
    await fire("StopFailure", { error: "rate_limit" });
    expect(await state()).toBe("done");
  });
});
