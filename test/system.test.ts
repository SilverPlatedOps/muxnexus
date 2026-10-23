import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import type { ServerMessage, SystemStats } from "../src/shared/protocol";
import { createServer } from "../src/server/server";
import { Tmux } from "../src/server/tmux";
import { waitFor } from "./helpers";
import { batteryPressure, formatBytes, formatCpu, memPressure, pressure, sortApps, sparkPath, summaryFigures } from "../src/client/system";
import { appOf, cpuPercent, createSystemReader, parseBattery, parsePressure, parseSwap, parseVmStat, topApps } from "../src/server/system";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4261.
Pages active:                                 202128.
Pages inactive:                               197134.
Pages speculative:                              3728.
Pages throttled:                                   0.
Pages wired down:                             178773.
Pages purgeable:                                  48.
"Translation faults":                     2566150765.
File-backed pages:                            140094.
Anonymous pages:                              262896.
Pages stored in compressor:                  2189947.
Pages occupied by compressor:                 409795.
`;

const PS = `  PID  %CPU    RSS COMM
96254 120.0 886800 /Users/me/.sdkman/candidates/java/25.0.1-tem/bin/java
96256  24.0 532720 /Users/me/.sdkman/candidates/java/25.0.1-tem/bin/java
46776  30.0  61040 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
46700   6.0 300000 /Applications/Claude.app/Contents/MacOS/Claude
  412  48.0  59760 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
    1   0.0  10000 /sbin/launchd
`;

const cpu = (user: number, sys: number, idle: number): CpuInfo => ({
  model: "", speed: 0, times: { user, nice: 0, sys, idle, irq: 0 },
});

describe("cpuPercent", () => {
  test("is the busy share across every core between two samples", () => {
    const before = [cpu(100, 100, 800), cpu(0, 0, 1000)];
    const after = [cpu(150, 150, 900), cpu(0, 0, 1200)];
    // core 0: 100 busy of 200, core 1: 0 of 200 -> 100 of 400
    expect(cpuPercent(before, after)).toBe(25);
  });

  test("gives no answer for counters that went backwards or a changed core count", () => {
    expect(cpuPercent([cpu(100, 0, 100)], [cpu(50, 0, 100)])).toBeUndefined();
    expect(cpuPercent([cpu(0, 0, 0)], [cpu(0, 0, 0), cpu(0, 0, 0)])).toBeUndefined();
  });
});

describe("parsers", () => {
  test("vm_stat counts app, wired and compressed memory at its own page size", () => {
    expect(parseVmStat(VM_STAT)).toBe((262896 - 48 + 178773 + 409795) * 16384);
    expect(parseVmStat(VM_STAT.replace("16384", "4096"))).toBe((262896 - 48 + 178773 + 409795) * 4096);
    expect(parseVmStat("nonsense")).toBeUndefined();
  });

  test("swap usage, with no bar for a swap file that does not exist yet", () => {
    expect(parseSwap("total = 13312.00M  used = 11735.12M  free = 1576.88M  (encrypted)")).toEqual({
      used: 11735.12 * 1024 ** 2, total: 13312 * 1024 ** 2,
    });
    expect(parseSwap("total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)")).toBeUndefined();
  });

  test("the kernel's memory pressure, read from the line after the swap", () => {
    const swap = "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)\n";
    expect(parsePressure(`${swap}1\n`)).toBe("normal");
    expect(parsePressure(`${swap}2\n`)).toBe("warning");
    expect(parsePressure(`${swap}4\n`)).toBe("critical");
    expect(parsePressure(swap)).toBeUndefined();
  });

  test("battery, and none on a Mac without one", () => {
    expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t62%; discharging; 3:20 remaining present: true\n"))
      .toEqual({ percent: 62, state: "discharging" });
    expect(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t85%; AC attached; not charging present: true\n"))
      .toEqual({ percent: 85, state: "on AC" });
    expect(parseBattery("Now drawing from 'AC Power'\n")).toBeUndefined();
  });
});

describe("apps", () => {
  test("a process belongs to the outermost .app on its path, else to its own name", () => {
    expect(appOf("/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper")).toBe("Claude");
    expect(appOf("/Applications/Arc.app/Contents/MacOS/Arc")).toBe("Arc");
    expect(appOf("/Users/me/.sdkman/candidates/java/25.0.1-tem/bin/java")).toBe("java");
    expect(appOf("launchd")).toBe("launchd");
    // A project folder that happens to end in .app is not a bundle.
    expect(appOf("/Users/me/projects/my.app/node_modules/.bin/vite")).toBe("vite");
  });

  test("sums each app's processes, on the whole machine's scale, busiest first", () => {
    const { apps, total } = topApps(PS, 12, 3);
    expect(apps.map((a) => a.name)).toEqual(["java", "WindowServer", "Claude"]);
    expect(apps[0]).toEqual({ name: "java", cpu: 12, mem: (886800 + 532720) * 1024, procs: 2, top: "java" });
    // Its helper is the busier process, and paths with spaces stay whole.
    expect(apps[2]).toMatchObject({ cpu: 3, procs: 2, top: "Claude Helper" });
    expect(total).toBe((120 + 24 + 30 + 6 + 48) / 12);
  });

  test("the largest by memory come too, though they are idle", () => {
    expect(topApps(PS, 12, 1).apps.map((a) => a.name)).toEqual(["java"]);
    expect(topApps(PS, 12, 2).apps.map((a) => a.name)).toEqual(["java", "WindowServer", "Claude"]);
  });
});

describe("reader", () => {
  const outputs: Record<string, string> = {
    vm_stat: VM_STAT,
    sysctl: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)\n2\n",
    ps: PS,
    pmset: " -InternalBattery-0 (id=1)\t85%; charging; 1:00 remaining present: true",
  };

  function reader(fail: string[] = []) {
    const calls: string[] = [];
    let t = 0;
    let busy = 0;
    const r = createSystemReader({
      run: async (cmd) => {
        calls.push(cmd[0]);
        if (fail.includes(cmd[0])) throw new Error("missing");
        return outputs[cmd[0]];
      },
      cpus: () => [cpu(busy, 0, 1000 + t)],
      now: () => t,
    });
    return { r, calls, tick(ms: number, b: number) { t += ms; busy += b; } };
  }

  test("no CPU figure until there is a sample to compare with, nor after a long gap", async () => {
    const { r, tick } = reader();
    expect((await r.read()).cpu).toBeUndefined();
    tick(2000, 6000);
    expect((await r.read()).cpu).toBe(75); // 6000 busy of 8000
    tick(60_000, 0);
    expect((await r.read()).cpu).toBeUndefined();
  });

  test("a read a moment after the last gives no CPU figure, and keeps the older sample", async () => {
    const { r, tick } = reader();
    await r.read();
    tick(2000, 2000);
    expect((await r.read()).cpu).toBe(50);
    tick(50, 50);
    expect((await r.read()).cpu).toBeUndefined();
    tick(1950, 1950);
    // Measured from the read before the quick one: 2000 busy, 2000 idle.
    expect((await r.read()).cpu).toBe(50);
  });

  test("memory carries the kernel's pressure", async () => {
    const { r } = reader();
    expect((await r.read()).mem?.pressure).toBe("warning");
  });

  test("asks pmset only every half minute", async () => {
    const { r, calls, tick } = reader();
    expect((await r.read()).battery).toEqual({ percent: 85, state: "charging" });
    tick(2000, 0);
    expect((await r.read()).battery).toEqual({ percent: 85, state: "charging" });
    expect(calls.filter((c) => c === "pmset")).toHaveLength(1);
  });

  test("a tool that fails leaves its row out and the rest standing", async () => {
    const { r } = reader(["vm_stat", "pmset"]);
    const s = await r.read();
    expect(s.mem).toBeUndefined();
    expect(s.battery).toBeUndefined();
    expect(s.swap).toEqual({ used: 1024 ** 3, total: 2 * 1024 ** 3 });
    expect(s.apps[0].name).toBe("java");
  });
});

describe("server", () => {
  const SOCKET = "cmux-viewer-test-system";

  async function connect(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: `http://127.0.0.1:${port}` } } as any);
    const got: ServerMessage[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") got.push(JSON.parse(e.data)); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
    return { ws, got, system: () => got.filter((m) => m.t === "system"), send: (m: object) => ws.send(JSON.stringify(m)) };
  }

  test("reads only while a client has the overview open, and tells only that client", async () => {
    let reads = 0;
    const stats: SystemStats = { load: [1, 2, 3], apps: [] };
    const system = { read: async () => { reads++; return stats; } };
    const srv = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 10_000, system, systemMs: 20 });
    try {
      const watcher = await connect(srv.port);
      const other = await connect(srv.port);
      await Bun.sleep(100);
      expect(reads).toBe(0);

      watcher.send({ t: "system", on: true });
      await waitFor(() => watcher.system().length > 2, 2000, "system pushed while open");
      expect(watcher.system()[0]).toEqual({ t: "system", stats });
      expect(other.system()).toHaveLength(0);

      // A second client joining gets the last reading, not a read of its own.
      const before = reads;
      other.send({ t: "system", on: true });
      await waitFor(() => other.system().length > 0, 2000, "last reading to the joiner");
      expect(reads - before).toBeLessThanOrEqual(1); // at most the timer's own tick
      other.send({ t: "system", on: false });

      watcher.send({ t: "system", on: false });
      await Bun.sleep(60); // let a read already under way land
      const stopped = reads;
      await Bun.sleep(150);
      expect(reads).toBe(stopped);

      // Closing the socket with the box open stops it as surely as the switch.
      watcher.send({ t: "system", on: true });
      await waitFor(() => reads > stopped, 2000, "reading again");
      watcher.ws.close();
      await Bun.sleep(60);
      const closed = reads;
      await Bun.sleep(150);
      expect(reads).toBe(closed);
    } finally {
      srv.stop();
      await new Tmux(SOCKET).killServer();
    }
  });
});

describe("panel formatting", () => {
  test("the sparkline ends at the right edge on a fixed 0-100 scale, clamped", () => {
    expect(sparkPath([50])).toEqual({ area: "", line: "" });
    expect(sparkPath([0, 25, 150], 10)).toEqual({ line: "M7,100.0L8,75.0L9,0.0", area: "M7,100.0L8,75.0L9,0.0L9,100L7,100Z" });
  });

  test("a figure turns yellow at 80% and red at 90%; a battery only while it runs down", () => {
    expect([79, 80, 89, 90].map(pressure)).toEqual(["", "warning", "warning", "critical"]);
    expect(batteryPressure({ percent: 15, state: "discharging" })).toBe("warning");
    expect(batteryPressure({ percent: 8, state: "discharging" })).toBe("critical");
    expect(batteryPressure({ percent: 8, state: "charging" })).toBe("");
  });

  test("memory is the kernel's call, by percentage only when it does not say", () => {
    const G = 1024 ** 3;
    expect(memPressure({ used: 15 * G, total: 16 * G, pressure: "normal" })).toBe("");
    expect(memPressure({ used: 4 * G, total: 16 * G, pressure: "critical" })).toBe("critical");
    expect(memPressure({ used: 15 * G, total: 16 * G })).toBe("critical");
  });

  test("apps sort on the tenth of a percent shown, then by name", () => {
    const app = (name: string, cpu: number, gb: number) => ({ name, cpu, mem: gb * 1024 ** 3, procs: 1, top: name });
    const apps = [app("b", 0.41, 1), app("a", 0.44, 1), app("c", 1.0, 1), app("big", 0.1, 3), app("busy", 12, 0.1)];
    expect(sortApps(apps, "cpu").map((a) => a.name)).toEqual(["busy", "c", "a", "b", "big"]);
    expect(sortApps(apps, "mem").map((a) => a.name)).toEqual(["big", "c", "a", "b", "busy"]);
  });

  test("collapsed, one line: CPU and memory, toned as in the panel", () => {
    const G = 1024 ** 3;
    const stats: SystemStats = { load: [1, 1, 1], mem: { used: 12 * G, total: 16 * G, pressure: "warning" }, apps: [] };
    expect(summaryFigures(15, stats)).toEqual([
      { label: "CPU", value: "15%", tone: "" },
      { label: "Mem", value: "12G/16G", tone: "warning" },
    ]);
    // Before the second reading there is no CPU figure yet.
    expect(summaryFigures(undefined, { load: [1, 1, 1], apps: [] })).toEqual([{ label: "CPU", value: "–", tone: "" }]);
  });

  test("collapsed, a battery joins the line only once it wants something", () => {
    const at = (percent: number) => summaryFigures(5, { load: [1, 1, 1], battery: { percent, state: "discharging" }, apps: [] });
    expect(at(60).map((f) => f.label)).toEqual(["CPU"]);
    expect(at(8)).toContainEqual({ label: "Bat", value: "8%", tone: "critical" });
  });

  test("bytes and CPU in the room a narrow panel has", () => {
    expect(formatBytes(972 * 1024 ** 2)).toBe("972M");
    expect(formatBytes(1.94 * 1024 ** 3)).toBe("1.9G");
    expect(formatBytes(16 * 1024 ** 3)).toBe("16G");
    expect(formatBytes(1024 ** 3)).toBe("1G");
    expect(formatCpu(3.94)).toBe("3.9%");
    expect(formatCpu(24.6)).toBe("25%");
    expect(formatCpu(9.96)).toBe("10%");
    expect(formatBytes(1023.6 * 1024 ** 2)).toBe("1G");
    expect(formatBytes(9.97 * 1024 ** 3)).toBe("10G");
  });
});
