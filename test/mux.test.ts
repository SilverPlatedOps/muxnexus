import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookOutput, muxArgv, runHook, tokenize } from "../scripts/mux";

const MUX = join(import.meta.dir, "..", "scripts", "mux.ts");

describe("tokenize", () => {
  test("single quotes keep quotes, $, backticks and newlines verbatim", () => {
    expect(tokenize(`mux say 'a "b" $HOME \`x\`\nnext'`)).toEqual(["mux", "say", `a "b" $HOME \`x\`\nnext`]);
  });

  test("double quotes take \\\" and \\\\ and keep $ and backticks literal", () => {
    expect(tokenize(`mux say "say \\"hi\\" \\\\ $HOME \`x\` it's"`)).toEqual(["mux", "say", `say "hi" \\ $HOME \`x\` it's`]);
  });

  test("an unquoted backslash escapes the next character", () => {
    expect(tokenize(`mux say it\\'s\\ fine`)).toEqual(["mux", "say", "it's fine"]);
  });

  test("an operator outside quotes refuses the line", () => {
    for (const cmd of [`mux say hi && rm x`, `mux say hi; ls`, `echo $(mux say hi)`, `mux say hi | cat`, `mux say hi > f`, "mux say `id`", "mux say hi\nls"]) {
      expect(tokenize(cmd)).toBeNull();
    }
  });

  test("an unclosed quote refuses the line", () => {
    expect(tokenize(`mux say "open`)).toBeNull();
  });

  test("a comment or a $'…' string refuses the line: sh would read them differently", () => {
    for (const cmd of [`mux say fixed #12`, `mux say hi # note`, `mux say $'a\\nb'`, `mux say $"x"`]) {
      expect(tokenize(cmd)).toBeNull();
    }
    expect(tokenize(`mux say "fixed #12" a#b`)).toEqual(["mux", "say", "fixed #12", "a#b"]);
  });
});

describe("muxArgv", () => {
  test("accepts mux, a path to mux or mux.ts, and nothing else", () => {
    expect(muxArgv(`mux say hi`)).toEqual(["say", "hi"]);
    expect(muxArgv(`./scripts/mux.ts who`)).toEqual(["who"]);
    expect(muxArgv(`~/.local/bin/mux read 5`)).toEqual(["read", "5"]);
    expect(muxArgv(`muxer say hi`)).toBeNull();
    expect(muxArgv(`echo mux say hi`)).toBeNull();
    expect(muxArgv(`mux say hi && rm -rf x`)).toBeNull();
  });

  test("a text that starts with a dash is kept", () => {
    expect(muxArgv(`mux say -- "-x marks it"`)).toEqual(["say", "--", "-x marks it"]);
  });

  test("a heredoc gives its body as the text, untouched", () => {
    expect(muxArgv(`mux say <<'EOF'\nline 1 with $HOME and "quotes"\nline 2\nEOF`)).toEqual(["say", `line 1 with $HOME and "quotes"\nline 2`]);
  });

  test("a heredoc ends at its first delimiter line: anything after it refuses the line", () => {
    expect(muxArgv("mux say <<EOF\nhi\nEOF\nrm -rf x\nEOF")).toBeNull();
    expect(muxArgv(`mux say "$(cat <<'EOF'\nhi\nEOF\nrm -rf x\nEOF\n)"`)).toBeNull();
    expect(muxArgv("mux say x #<<EOF\nrm -rf y\nEOF")).toBeNull();
    // <<- ends at a tab-indented delimiter too.
    expect(muxArgv("mux say <<-EOF\nhi\n\tEOF\nrm -rf x\nEOF")).toBeNull();
    expect(muxArgv(`mux say "$(cat <<-'EOF'\nhi\n\tEOF\nrm -rf x\nEOF\n)"`)).toBeNull();
  });

  test("the $(cat <<'EOF' …) idiom inside double quotes gives its body", () => {
    expect(muxArgv(`mux say "$(cat <<'EOF'\n@codex1 please review\n- a\nEOF\n)"`)).toEqual(["say", "@codex1 please review\n- a"]);
  });
});

describe("hook", () => {
  test("its output is a PreToolUse allow that replaces the command", () => {
    expect(JSON.parse(hookOutput("cat '/tmp/x'"))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "cat '/tmp/x'" } },
    });
  });

  test("a command that is not mux is left alone", async () => {
    const out = await runHook("claude", { tool_input: { command: "ls -la" } }, { TMUX_PANE: "%3" }, async () => ({ ok: true, output: "x" }));
    expect(out).toBeNull();
  });

  test("a mux call is posted with its pane and session, and rewritten to print the reply", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mxh-"));
    const posted: object[] = [];
    const out = await runHook(
      "codex",
      { tool_input: { command: `mux say "@claude1 done"` }, session_id: "s-1", cwd: "/w" },
      { TMUX_PANE: "%3", TMPDIR: tmp },
      async (body) => { posted.push(body); return { ok: true, output: "posted as #4" }; },
    );
    expect(posted).toEqual([{ agent: "codex", pane: "%3", sessionId: "s-1", cwd: "/w", argv: ["say", "@claude1 done"] }]);
    const command = JSON.parse(out!).hookSpecificOutput.updatedInput.command as string;
    const file = /^cat '([^']+)'/.exec(command)![1]!;
    expect(readFileSync(file, "utf8")).toBe("posted as #4\n");
    const run = Bun.spawnSync(["sh", "-c", command]);
    expect(run.stdout.toString()).toBe("posted as #4\n");
    expect(run.exitCode).toBe(0);
    expect(existsSync(file)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a refused call exits 1 with the reason", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mxh-"));
    const out = await runHook("claude", { tool_input: { command: "mux say hi" } }, { TMUX_PANE: "%3", TMPDIR: tmp }, async () => ({ ok: false, output: "NOT POSTED: this tab is not in a chat" }));
    const run = Bun.spawnSync(["sh", "-c", JSON.parse(out!).hookSpecificOutput.updatedInput.command]);
    expect(run.stdout.toString()).toBe("NOT POSTED: this tab is not in a chat\n");
    expect(run.exitCode).toBe(1);
    // A shell an agent keeps alive between commands must survive a refusal.
    expect(JSON.parse(out!).hookSpecificOutput.updatedInput.command).not.toContain("exit");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a server that does not answer is reported, not swallowed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mxh-"));
    const out = await runHook("claude", { tool_input: { command: "mux say hi" } }, { TMUX_PANE: "%3", TMPDIR: tmp }, async () => { throw new Error("ECONNREFUSED"); });
    const run = Bun.spawnSync(["sh", "-c", JSON.parse(out!).hookSpecificOutput.updatedInput.command]);
    expect(run.stdout.toString()).toStartWith("NOT POSTED: the muxnexus server didn't answer");
    expect(run.exitCode).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("chat-hook.sh", () => {
  const HOOK = join(import.meta.dir, "..", "scripts", "chat-hook.sh");
  const run = (payload: object, env: Record<string, string>) =>
    Bun.spawnSync(["sh", HOOK, "claude"], { stdin: new Blob([JSON.stringify(payload)]), env: { ...process.env, ...env } });

  test("a command that is not mux costs one case and prints nothing", () => {
    const r = run({ tool_input: { command: "ls -la" } }, { TMUX_PANE: "%1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });

  test("outside tmux it does nothing", () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.TMUX_PANE;
    const r = Bun.spawnSync(["sh", HOOK, "claude"], { stdin: new Blob([JSON.stringify({ tool_input: { command: "mux say hi" } })]), env });
    expect(r.stdout.toString()).toBe("");
  });

  test("a mux call with no server answering is rewritten to say so", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mxh-"));
    const r = run({ tool_input: { command: "mux say hi" } }, { TMUX_PANE: "%1", MUXNEXUS_PORT: "1", TMPDIR: tmp });
    const command = JSON.parse(r.stdout.toString()).hookSpecificOutput.updatedInput.command;
    const said = Bun.spawnSync(["sh", "-c", command]);
    expect(said.stdout.toString()).toStartWith("NOT POSTED: the muxnexus server didn't answer");
    expect(said.exitCode).toBe(1);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("standalone", () => {
  test("mux run without the hook prints NOT POSTED and exits 1", () => {
    const run = Bun.spawnSync(["bun", MUX, "say", "hi"]);
    expect(run.stdout.toString()).toStartWith("NOT POSTED: the muxnexus hook didn't catch this call");
    // The usual cause is a line the hook won't touch: say so before blaming the install.
    expect(run.stdout.toString()).toContain("as a command of its own");
    expect(run.exitCode).toBe(1);
  });
});
