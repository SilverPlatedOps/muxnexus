import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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

describe("install-agent-hook.py, for chats", () => {
  const profile = () => {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
  };

  test("wires the chat hook for Claude: PreToolUse on Bash, run synchronously", () => {
    profile();
    install();
    const pre = read(join(home, ".claude", "settings.json")).hooks.PreToolUse;
    const chat = pre.find((e: { hooks: { command: string }[] }) => e.hooks[0]!.command.includes("chat-hook.sh"));
    expect(chat.matcher).toBe("Bash");
    expect(chat.hooks[0]).toEqual({ type: "command", command: expect.stringMatching(/chat-hook\.sh" claude$/) });
  });

  test("wires the chat hook for Codex", () => {
    mkdirSync(join(home, ".codex"));
    install();
    const pre = read(join(home, ".codex", "hooks.json")).hooks.PreToolUse;
    expect(pre.some((e: { hooks: { command: string }[] }) => /chat-hook\.sh" codex$/.test(e.hooks[0]!.command))).toBe(true);
  });

  test("a second run adds nothing to a Claude profile", () => {
    profile();
    install();
    const first = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    expect(install()).toContain("already wired");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(first);
  });

  test("links mux into ~/.local/bin", () => {
    profile();
    install();
    expect(readlinkSync(join(home, ".local", "bin", "mux"))).toMatch(/scripts\/mux\.ts$/);
  });

  test("adds the peer rule once, to Codex's AGENTS.md and the shared CLAUDE.md", () => {
    profile();
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".claude-shared"));
    writeFileSync(join(home, ".claude-shared", "CLAUDE.md"), "# mine\n");
    const out = install();
    install();
    for (const f of [join(home, ".codex", "AGENTS.md"), join(home, ".claude-shared", "CLAUDE.md")]) {
      const text = readFileSync(f, "utf8");
      expect(text.split("<!-- muxnexus peer rule -->").length - 1).toBe(1);
      expect(text).toContain("peer, not the user]");
    }
    expect(readFileSync(join(home, ".claude-shared", "CLAUDE.md"), "utf8")).toStartWith("# mine\n");
    expect(out).toContain("peer rule");
  });

  test("with no shared CLAUDE.md the rule goes in the profile's own", () => {
    profile();
    install();
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toContain("<!-- muxnexus peer rule -->");
  });
});
