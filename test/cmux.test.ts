import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCmuxMirror, type CmuxMirror } from "../src/server/cmux";

/**
 * A fake `cmux` CLI: appends every argv to a log file, and answers
 * `workspace list --json` with one workspace titled "mirrored" (ref workspace:9).
 * The real CLI would open workspaces in the user's GUI on every test run.
 */
let dir: string;
let log: string;
let mirror: CmuxMirror;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmux-viewer-fake-cmux-"));
  log = join(dir, "calls.log");
  const bin = join(dir, "cmux");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$1" = "workspace" ] && [ "$2" = "list" ]; then
  printf '%s' '{"window_ref":"window:1","workspaces":[{"custom_title":"mirrored","ref":"workspace:9","id":"X"},{"custom_title":"other","ref":"workspace:2","id":"Y"}]}'
fi
exit 0
`);
  chmodSync(bin, 0o755);
  mirror = createCmuxMirror({ cmuxBin: bin, socketPath: "/tmp/fake.sock", cwd: "/Users/me" });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = () => readFileSync(log, "utf8").trim().split("\n");

test("sessionCreated opens an unfocused workspace that attaches to the session", async () => {
  await mirror.sessionCreated("work");
  expect(calls()).toEqual([
    "workspace create --name work --cwd /Users/me --env VIEWER_TMUX_SESSION=work --focus false",
  ]);
});

test("sessionKilled closes the workspace whose title matches, and nothing otherwise", async () => {
  await mirror.sessionKilled("mirrored");
  expect(calls()).toEqual(["workspace list --json", "workspace close workspace:9"]);
  await mirror.sessionKilled("unknown");
  expect(calls()).toEqual(["workspace list --json", "workspace close workspace:9", "workspace list --json"]);
});

test("sessionKilled with a stamped workspace closes that workspace, whatever its title", async () => {
  await mirror.sessionKilled("mirrored", "Y");
  expect(calls()).toEqual(["workspace list --json", "workspace close workspace:2"]);
});

test("sessionKilled with a stamp that matches no workspace closes nothing, even on a title match", async () => {
  // The stamp says which workspace owned the session; that one is gone. A
  // workspace that merely shares the title is someone else's.
  await mirror.sessionKilled("mirrored", "Z");
  expect(calls()).toEqual(["workspace list --json"]);
});

test("sessionRenamed retitles the matching workspace", async () => {
  await mirror.sessionRenamed("mirrored", "renamed");
  expect(calls()).toEqual(["workspace list --json", "workspace rename workspace:9 --title renamed"]);
});

test("a failing cmux command rejects with its stderr", async () => {
  const bad = join(dir, "cmux-bad");
  writeFileSync(bad, `#!/bin/sh\necho "socket unavailable" >&2\nexit 1\n`);
  chmodSync(bad, 0o755);
  const m = createCmuxMirror({ cmuxBin: bad, socketPath: "/tmp/fake.sock" });
  await expect(m.sessionCreated("x")).rejects.toThrow(/socket unavailable/);
});
