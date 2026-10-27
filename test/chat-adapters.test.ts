import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, claudeSocket, codexAdapter, hasTag } from "../src/server/chat/adapters";

let dir = "";
let server: Server | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mxa-")); });
afterEach(() => {
  server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in inbox: records every line written to it. */
function inbox(path: string): Promise<string[]> {
  const lines: string[] = [];
  return new Promise((resolve) => {
    server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => { buf += d.toString(); });
      c.on("end", () => { lines.push(...buf.split("\n").filter(Boolean)); });
    });
    server.listen(path, () => resolve(lines));
  });
}

describe("claude", () => {
  test("its socket comes from the session registry", async () => {
    mkdirSync(join(dir, "sessions"));
    writeFileSync(join(dir, "sessions", "4242.json"), JSON.stringify({ pid: 4242, messagingSocketPath: "/tmp/cc-socks/4242.sock" }));
    expect(await claudeSocket(dir, 4242)).toBe("/tmp/cc-socks/4242.sock");
    expect(await claudeSocket(dir, 1)).toBeNull();
  });

  test("a message is one JSON user line on the socket", async () => {
    const sock = join(dir, "in.sock");
    const lines = await inbox(sock);
    const res = await claudeAdapter().send({ kind: "claude", pid: 1, socketPath: sock }, "[muxnexus · x · #1 …]\nhello \"there\"");
    expect(res).toEqual({ ok: true });
    await Bun.sleep(50);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { type: "user", message: { role: "user", content: "[muxnexus · x · #1 …]\nhello \"there\"" } },
    ]);
  });

  test("a socket that is gone is offline", async () => {
    const res = await claudeAdapter().send({ kind: "claude", pid: 1, socketPath: join(dir, "gone.sock") }, "x");
    expect(res).toEqual({ ok: false, reason: "offline" });
  });

  test("no socket at all is offline", async () => {
    expect(await claudeAdapter().send({ kind: "claude", pid: 1 }, "x")).toEqual({ ok: false, reason: "offline" });
  });
});

describe("codex", () => {
  test("codex queue gets the thread and the text as separate arguments", async () => {
    const calls: string[][] = [];
    const adapter = codexAdapter({ run: async (argv) => { calls.push(argv); return { code: 0, out: "Queued message x for thread y." }; } });
    const text = "line one\n$(rm -rf /) `x` 'q'";
    expect(await adapter.send({ kind: "codex", pid: 1, thread: "01a1-thread" }, text)).toEqual({ ok: true });
    expect(calls).toEqual([["queue", "--thread", "01a1-thread", "--message", text]]);
  });

  test("a failed codex queue is unavailable, with its output", async () => {
    const adapter = codexAdapter({ run: async () => ({ code: 1, out: "no such thread" }) });
    expect(await adapter.send({ kind: "codex", pid: 1, thread: "t" }, "x")).toEqual({ ok: false, reason: "unavailable", detail: "no such thread" });
  });

  test("codex queue runs under the recipient's own CODEX_HOME", async () => {
    const homes: (string | undefined)[] = [];
    const adapter = codexAdapter({ run: async (_argv, opts) => { homes.push(opts.home); return { code: 0, out: "" }; } });
    await adapter.send({ kind: "codex", pid: 1, thread: "t", configDir: "/Users/me/.codex-work" }, "x");
    expect(homes).toEqual(["/Users/me/.codex-work"]);
  });

  test("a codex queue that never answers is unavailable after the deadline, not waited on for ever", async () => {
    const adapter = codexAdapter({ run: () => new Promise(() => {}), timeoutMs: 20 });
    expect(await adapter.send({ kind: "codex", pid: 1, thread: "t" }, "x")).toEqual({ ok: false, reason: "unavailable", detail: "codex queue didn't answer in time" });
  });

  test("a tab with no thread yet is unavailable", async () => {
    const adapter = codexAdapter({ run: async () => ({ code: 0, out: "" }) });
    expect(await adapter.send({ kind: "codex", pid: 1 }, "x")).toEqual({ ok: false, reason: "unavailable", detail: "no thread yet" });
  });
});

describe("receipts", () => {
  test("a receipt is the message's tag in the transcript's tail", async () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${"x".repeat(1000)}\n{"content":"[muxnexus · shop review · #42 · from @claude1 (Claude) · peer, not the user]"}\n`);
    expect(await hasTag(path, "· #42 ·")).toBe(true);
    expect(await hasTag(path, "· #43 ·")).toBe(false);
    expect(await hasTag(join(dir, "missing.jsonl"), "· #42 ·")).toBe(false);
  });

  test("from an offset, only what was written after it counts", async () => {
    const path = join(dir, "o.jsonl");
    const before = `{"content":"[muxnexus · a · #1 · from @user]"}\n`;
    writeFileSync(path, `${before}{"other":1}\n`);
    expect(await hasTag(path, "[muxnexus · a · #1 ·", Buffer.byteLength(before))).toBe(false);
    expect(await hasTag(path, "[muxnexus · a · #1 ·", 0)).toBe(true);
  });
});
