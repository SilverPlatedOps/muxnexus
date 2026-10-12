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
async function fire(event: string, payload: object, extra: string[] = [], env: Record<string, string> = {}): Promise<number> {
  const p = Bun.spawn(["sh", SCRIPT, event, ...extra], {
    stdin: new Blob([JSON.stringify(payload)]),
    env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane, ...env },
  });
  return await p.exited;
}

/** Fire with a raw payload string, for spacing JSON.stringify never produces. */
async function fireRaw(event: string, raw: string): Promise<number> {
  const p = Bun.spawn(["sh", SCRIPT, event], {
    stdin: new Blob([raw]),
    env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane },
  });
  return await p.exited;
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

  test("a prompt marks the turn's start, and a tool call does not move it", async () => {
    await fire("UserPromptSubmit", {});
    const turn = await option("@muxnexus_turn");
    expect(turn).toMatch(/^\d+$/);
    await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_turn", "100"]);
    await fire("PreToolUse", { tool_name: "Bash" });
    await fire("PostToolUse", { tool_name: "Bash" });
    expect(await option("@muxnexus_turn")).toBe("100");
  });

  test("the end of a turn is appended once", async () => {
    await fire("UserPromptSubmit", {});
    await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_turn", "100"]);
    await fire("Stop", {});
    expect(await option("@muxnexus_turn")).toMatch(/^100 \d+$/);
    const ended = await option("@muxnexus_turn");
    await fire("Stop", {});
    expect(await option("@muxnexus_turn")).toBe(ended);
  });

  test("an API error ends the turn too", async () => {
    await fire("UserPromptSubmit", {});
    await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_turn", "100"]);
    await fire("StopFailure", {});
    expect(await option("@muxnexus_turn")).toMatch(/^100 \d+$/);
  });

  test("a wait is marked when it begins, not when it is repeated", async () => {
    await fire("UserPromptSubmit", {});
    await fire("PermissionRequest", {});
    expect(await option("@muxnexus_wait")).toMatch(/^\d+$/);
    // The Notification that follows a permission prompt is the same wait.
    await tmux.run(["set-option", "-p", "-t", pane, "@muxnexus_wait", "5"]);
    await fire("Notification", { notification_type: "permission_prompt" });
    expect(await option("@muxnexus_wait")).toBe("5");
    // Back to work, then a new prompt: a new wait.
    await fire("PostToolUse", { tool_name: "Bash" });
    await fire("PermissionRequest", {});
    expect(await option("@muxnexus_wait")).not.toBe("5");
  });

  test("answering AskUserQuestion resumes the turn", async () => {
    await fire("UserPromptSubmit", {});
    await fire("PreToolUse", { tool_name: "AskUserQuestion" });
    expect(await state()).toBe("input");
    await fire("PostToolUse", { tool_name: "AskUserQuestion" });
    expect(await state()).toBe("running");
  });

  test("AskUserQuestion is matched with a space after the colon", async () => {
    await fireRaw("PreToolUse", '{"tool_name": "AskUserQuestion"}');
    expect(await state()).toBe("input");
  });

  test("SessionEnd clears the stamp and both boundaries", async () => {
    await fire("UserPromptSubmit", {});
    await fire("PermissionRequest", {});
    await fire("SessionEnd", {});
    expect(await option("@muxnexus_agent")).toBe("");
    expect(await option("@muxnexus_turn")).toBe("");
    expect(await option("@muxnexus_wait")).toBe("");
  });

  test("every event exits 0, so a synchronous Codex hook never blocks a tool", async () => {
    const events = ["PermissionRequest", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification",
      "Stop", "StopFailure", "SessionStart", "SessionEnd", "SomethingNew"];
    for (const event of events) {
      expect(await fire(event, { tool_name: "AskUserQuestion", notification_type: "permission_prompt" })).toBe(0);
      expect(await fireRaw(event, "not json at all")).toBe(0);
    }
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
