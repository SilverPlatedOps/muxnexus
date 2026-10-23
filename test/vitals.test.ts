import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import { createVitalsSampler } from "../src/server/vitals";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const cpu = (busy: number, idle: number): CpuInfo => ({ model: "", speed: 0, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

function rig() {
  const m = {
    t: 1_000_000, swapouts: 1000, boot: 1792468718, pressure: "1", busy: 0, idle: 0,
    fail: new Set<string>(), calls: [] as string[], scheduled: [] as { ms: number; fn: () => void }[], cancels: 0,
    onRun: null as null | ((cmd: string[]) => void),
  };
  const vmStat = () => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4261.
Pages wired down:                             131072.
Pages purgeable:                                   0.
Anonymous pages:                              393216.
Pages occupied by compressor:                 196608.
Swapouts:                                 ${m.swapouts}.
`;
  const s = createVitalsSampler({
    run: async (cmd) => {
      m.calls.push(cmd[0]);
      m.onRun?.(cmd);
      if (m.fail.has(cmd[0])) throw new Error("failed");
      if (cmd[0] === "vm_stat") return vmStat();
      if (cmd[0] === "sysctl") return `total = 4096.00M  used = 3072.00M  free = 1024.00M  (encrypted)\n${m.pressure}\n{ sec = ${m.boot}, usec = 0 } Tue Oct 20 10:58:38 2026\n`;
      return " -InternalBattery-0 (id=1)\t62%; discharging; 3:20 remaining present: true";
    },
    now: () => m.t,
    cpus: () => [cpu(m.busy, m.idle)],
    totalmem: () => 16 * GiB,
    loadavg: () => [1, 2, 3],
    schedule: (fn, ms) => {
      m.scheduled.push({ fn, ms });
      return () => { m.cancels++; };
    },
  });
  const later = async (ms: number, pages = 0) => {
    m.t += ms;
    m.swapouts += pages;
    m.idle += ms;
    await s.sampleNow();
  };
  return { s, m, later };
}

describe("swap rate", () => {
  test("is the bytes written to swap over the real time between two samples", async () => {
    const { s, later } = rig();
    await s.sampleNow();
    expect(s.latest()!.rate).toBeNull(); // nothing to compare against yet
    await later(5000, 6400);
    expect(s.latest()!.rate).toBe(20 * MiB);
    await later(7000, 6400);
    expect(s.latest()!.rate).toBeCloseTo((6400 * 16384) / 7, 6);
    expect(s.latest()!.written).toBe((1000 + 12800) * 16384);
    expect(s.latest()!.bootTime).toBe(1792468718000);
  });

  test("after hours asleep the rate is unknown and an urgent level stays urgent", async () => {
    const { s, m, later } = rig();
    m.pressure = "4";
    await s.sampleNow();
    expect(s.level().severity).toBe("urgent");
    m.pressure = "1";
    await later(6 * 3600_000, 900_000);
    expect(s.latest()!.rate).toBeNull();
    expect(s.history().at(-1)!.rate).toBeNull();
    expect(s.level().severity).toBe("urgent");
  });

  test("a sleep in the middle of a sample is an unknown rate, not a spike", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    m.onRun = (cmd) => {
      if (cmd[0] !== "vm_stat") return;
      m.t += 6 * 3600_000; // the lid closed while the tools ran
      m.swapouts += 900_000;
    };
    await later(5000);
    expect(s.latest()!.rate).toBeNull();
    expect(s.history().at(-1)!.at).toBe(m.t);
  });

  test("a failed vm_stat is an unknown point, not a quiet one", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    m.fail.add("vm_stat");
    await later(5000, 100);
    expect(s.history().at(-1)).toEqual({ at: m.t, rate: null });
  });

  test("a counter that went down, or a new boot, starts counting afresh", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    await later(5000, -500);
    expect(s.latest()!.rate).toBeNull();
    await later(5000, 640);
    expect(s.latest()!.rate).not.toBeNull();
    m.boot += 100;
    await later(5000, 640);
    expect(s.latest()!.rate).toBeNull();
  });

  test("history keeps the last five minutes", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    for (let i = 0; i < 80; i++) await later(5000, 10);
    const h = s.history();
    expect(h[0].at).toBeGreaterThanOrEqual(m.t - 300_000);
    expect(h.length).toBeLessThanOrEqual(61);
  });

  test("two samples asked for at once are one sample", async () => {
    const { s, m } = rig();
    await Promise.all([s.sampleNow(), s.sampleNow()]);
    expect(m.calls.filter((c) => c === "vm_stat")).toHaveLength(1);
  });
});

describe("level and acknowledgement", () => {
  test("only the current episode can be acknowledged, and listeners hear it", async () => {
    const { s, m } = rig();
    m.pressure = "4";
    await s.sampleNow();
    let heard = 0;
    s.onSample(() => { heard++; });
    const episode = s.level().episode;
    expect(s.acknowledge(episode + 1)).toBe(false);
    expect(s.level().acked).toBe(false);
    expect(s.acknowledge(episode)).toBe(true);
    expect(s.level().acked).toBe(true);
    expect(heard).toBe(1);
  });
});

describe("cadence", () => {
  test("every five seconds, every two while fast, and nothing after stop", async () => {
    const { s, m } = rig();
    s.start();
    expect(m.scheduled.at(-1)!.ms).toBe(5000);
    s.setFast(true);
    expect(m.cancels).toBe(1);
    expect(m.scheduled.at(-1)!.ms).toBe(2000);
    s.setFast(false);
    expect(m.scheduled.at(-1)!.ms).toBe(5000);
    s.stop();
    expect(m.cancels).toBe(3);
    m.scheduled.at(-1)!.fn();
    await Bun.sleep(10);
    expect(m.calls).toHaveLength(0);
  });
});

describe("the rest of the figures", () => {
  test("memory, its split and pressure, swap and load", async () => {
    const { s, m } = rig();
    m.pressure = "2";
    await s.sampleNow();
    const v = s.latest()!;
    expect(v.mem).toEqual({ used: (393216 + 131072 + 196608) * 16384, total: 16 * GiB, pressure: "warning" });
    expect(v.split).toEqual({ apps: 6 * GiB, system: 2 * GiB, compressed: 3 * GiB, available: 5 * GiB, total: 16 * GiB });
    expect(v.swap).toEqual({ used: 3 * GiB, total: 4 * GiB });
    expect(v.load).toEqual([1, 2, 3]);
  });

  test("no CPU figure until there is a sample to compare with, nor after a long gap", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    expect(s.latest()!.cpu).toBeUndefined();
    m.busy += 6000;
    await later(2000);
    expect(s.latest()!.cpu).toBe(75); // 6000 busy of 8000
    await later(60_000);
    expect(s.latest()!.cpu).toBeUndefined();
  });

  test("asks pmset only every half minute", async () => {
    const { s, m, later } = rig();
    await s.sampleNow();
    expect(s.latest()!.battery).toEqual({ percent: 62, state: "discharging" });
    await later(5000);
    expect(s.latest()!.battery).toEqual({ percent: 62, state: "discharging" });
    expect(m.calls.filter((c) => c === "pmset")).toHaveLength(1);
  });

  test("a tool that fails leaves its figures out and the rest standing", async () => {
    const { s, m } = rig();
    m.fail.add("vm_stat");
    m.fail.add("pmset");
    await s.sampleNow();
    const v = s.latest()!;
    expect(v.mem).toBeUndefined();
    expect(v.split).toBeUndefined();
    expect(v.battery).toBeUndefined();
    expect(v.swap).toEqual({ used: 3 * GiB, total: 4 * GiB });
  });
});
