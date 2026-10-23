import { afterEach, describe, expect, test } from "bun:test";
import type { RatePoint, ServerMessage } from "../src/shared/protocol";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { INITIAL_LEVEL, type LevelState } from "../src/server/levels";
import type { MemoryReading } from "../src/server/memory";
import type { Vitals, VitalsSampler } from "../src/server/vitals";
import { waitFor } from "./helpers";

const SOCKET = "cmux-viewer-test-swap";
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function fakeVitals() {
  const listeners = new Set<() => void>();
  const f = {
    fast: [] as boolean[], started: 0, stopped: 0,
    latest: {
      at: 1, load: [1, 2, 3], rate: 22 * MiB, written: 0.9e12, bootTime: 1_000,
      mem: { used: 12 * GiB, total: 16 * GiB, pressure: "normal" },
      split: { apps: 6 * GiB, system: 2 * GiB, compressed: 4 * GiB, available: 4 * GiB, total: 16 * GiB },
      swap: { used: 3 * GiB, total: 4 * GiB },
    } as Vitals,
    history: [{ at: 1, rate: 22 * MiB }] as RatePoint[],
    level: { ...INITIAL_LEVEL } as LevelState,
  };
  const fire = () => { for (const cb of [...listeners]) cb(); };
  const sampler: VitalsSampler = {
    start: () => { f.started++; },
    stop: () => { f.stopped++; },
    setFast: (on) => { f.fast.push(on); },
    sampleNow: async () => {},
    latest: () => f.latest,
    history: () => f.history,
    level: () => f.level,
    acknowledge: (episode) => {
      if (episode !== f.level.episode || f.level.acked) return false;
      f.level = { ...f.level, acked: true };
      fire();
      return true;
    },
    onSample: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return { f, sampler, fire, set: (l: Partial<LevelState>) => { f.level = { ...f.level, ...l }; } };
}

function fakeMemory(delayMs = 0) {
  const m = { reads: 0, inFlight: 0, maxInFlight: 0 };
  const reading: MemoryReading = {
    at: 1, metric: "footprint", appsCpu: 10,
    apps: [
      { name: "IntelliJ IDEA", cpu: 0.4, mem: 3.2 * GiB, procs: 3, top: "idea" },
      { name: "Docker VM · Rancher", cpu: 0.3, mem: 3.0 * GiB, procs: 1, top: "vm" },
      { name: "Helium", cpu: 1.2, mem: 2.2 * GiB, procs: 20, top: "Helium" },
      { name: "WindowServer", cpu: 4, mem: 0, procs: 1, top: "WindowServer", unreadable: true },
    ],
    windows: [
      { windowId: "@1", bytes: 1.5 * GiB, processes: 3, unreadable: 0, cpu: 2, parts: [] },
      { windowId: "@2", bytes: 0.4 * GiB, processes: 2, unreadable: 0, cpu: 0, parts: [] },
    ],
  };
  const factory = () => ({
    read: async () => {
      m.reads++;
      m.inFlight++;
      m.maxInFlight = Math.max(m.maxInFlight, m.inFlight);
      if (delayMs) await Bun.sleep(delayMs);
      m.inFlight--;
      return reading;
    },
  });
  return { m, factory };
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
  const got: ServerMessage[] = [];
  ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
  const of = <T extends ServerMessage["t"]>(t: T) => got.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  return { ws, got, of, send: (m: object) => ws.send(JSON.stringify(m)) };
}

let srv: RunningServer | null = null;
afterEach(async () => {
  srv?.stop();
  srv = null;
  await new Tmux(SOCKET).killServer();
});

function serve(v: ReturnType<typeof fakeVitals>, mem = fakeMemory(), extra: object = {}) {
  srv = createServer({
    hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000,
    vitals: v.sampler, memory: mem.factory, systemMs: 1, memoryMs: 1, urgentMemoryMs: 200, ...extra,
  });
  return srv;
}

describe("the swap notice", () => {
  test("goes to every client as it connects", async () => {
    const v = fakeVitals();
    const s = serve(v);
    const a = await connect(s.port);
    await waitFor(() => a.of("swap").length > 0, 2000, "notice on connect");
    expect(a.of("swap")[0].notice).toMatchObject({ severity: "calm", rate: 22 * MiB, swapUsed: 3 * GiB, written: 0.9e12, bootTime: 1_000 });
  });

  test("is pushed on every sample while not calm, and only on a change while calm", async () => {
    const v = fakeVitals();
    const s = serve(v);
    const a = await connect(s.port);
    const b = await connect(s.port);
    await waitFor(() => a.of("swap").length > 0 && b.of("swap").length > 0);
    const base = a.of("swap").length;
    v.fire();
    v.fire();
    await Bun.sleep(50);
    expect(a.of("swap").length).toBe(base);
    v.set({ severity: "busy", reason: "writes", episode: 77 });
    v.fire();
    v.fire();
    await waitFor(() => a.of("swap").length === base + 2 && b.of("swap").length === base + 2, 2000, "two pushes while busy");
    expect(b.of("swap").at(-1)!.notice).toMatchObject({ severity: "busy", reason: "writes", episode: 77, acked: false });
  });

  test("Got it for the current episode is broadcast; for an old one, nothing happens", async () => {
    const v = fakeVitals();
    v.set({ severity: "urgent", reason: "writes", episode: 9 });
    const s = serve(v);
    const a = await connect(s.port);
    const b = await connect(s.port);
    await waitFor(() => b.of("swap").length > 0);
    const before = b.of("swap").length;
    a.send({ t: "swap-ack", episode: 8 });
    await Bun.sleep(60);
    expect(b.of("swap").length).toBe(before);
    a.send({ t: "swap-ack", episode: 9 });
    await waitFor(() => b.of("swap").at(-1)!.notice.acked, 2000, "acknowledged everywhere");
  });

  test("while urgent, memory is read at most every urgentMemoryMs and the biggest four are named", async () => {
    const v = fakeVitals();
    const mem = fakeMemory();
    const s = serve(v, mem);
    const a = await connect(s.port);
    v.set({ severity: "urgent", reason: "writes", episode: 3 });
    for (let i = 0; i < 5; i++) v.fire();
    await waitFor(() => a.of("swap").some((m) => m.notice.holders.length > 0), 2000, "holders named");
    expect(mem.m.reads).toBe(1);
    expect(a.of("swap").at(-1)!.notice.holders).toEqual([
      { kind: "app", name: "IntelliJ IDEA", bytes: 3.2 * GiB },
      { kind: "app", name: "Docker VM · Rancher", bytes: 3.0 * GiB },
      { kind: "app", name: "Helium", bytes: 2.2 * GiB },
      { kind: "tab", name: "@1", bytes: 1.5 * GiB },
    ]);
  });
});

describe("the system message", () => {
  test("an old client's bare subscription gets load, apps and the split, and memory is read for it", async () => {
    const v = fakeVitals();
    const mem = fakeMemory();
    const s = serve(v, mem);
    const a = await connect(s.port);
    a.send({ t: "system", on: true });
    await waitFor(() => a.of("system").some((m) => m.stats.apps.length > 0), 2000, "apps for a bare subscription");
    const stats = a.of("system").at(-1)!.stats;
    expect(stats.load).toEqual([1, 2, 3]);
    expect(Array.isArray(stats.apps)).toBe(true);
    expect(stats.split).toEqual(v.f.latest.split);
    expect(stats.history).toEqual(v.f.history);
    expect(mem.m.reads).toBeGreaterThan(0);
  });

  test("with the list hidden, apps are empty and nothing costly is read", async () => {
    const v = fakeVitals();
    const mem = fakeMemory();
    const s = serve(v, mem);
    const a = await connect(s.port);
    a.send({ t: "system", on: true, list: false });
    await waitFor(() => a.of("system").length > 0, 2000, "system without the list");
    v.fire();
    await Bun.sleep(60);
    expect(a.of("system").at(-1)!.stats.apps).toEqual([]);
    expect(mem.m.reads).toBe(0);
  });

  test("the sampler runs fast while anyone has the overview open", async () => {
    const v = fakeVitals();
    const s = serve(v);
    const a = await connect(s.port);
    a.send({ t: "system", on: true, list: false });
    await waitFor(() => v.f.fast.at(-1) === true, 2000, "fast on");
    a.ws.close();
    await waitFor(() => v.f.fast.at(-1) === false, 2000, "fast off when the last leaves");
  });
});

describe("the memory message", () => {
  test("goes to subscribers with tmux's identity, and stops when they leave", async () => {
    await new Tmux(SOCKET).newSession("t");
    const v = fakeVitals();
    const mem = fakeMemory();
    const s = serve(v, mem);
    const a = await connect(s.port);
    await waitFor(() => a.of("state").some((m) => m.tmuxServer), 3000, "state with a tmux identity");
    const tmuxServer = a.of("state").find((m) => m.tmuxServer)!.tmuxServer;
    a.send({ t: "memory", on: true });
    await waitFor(() => a.of("memory").length > 0, 2000, "memory pushed");
    expect(a.of("memory")[0]).toMatchObject({ tmuxServer, metric: "footprint" });
    expect(a.of("memory")[0].windows.map((w) => w.windowId)).toEqual(["@1", "@2"]);
    a.send({ t: "memory", on: false });
    await Bun.sleep(30);
    const reads = mem.m.reads;
    v.fire();
    v.fire();
    await Bun.sleep(60);
    expect(mem.m.reads).toBe(reads);
  });

  test("overlapping demand never reads twice at once", async () => {
    const v = fakeVitals();
    const mem = fakeMemory(80);
    const s = serve(v, mem);
    const a = await connect(s.port);
    a.send({ t: "system", on: true });
    a.send({ t: "memory", on: true });
    v.set({ severity: "urgent", reason: "writes", episode: 5 });
    for (let i = 0; i < 6; i++) { v.fire(); await Bun.sleep(10); }
    await Bun.sleep(200);
    expect(mem.m.reads).toBeGreaterThan(0);
    expect(mem.m.maxInFlight).toBe(1);
  });
});

test("stop stops the sampler", () => {
  const v = fakeVitals();
  const s = serve(v);
  expect(v.f.started).toBe(1);
  s.stop();
  srv = null;
  expect(v.f.stopped).toBe(1);
});
