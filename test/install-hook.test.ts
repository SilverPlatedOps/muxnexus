import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "install-agent-hook.py");

let home = "";
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mxn-install-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Run the installer with discovery pointed at the scratch home. */
function install(): string {
  const p = Bun.spawnSync(["python3", SCRIPT], { env: { ...process.env, HOME: home } });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("install-agent-hook.py, for Codex", () => {
  test("adds the codex-flavoured hook to every event Codex has, keeping what was there", () => {
    mkdirSync(join(home, ".codex"));
    const other = { hooks: [{ type: "command", command: "/elsewhere/notify.sh" }] };
    writeFileSync(join(home, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [other] } }));

    install();
    const hooks = read(join(home, ".codex", "hooks.json")).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      "Notification", "PermissionRequest", "PostToolUse", "PreToolUse",
      "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
    expect(hooks.Stop[0]).toEqual(other);
    expect(hooks.Stop[1].hooks[0].command).toMatch(/agent-state\.sh" Stop codex$/);
    expect(readdirSync(join(home, ".codex")).some((f) => f.startsWith("hooks.json.bak."))).toBe(true);
  });

  test("creates hooks.json when Codex has none, and a second run changes nothing", () => {
    mkdirSync(join(home, ".codex"));
    install();
    const first = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
    expect(install()).toContain("already wired");
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe(first);
  });

  test("no Codex home, nothing written for it", () => {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    install();
    expect(readdirSync(home)).not.toContain(".codex");
  });
});
