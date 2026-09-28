import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers";
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

/** Run the hook as Claude Code would, from inside the pane; `extra` is Codex's `codex` argument. */
async function fire(event: string, payload: object, extra: string[] = [], env: Record<string, string> = {}): Promise<void> {
  const p = Bun.spawn(["sh", SCRIPT, event, ...extra], {
    stdin: new Blob([JSON.stringify(payload)]),
    env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane, ...env },
  });
  await p.exited;
}

const option = async (name: string) =>
  (await tmux.run(["show-options", "-p", "-v", "-t", pane, name]).catch(() => "")).trim();

const state = async () =>
  (await tmux.run(["show-options", "-p", "-v", "-t", pane, "@muxnexus_agent"]).catch(() => "")).trim().split(" ")[0];

describe("agent-state.sh", () => {
  test("a turn that ends in an API error is over", async () => {
    await fire("UserPromptSubmit", {});
    await fire("StopFailure", { error: "rate_limit" });
    expect(await state()).toBe("done");
  });

  describe("under Codex", () => {
    /**
     * Run it as `codex --no-daemon` does: from a process inside the pane. The
     * pane's shell runs it, so the hook descends from the pane's own process.
     */
    const codex = async (event: string, payload: object = {}) => {
      const dir = mkdtempSync(join(tmpdir(), "mxn-hook-"));
      writeFileSync(join(dir, "payload"), JSON.stringify(payload));
      await tmux.run(["send-keys", "-t", pane, "-l",
        `CODEX_HOME=/Users/someone/.codex CLAUDE_CONFIG_DIR=/Users/someone/.claude-work sh ${SCRIPT} ${event} codex < ${dir}/payload; touch ${dir}/done`]);
      await tmux.run(["send-keys", "-t", pane, "Enter"]);
      await waitFor(() => existsSync(join(dir, "done")), 3000, "hook ran in the pane");
      rmSync(dir, { recursive: true, force: true });
    };

    test("the stamp names Codex's home as the account, not a Claude profile", async () => {
      await codex("UserPromptSubmit");
      expect(await option("@muxnexus_agent")).toMatch(/^running \d+ \d+ \/Users\/someone\/\.codex$/);
    });

    test("no conversation is stamped: a Codex rollout is not something claude can resume", async () => {
      await codex("SessionStart", { session_id: "abc", transcript_path: "/Users/someone/.codex/sessions/r.jsonl" });
      expect(await state()).toBe("done");
      expect(await option("@muxnexus_session")).toBe("");
    });

    test("asking the user a question is waiting on them", async () => {
      await codex("PreToolUse", { tool_name: "request_user_input" });
      expect(await state()).toBe("input");
    });

    test("run from outside the pane -- Codex's shared daemon -- it stamps nothing", async () => {
      // The daemon holds the $TMUX_PANE of whatever terminal started it.
      await fire("UserPromptSubmit", {}, ["codex"]);
      expect(await option("@muxnexus_agent")).toBe("");
    });
  });
});
