import { describe, expect, test } from "bun:test";
import { boardMessage, boardQuota, MAX_BOARD_BYTES } from "../src/server/board";
import type { SessionInfo, SystemApp, UsageSource, WindowInfo } from "../src/shared/protocol";

const NOW = 1_794_884_825; // seconds
const iso = (s: number) => new Date(s * 1000).toISOString();
const GB = 1024 ** 3;

function win(id: string, index: number, agent?: WindowInfo["agent"]): WindowInfo {
  return { id, index, name: "claude", active: false, panes: 1, ...(agent ? { agent } : {}) };
}
function session(name: string, windows: WindowInfo[], extra: Partial<SessionInfo> = {}): SessionInfo {
  return { name, id: `$${name}`, attached: 0, windows, ...extra };
}

const usage: UsageSource[] = [
  {
    id: "/home/u/.claude", label: "personal", provider: "claude", state: "ok", checkedAt: "2026-11-10T04:33:45.570Z",
    windows: [
      { kind: "session", percent: 29, resetsAt: "2026-11-10T06:09:59.785881+00:00" },
      { kind: "weekly_all", percent: 13, resetsAt: "2026-11-13T23:59:59.785904+00:00" },
      { kind: "weekly_scoped", percent: 20, resetsAt: "2026-11-14T00:00:00+00:00" },
    ],
  },
  {
    id: "/home/u/.claude-work", label: "work", provider: "claude", state: "error", checkedAt: "2026-11-10T04:30:00.000Z",
    windows: [{ kind: "session", percent: 44 }, { kind: "weekly_all", percent: 8 }],
  },
  {
    id: "codex", label: "codex", provider: "codex", state: "ok", checkedAt: "2026-11-10T04:33:45.570Z",
    windows: [{ kind: "5h", percent: 5, resetsAt: "2026-11-10T08:19:28.000Z" }, { kind: "7d", percent: 35 }],
  },
];
const sec = (s: string) => Math.floor(Date.parse(s) / 1000);

describe("agents", () => {
  test("one row per agent window, asked first then the longest wait", () => {
    const m = JSON.parse(boardMessage({
      src: "warrior", now: NOW, usage: null, vitals: null, memory: null,
      sessions: [
        session("JKB", [
          win("@1", 0, { state: "running", since: iso(NOW - 30), profile: "work", checkout: "/home/u/jkb" }),
          win("@2", 1),
        ]),
        session("[ws] Mux", [win("@3", 0, { state: "input", since: iso(NOW - 900), waitingSince: iso(NOW - 120), profile: "personal" })]),
        session("Docs", [win("@4", 0, { state: "done", since: iso(NOW - 600), profile: "codex" })]),
      ],
    }));
    expect(m.v).toBe(1);
    expect(m.src).toBe("warrior");
    expect(m.t).toBe(NOW);
    expect(m.agents).toEqual([
      { n: "Mux", p: "personal", s: "asked", a: 120, d: "", i: "@3" },
      { n: "Docs", p: "codex", s: "finished", a: 600, d: "", i: "@4" },
      { n: "JKB", p: "work", s: "running", a: 30, d: "jkb", i: "@1" },
    ]);
  });

  test("two agents in one session are told apart by window index", () => {
    const m = JSON.parse(boardMessage({
      src: "m", now: NOW, usage: null, vitals: null, memory: null,
      sessions: [session("ESP", [
        win("@1", 0, { state: "running", since: iso(NOW - 5) }),
        win("@2", 3, { state: "running", since: iso(NOW - 9) }),
      ])],
    }));
    expect(m.agents.map((a: { n: string }) => a.n).sort()).toEqual(["ESP 0", "ESP 3"]);
    expect(m.agents.every((a: { p: string }) => a.p === "other")).toBe(true);
  });

  test("a window shown in several grouped sessions counts once", () => {
    const shared = win("@7", 0, { state: "done", since: iso(NOW - 60) });
    const m = JSON.parse(boardMessage({
      src: "m", now: NOW, usage: null, vitals: null, memory: null,
      sessions: [session("A", [shared]), session("A-2", [shared]), session("A-3", [shared])],
    }));
    expect(m.agents.length).toBe(1);
  });

  test("a stamp from the future reads as no wait, not a negative one", () => {
    const m = JSON.parse(boardMessage({
      src: "m", now: NOW, usage: null, vitals: null, memory: null,
      sessions: [session("A", [win("@1", 0, { state: "running", since: iso(NOW + 50) })])],
    }));
    expect(m.agents[0].a).toBe(0);
  });

  test("a long list drops running agents first to stay under the board's limit", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      session(`agent-with-a-rather-long-session-name-${i}`, [win(`@${i}`, 0, { state: i === 0 ? "input" : "running", since: iso(NOW - i) })]));
    const body = boardMessage({ src: "m", now: NOW, usage, vitals: null, memory: null, sessions: many });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BOARD_BYTES);
    expect(JSON.parse(body).agents[0].s).toBe("asked");
  });
});

describe("quota", () => {
  test("maps claude and codex windows, taking the fuller weekly window", () => {
    const q = boardQuota(usage);
    expect(q.map((s) => s.k)).toEqual(["personal", "work", "codex"]);
    expect(q[0]).toEqual({ k: "personal", w5: 29, r5: sec("2026-11-10T06:09:59.785Z"), w7: 20, r7: sec("2026-11-14T00:00:00Z"), c: sec("2026-11-10T04:33:45.570Z"), ok: true, p7: true });
    expect([q[1].w5, q[1].w7, q[1].ok, q[1].r5]).toEqual([44, 8, false, 0]);
    expect([q[2].w5, q[2].w7, q[2].p7]).toEqual([5, 35, undefined]);
  });

  test("a tie between the weekly windows is not 7d+", () => {
    const tie: UsageSource[] = [{ ...usage[0], windows: [{ kind: "weekly_scoped", percent: 12 }, { kind: "weekly_all", percent: 12 }] }];
    expect(boardQuota(tie)[0].p7).toBeUndefined();
  });

  test("leaves out other accounts and ones with no windows", () => {
    const other: UsageSource[] = [
      { ...usage[0], id: "/home/u/.claude-shared", label: "shared" },
      { ...usage[2], windows: [] },
    ];
    expect(boardQuota(other)).toEqual([]);
  });
});

describe("system", () => {
  const vitals = { at: 0, cpu: 34.4, load: [1.234, 0.9, 0.81] as [number, number, number], mem: { used: 11.24 * GB, total: 16 * GB, pressure: "warning" as const }, rate: 412_000, written: null, bootTime: null };
  const app = (name: string, cpu: number, mem: number): SystemApp => ({ name, cpu, mem, procs: 1, top: name });

  test("cpu, load, memory in GB, pressure and swap writes in MB/s", () => {
    const m = JSON.parse(boardMessage({ src: "m", now: NOW, sessions: [], usage: null, vitals, memory: null }));
    expect(m.sys).toEqual({ cpu: 34, load: [1.23, 0.9, 0.81], mem: [11.2, 16], pr: "warning", swap: 0.4 });
  });

  test("the busiest three apps, only from a fresh memory reading", () => {
    const apps = [app("Chrome", 18.4, 2.1 * GB), app("java", 9, 1.44 * GB), app("idle", 0, 5 * GB), app("bun", 3, 0.2 * GB)];
    const fresh = JSON.parse(boardMessage({ src: "m", now: NOW, sessions: [], usage: null, vitals, memory: { at: NOW * 1000 - 5000, apps } }));
    expect(fresh.sys.top).toEqual([["Chrome", 18, 2.1], ["java", 9, 1.4], ["bun", 3, 0.2]]);
    const stale = JSON.parse(boardMessage({ src: "m", now: NOW, sessions: [], usage: null, vitals, memory: { at: NOW * 1000 - 120_000, apps } }));
    expect(stale.sys.top).toBeUndefined();
  });

  test("no reading, no sys", () => {
    const m = JSON.parse(boardMessage({ src: "m", now: NOW, sessions: [], usage: null, vitals: null, memory: null }));
    expect(m.sys).toBeUndefined();
    expect(m.q).toBeUndefined();
  });
});
