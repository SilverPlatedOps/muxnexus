import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseWindowAgent, Tmux } from "../src/server/tmux";

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
      since: 1790000000,
      thread: { id: "01a1-t", path: "/Users/me/.codex/sessions/r 1.jsonl" },
    });
  });

  test("a window with no stamp has no agent", async () => {
    const p = await pane("shop");
    expect(await tmux.agentOfWindow(p.window)).toBeNull();
    expect(await tmux.agentOfWindow("@9999")).toBeNull();
  });

  test("an unstamped pane running codex is a daemon-run Codex tab", () => {
    expect(parseWindowAgent(["%3\tcodex\t/w\t\t\t"])).toEqual({ paneId: "%3", kind: "codex", daemon: true, cwd: "/w" });
    expect(parseWindowAgent(["%3\tcodex\t/w\t\t\t"], { "%3": "codex -c x=1" })).toEqual({ paneId: "%3", kind: "codex", daemon: true, cwd: "/w" });
    expect(parseWindowAgent(["%3\tzsh\t/w\t\t\t"])).toBeNull();
  });

  test("an unstamped --no-daemon codex is a Codex tab that hasn't started a conversation yet", () => {
    expect(parseWindowAgent(["%3\tcodex\t/w\t\t\t"], { "%3": "codex --no-daemon -c tui.alternate_screen=never" })).toEqual({ paneId: "%3", kind: "codex", fresh: true, cwd: "/w" });
  });

  test("a stamped pane wins over a daemon-looking one", () => {
    expect(parseWindowAgent(["%3\tcodex\t/w\t\t\t", "%4\tnode\t/w\tth /r.jsonl\t\tdone 1790000000 9 /Users/me/.codex"])).toMatchObject({ paneId: "%4", kind: "codex", thread: { id: "th", path: "/r.jsonl" } });
  });

  test("a spawned tab opens in its folder and names its window", async () => {
    await pane("shop");
    const id = await tmux.spawnWindow("shop", "/tmp", "sleep 30");
    expect(id).toMatch(/^@\d+$/);
    const cwd = (await tmux.run(["display-message", "-p", "-t", id, "#{pane_current_path}"])).trim();
    expect(cwd.endsWith("/tmp")).toBe(true);
  });

  test("with no folder, a spawned tab opens in its workspace's folder, not the server's", async () => {
    await tmux.newSession("shop", "/tmp");
    const id = await tmux.spawnWindow("shop", null, "sleep 30");
    const cwd = (await tmux.run(["display-message", "-p", "-t", id, "#{pane_current_path}"])).trim();
    expect(cwd.endsWith("/tmp")).toBe(true);
  });

  test("a folder with a # in it is taken as it is", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const dir = mkdtempSync("/tmp/mxn-#{pane_id}-");
    try {
      await pane("shop");
      const id = await tmux.spawnWindow("shop", dir, "sleep 30");
      expect((await tmux.run(["display-message", "-p", "-t", id, "#{pane_current_path}"])).trim().endsWith(dir.split("/").pop()!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
