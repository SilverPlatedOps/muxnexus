import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linksIn, readPage, readSince, searchFile } from "../src/server/conversation/reader";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "conv-reader-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const agent = (n: number, text = `message ${n}`) =>
  JSON.stringify({ type: "assistant", uuid: `r${n}`, timestamp: "2026-01-01T10:00:00.000Z", message: { content: [{ type: "text", text }] } }) + "\n";
const step = (n: number, output: string) =>
  JSON.stringify({ type: "assistant", uuid: `s${n}`, timestamp: "2026-01-01T10:00:00.000Z", message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: "ls" } }] } }) +
  "\n" +
  JSON.stringify({ type: "user", uuid: `sr${n}`, timestamp: "2026-01-01T10:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: output }] } }) +
  "\n";

function file(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

test("the last page is the newest items, and before= pages back with no gap or overlap", async () => {
  const p = file("pages.jsonl", Array.from({ length: 200 }, (_, i) => agent(i)).join(""));
  const size = Bun.file(p).size;
  const last = await readPage("claude", p, { limit: 60 });
  expect(last.end).toBe(size);
  expect(last.items.map((i) => i.id)).toEqual(Array.from({ length: 60 }, (_, i) => `r${140 + i}`));
  const prev = await readPage("claude", p, { before: last.start });
  expect(prev.end).toBe(last.start);
  expect(prev.items.map((i) => i.id)).toEqual(Array.from({ length: 60 }, (_, i) => `r${80 + i}`));
  const prev2 = await readPage("claude", p, { before: prev.start, limit: 500 });
  expect(prev2.start).toBe(0);
  expect(prev2.items.map((i) => i.id)).toEqual(Array.from({ length: 80 }, (_, i) => `r${i}`));
});

test("around= returns a page holding the row at that offset", async () => {
  const p = file("around.jsonl", Array.from({ length: 100 }, (_, i) => agent(i)).join(""));
  const one = agent(0).length;
  const page = await readPage("claude", p, { around: one * 50 + 5, limit: 20 });
  const ids = page.items.map((i) => i.id);
  expect(ids).toContain("r50");
  expect(ids.length).toBe(20);
  const text = await Bun.file(p).text();
  expect(page.start === 0 || text[page.start - 1] === "\n").toBe(true);
  expect(text[page.end - 1]).toBe("\n");
});

test("an around page holding a result holds its call too, however far back the call is", async () => {
  // A long-running call (a subagent, a slow build): its result comes 40 rows after it, with the agent talking in between.
  const call = JSON.stringify({ type: "assistant", uuid: "c1", timestamp: "2026-01-01T10:00:00.000Z", message: { content: [{ type: "tool_use", id: "t_far", name: "Bash", input: { command: "make all" } }] } }) + "\n";
  const result = JSON.stringify({ type: "user", uuid: "c2", timestamp: "2026-01-01T10:09:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t_far", content: "build done: needle here" }] } }) + "\n";
  const rows = [agent(0), call, ...Array.from({ length: 40 }, (_, i) => agent(i + 1)), result, ...Array.from({ length: 10 }, (_, i) => agent(i + 50))];
  const p = file("far-call.jsonl", rows.join(""));
  const at = rows.slice(0, 42).join("").length;
  const page = await readPage("claude", p, { around: at, limit: 10 });
  const ids = page.items.map((i) => `${i.kind}:${i.id}`);
  // The result shows as the step it completes, where the result is: every row above it is older than the result,
  // every row below newer, and a page read before the page's start later goes above it in order. The page still
  // starts where it did.
  expect(ids).toEqual([...[36, 37, 38, 39, 40].map((n) => `agent:r${n}`), "step:t_far", ...[50, 51, 52, 53].map((n) => `agent:r${n}`)]);
  expect(page.items[5]).toMatchObject({ kind: "step", summary: "Ran make all", input: expect.stringContaining("make all"), result: { ok: true, output: "build done: needle here", at: "2026-01-01T10:09:00.000Z" } });
  const text = await Bun.file(p).text();
  expect(page.start).toBeGreaterThan(text.indexOf(call) + call.length);
  // The search finds the result row; the hit names the step it completes.
  expect((await searchFile("claude", p, "needle")).hits).toEqual([expect.objectContaining({ id: "t_far", offset: at })]);
});

test("a result whose call is too far back to find shows as a step of its own, not dropped", async () => {
  // More than the 8 MiB the page looks back for a call: the agent wrote this much while the call ran.
  const call = JSON.stringify({ type: "assistant", uuid: "c1", timestamp: "2026-01-01T10:00:00.000Z", message: { content: [{ type: "tool_use", id: "t_gone", name: "Bash", input: { command: "make all" } }] } }) + "\n";
  const result = JSON.stringify({ type: "user", uuid: "c2", timestamp: "2026-01-01T11:00:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t_gone", content: "build done: needle here" }] } }) + "\n";
  const pad = "x".repeat(1000);
  const filler = Array.from({ length: Math.ceil((9 * 1024 * 1024) / agent(0, pad).length) }, (_, i) => agent(i + 1, pad));
  const p = file("gone-call.jsonl", [call, ...filler, result, agent(99999)].join(""));
  const at = Bun.file(p).size - result.length - agent(99999).length;
  const page = await readPage("claude", p, { around: at, limit: 10 });
  const found = page.items.find((i) => i.id === "t_gone");
  expect(found).toMatchObject({ kind: "step", result: { ok: true, output: "build done: needle here", at: "2026-01-01T11:00:00.000Z" } });
  expect(page.items.some((i) => i.kind === "step-result")).toBe(false);
  // It says what it is: the output of a step from earlier on.
  expect(found).toMatchObject({ summary: "Output of an earlier step" });
});

test("a 20 MB transcript's last page reads less than 1 MB", async () => {
  const pad = "x".repeat(1000);
  const row = agent(0, pad);
  const rows = Math.ceil((20 * 1024 * 1024) / row.length);
  const p = file("big.jsonl", Array.from({ length: rows }, (_, i) => agent(i, pad)).join(""));
  expect(Bun.file(p).size).toBeGreaterThan(20 * 1024 * 1024);
  const page = await readPage("claude", p, { limit: 60 });
  expect(page.items.length).toBe(60);
  expect(page.bytesRead).toBeLessThan(1024 * 1024);
});

test("a line still being written is left for the next read", async () => {
  const p = file("live.jsonl", agent(1) + agent(2));
  const first = await readSince("claude", p, 0);
  expect(first.items.map((i) => i.id)).toEqual(["r1", "r2"]);
  const line = agent(3);
  appendFileSync(p, line.slice(0, 40));
  const mid = await readSince("claude", p, first.end);
  expect(mid.items).toEqual([]);
  expect(mid.end).toBe(first.end);
  const tail = await readPage("claude", p, { limit: 60 });
  expect(tail.items.map((i) => i.id)).toEqual(["r1", "r2"]);
  expect(tail.end).toBe(first.end);
  appendFileSync(p, line.slice(40));
  const done = await readSince("claude", p, mid.end);
  expect(done.items.map((i) => i.id)).toEqual(["r3"]);
  expect(done.end).toBe(Bun.file(p).size);
});

test("a file shorter than from was replaced: read from 0", async () => {
  const p = file("replaced.jsonl", agent(7));
  const page = await readSince("claude", p, 100000);
  expect(page.start).toBe(0);
  expect(page.items.map((i) => i.id)).toEqual(["r7"]);
});

test("search finds text in agent prose and in folded step output, newest first, with a cursor", async () => {
  const p = file(
    "search.jsonl",
    agent(1, "the Needle is here") + step(2, "output with needle inside") + agent(3, "nothing") + agent(4, "another NEEDLE") + agent(5, 'quote "needle" ok'),
  );
  const all = await searchFile("claude", p, "needle");
  expect(all.hits.map((h) => h.id)).toEqual(["r5", "r4", "t2", "r1"]);
  expect(all.hits[0].offset).toBeGreaterThan(all.hits[1].offset);
  expect(all.hits[2].snippet).toContain("needle inside");
  expect(all.next).toBeUndefined();
  const a = await searchFile("claude", p, "needle", { max: 2 });
  expect(a.hits.map((h) => h.id)).toEqual(["r5", "r4"]);
  expect(a.next).toBeDefined();
  const b = await searchFile("claude", p, "needle", { max: 2, cursor: a.next });
  expect(b.hits.map((h) => h.id)).toEqual(["t2", "r1"]);
  expect(b.next).toBeUndefined();
});

test("links: every URL once, PR links first", async () => {
  const p = file(
    "links.jsonl",
    agent(1, "see https://example.com.") + agent(2, "again https://example.com and https://github.com/o/r/pull/12") + step(3, "log https://example.com") ,
  );
  expect(await linksIn("claude", p)).toEqual([
    { url: "https://github.com/o/r/pull/12", pr: true },
    { url: "https://example.com", pr: false },
  ]);
});
