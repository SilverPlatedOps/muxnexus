import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Tmux } from "../src/server/tmux";

const tmux = new Tmux("mxn-chat-tmux-test");

beforeEach(async () => { await tmux.killServer(); });
afterEach(async () => { await tmux.killServer(); });

async function pane(session: string): Promise<{ pane: string; window: string }> {
  await tmux.newSession(session);
  const [pane, window] = (await tmux.run(["display-message", "-p", "-t", `=${session}:`, "#{pane_id} #{window_id}"])).trim().split(" ");
  return { pane: pane!, window: window! };
}

describe("chat lookups", () => {
  test("a pane names its window and workspace", async () => {
    const p = await pane("shop");
    expect(await tmux.windowOfPane(p.pane)).toEqual({ windowId: p.window, session: "shop" });
    expect(await tmux.windowOfPane("%9999")).toBeNull();
  });

  test("a Claude window's agent comes from its stamp", async () => {
    const p = await pane("shop");
    await tmux.run(["set-option", "-p", "-t", p.pane, "@muxnexus_agent", "done 1790000000 4242 /Users/me/.claude-work"]);
    await tmux.run(["set-option", "-p", "-t", p.pane, "@muxnexus_session", "abc-123 /Users/me/.claude-work/projects/x/abc-123.jsonl"]);
    const a = await tmux.agentOfWindow(p.window);
    expect(a).toMatchObject({
      paneId: p.pane,
      kind: "claude",
      pid: 4242,
      configDir: "/Users/me/.claude-work",
      state: "done",
      conversation: { sessionId: "abc-123", transcriptPath: "/Users/me/.claude-work/projects/x/abc-123.jsonl" },
    });
    expect(a?.daemon).toBeFalsy();
  });

  test("a Codex window's agent carries its thread", async () => {
    const p = await pane("shop");
    await tmux.run(["set-option", "-p", "-t", p.pane, "@muxnexus_agent", "running 1790000000 777 /Users/me/.codex"]);
    await tmux.run(["set-option", "-p", "-t", p.pane, "@muxnexus_thread", "01a1-t /Users/me/.codex/sessions/r 1.jsonl"]);
    expect(await tmux.agentOfWindow(p.window)).toMatchObject({
      kind: "codex",
      pid: 777,
      state: "running",
      thread: { id: "01a1-t", path: "/Users/me/.codex/sessions/r 1.jsonl" },
    });
  });

  test("a window with no stamp has no agent", async () => {
    const p = await pane("shop");
    expect(await tmux.agentOfWindow(p.window)).toBeNull();
    expect(await tmux.agentOfWindow("@9999")).toBeNull();
  });
});
