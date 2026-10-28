import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
test("pane-local stdio MCP reaches the loopback gateway for both agent families", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mxn-mcp-tmux-"));
  const socket = `mxn-mcp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const output = join(dir, "result.json");
  try {
    const launch = Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", "tools", [process.execPath, join(import.meta.dir, "fixtures/chat-tools-runtime.ts"), output].map(quote).join(" ")]);
    if (launch.exitCode !== 0) throw new Error(launch.stderr.toString());
    for (let i = 0; i < 120 && !(await Bun.file(output).exists()); i++) await Bun.sleep(50);
    const r = await Bun.file(output).json();
    expect(r.ok).toBe(true);
    expect(r.seen).toHaveLength(2);
    expect(r.seen.map((b: { agent: string }) => b.agent)).toEqual(["claude", "codex"]);
    for (const body of r.seen) {
      expect(body.pane).toBe(r.pane);
      expect(body.literalText).toBe(true);
      expect(body.argv).toEqual(["--chat", "fixture-only", "say", "--", 'literal "\\n"\nsecond line']);
    }
  } finally {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
