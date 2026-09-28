import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "..", "scripts", "codex-tmux.zsh");
let bin = "";

// A stand-in `codex` that prints the arguments it was given, one per line.
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "mxn-codex-"));
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
  chmodSync(join(bin, "codex"), 0o755);
});
afterAll(() => { rmSync(bin, { recursive: true, force: true }); });

/** What the real `codex` would be run with, after the wrapper. */
function run(args: string, tmux: string | null): string[] {
  const env: Record<string, string> = { ...process.env, PATH: `${bin}:${process.env.PATH}` } as any;
  delete env.TMUX;
  if (tmux !== null) env.TMUX = tmux;
  const p = Bun.spawnSync(["zsh", "-fc", `source ${WRAPPER}; codex ${args}`], { env });
  return p.stdout.toString().split("\n").filter(Boolean);
}

describe("the codex wrapper", () => {
  test("inside tmux: no daemon, and inline so tmux keeps the conversation", () => {
    expect(run("'fix the bug'", "/tmp/tmux-1/default,1,0")).toEqual([
      "--no-daemon", "-c", 'tui.alternate_screen="never"', "fix the bug",
    ]);
  });

  test("outside tmux it is Codex as it was", () => {
    expect(run("'fix the bug'", null)).toEqual(["fix the bug"]);
  });

  test("never passes --no-daemon twice, which Codex refuses", () => {
    const args = run("--no-daemon resume", "x");
    expect(args.filter((a) => a === "--no-daemon")).toHaveLength(1);
    expect(args).toContain('tui.alternate_screen="never"');
  });

  test("leaves an alternate-screen choice made on the command line alone", () => {
    const args = run("--no-alt-screen", "x");
    expect(args).toContain("--no-daemon");
    expect(args).not.toContain('tui.alternate_screen="never"');
    const chosen = run("-c 'tui.alternate_screen=\"always\"'", "x");
    expect(chosen).toContain("--no-daemon");
    expect(chosen).not.toContain('tui.alternate_screen="never"');
  });
});
