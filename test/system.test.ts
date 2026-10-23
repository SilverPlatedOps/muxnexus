import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import type { SessionInfo, SwapNotice, SystemApp, SystemStats, WindowMemory } from "../src/shared/protocol";
import { batteryPressure, formatBytes, formatCpu, formatMem, formatRate, formatVolume, memLegend, memPressure, panelRows, pressure, resampleRates, sparkPath, statusLine, summaryFigures, swapLine } from "../src/client/system";
import { appOf, cpuPercent, memSplit, parseBattery, parseBootTime, parsePressure, parseSwap, parseVmCounters, parseVmStat } from "../src/server/system";

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

describe("memory split", () => {
  const GiB = 1024 ** 3;
  const page = 16384;
  const pages = (gib: number) => (gib * GiB) / page;
  const counters = (apps: number, wired: number, compressor: number) => ({
    pageSize: page, anonymous: pages(apps), purgeable: 0, wired: pages(wired), compressor: pages(compressor), swapouts: 0,
  });

  test("vm_stat's counters, swapouts among them, in pages at the header's page size", () => {
    const text = `${VM_STAT}Swapouts:                                   55940783.\n`;
    expect(parseVmCounters(text)).toEqual({
      pageSize: 16384, anonymous: 262896, purgeable: 48, wired: 178773, compressor: 409795, swapouts: 55940783,
    });
    expect(parseVmCounters(text.replace("(page size of 16384 bytes)", ""))).toBeUndefined();
  });

  test("apps, system and compressed are measured; available is what is left", () => {
    expect(memSplit(counters(6, 2, 3), 16 * GiB)).toEqual({
      apps: 6 * GiB, system: 2 * GiB, compressed: 3 * GiB, available: 5 * GiB, total: 16 * GiB,
    });
  });

  test("purgeable pages are not apps' memory", () => {
    const c = { ...counters(6, 2, 3), purgeable: pages(1) };
    expect(memSplit(c, 16 * GiB).apps).toBe(5 * GiB);
  });

  test("a reading that overruns the total is scaled to fit, and no part goes negative", () => {
    const s = memSplit(counters(10, 4, 6), 16 * GiB);
    expect(s.apps + s.system + s.compressed).toBeCloseTo(16 * GiB, 0);
    expect(s.available).toBe(0);
    expect(s.apps).toBeCloseTo(8 * GiB, 0);
    const odd = memSplit({ ...counters(1, 1, 1), purgeable: pages(3) }, 16 * GiB);
    expect(odd.apps).toBe(0);
    expect(Math.min(odd.apps, odd.system, odd.compressed, odd.available)).toBeGreaterThanOrEqual(0);
  });

  test("boot time from kern.boottime, in milliseconds", () => {
    expect(parseBootTime("{ sec = 1792468718, usec = 801966 } Tue Oct 20 10:58:38 2026\n")).toBe(1792468718000);
    expect(parseBootTime("nonsense")).toBeUndefined();
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
    const names = (by: "cpu" | "mem") => panelRows(apps, [], [], by, 0).map((r) => (r.kind === "app" ? r.app.name : ""));
    expect(names("cpu")).toEqual(["busy", "c", "a", "b", "big"]);
    expect(names("mem")).toEqual(["big", "c", "a", "b", "busy"]);
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

describe("overview models", () => {
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const notice = (over: Partial<SwapNotice>): SwapNotice => ({
    episode: 1, severity: "calm", reason: null, rate: null, swapUsed: null, written: null, bootTime: null, holders: [], acked: false, at: 0, ...over,
  });

  test("the status line, by severity and reason", () => {
    expect(statusLine(notice({ severity: "urgent", reason: "writes" }))).toEqual({ tone: "critical", text: "● Swapping to SSD", hint: "· close something below" });
    expect(statusLine(notice({ severity: "urgent", reason: "both" }))!.text).toBe("● Swapping to SSD");
    expect(statusLine(notice({ severity: "busy", reason: "pressure" }))).toEqual({ tone: "warning", text: "● Memory pressure", hint: "· close something below" });
    expect(statusLine(notice({ severity: "recovered", reason: "writes" }))).toEqual({ tone: "ok", text: "✓ Swap writes quiet for 2 min", hint: "" });
    expect(statusLine(notice({ severity: "recovered", reason: "pressure" }))!.text).toBe("✓ Pressure back to normal");
    expect(statusLine(notice({ severity: "calm" }))).toBeNull();
    expect(statusLine(null)).toBeNull();
  });

  test("rates and volumes", () => {
    expect(formatRate(22 * MiB)).toBe("22 MB/s");
    expect(formatRate(0.4 * MiB)).toBe("0.4 MB/s");
    expect(formatRate(9.97 * MiB)).toBe("10 MB/s");
    expect(formatVolume(0.92e12)).toBe("0.9 TB");
    expect(formatVolume(250e9)).toBe("250 GB");
  });

  test("the swap line: on disk, and the daily average since boot", () => {
    const boot = new Date(2026, 9, 20, 10, 58).getTime(); // a Tuesday, local time
    expect(swapLine(3.1 * GiB, 0.92e12, boot, boot + 3.6 * 86_400_000)).toEqual({
      text: "3.1G on disk · avg 256 GB/day since Tue", detail: "0.9 TB since Tue 10:58",
    });
    expect(swapLine(3.1 * GiB, 37e9, boot, boot + 0.5 * 86_400_000)).toEqual({
      text: "3.1G on disk · 37 GB since 10:58", detail: "37 GB since Tue 10:58",
    });
    expect(swapLine(3.1 * GiB, null, null, boot)).toEqual({ text: "3.1G on disk", detail: "" });
    expect(swapLine(undefined, null, null, boot)).toBeNull();
  });

  test("the legend names the four parts, two of them explained", () => {
    const l = memLegend({ apps: 6 * GiB, system: 2 * GiB, compressed: 3 * GiB, available: 5 * GiB, total: 16 * GiB });
    expect(l.map((x) => [x.key, x.label, x.bytes])).toEqual([
      ["apps", "apps", 6 * GiB], ["system", "system", 2 * GiB], ["compressed", "compressed", 3 * GiB], ["available", "available", 5 * GiB],
    ]);
    expect(l[1].tooltip).toBe("Wired: memory the kernel keeps in RAM for itself, drivers and the GPU, sometimes on an app's behalf. It can't be compressed or swapped.");
    expect(l[3].tooltip).toBe("Free memory plus file cache macOS can reclaim: the room before it has to compress or swap");
  });

  test("a tab's memory says when it is a floor, and when it is unknown", () => {
    expect(formatMem(1.2 * GiB, 3, 0)).toBe("1.2G");
    expect(formatMem(1.2 * GiB, 3, 1)).toBe("≥1.2G");
    expect(formatMem(0, 2, 2)).toBe("?");
  });

  describe("panelRows", () => {
    const NOW = Date.UTC(2026, 9, 24, 12);
    const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
    const app = (name: string, gib: number, cpu = 0): SystemApp => ({ name, cpu, mem: gib * GiB, procs: 1, top: name });
    const win = (windowId: string, gib: number, cpu = 0): WindowMemory => ({ windowId, bytes: gib * GiB, processes: 2, unreadable: 0, cpu, parts: [] });
    const sessions: SessionInfo[] = [
      { name: "work", id: "$1", attached: 1, windows: [
        { id: "@1", index: 0, name: "content-api", active: true, panes: 1, agent: { state: "running", since: iso(60_000) } },
        { id: "@2", index: 1, name: "jkb-storefront", active: false, panes: 1, agent: { state: "input", since: iso(3 * 86_400_000) } },
        { id: "@3", index: 2, name: "cms-ui", active: false, panes: 1, agent: { state: "done", since: iso(30 * 60_000) } },
      ] },
      { name: "pair", id: "$2", attached: 0, windows: [{ id: "@1", index: 0, name: "content-api", active: true, panes: 1 }] },
    ];

    test("tabs rank beside apps, named by session and tab, with the sessions that also show them", () => {
      const rows = panelRows([app("IntelliJ IDEA", 3.2), app("Helium", 2.2)], [win("@1", 1.5), win("@2", 0.4), win("@9", 9)], sessions, "mem", NOW);
      expect(rows.map((r) => (r.kind === "app" ? r.app.name : r.kind === "tab" ? r.place : "more"))).toEqual([
        "IntelliJ IDEA", "Helium", "work › content-api", "work › jkb-storefront",
      ]);
      const tab = rows[2];
      expect(tab.kind === "tab" && tab.alsoIn).toEqual(["pair"]);
    });

    test("an agent idle over an hour says so; a busy or recent one does not", () => {
      const rows = panelRows([], [win("@1", 1.5), win("@2", 0.4), win("@3", 0.3)], sessions, "mem", NOW);
      const idle = rows.map((r) => (r.kind === "tab" ? r.idle : undefined));
      expect(idle[0]).toBeNull();
      expect(idle[1]).toBe("agent idle 3d");
      expect(idle[2]).toBeNull();
    });

    test("at most the limit, tabs past it folded into one row", () => {
      const apps = Array.from({ length: 6 }, (_, i) => app(`App${i}`, 10 - i));
      const many: SessionInfo[] = [{ name: "w", id: "$1", attached: 0, windows: Array.from({ length: 5 }, (_, i) => ({ id: `@${i}`, index: i, name: `t${i}`, active: false, panes: 1 })) }];
      const wins = Array.from({ length: 5 }, (_, i) => win(`@${i}`, 1 - i / 10));
      const rows = panelRows(apps, wins, many, "mem", NOW, 8);
      expect(rows).toHaveLength(8);
      expect(rows.slice(0, 7).filter((r) => r.kind === "app")).toHaveLength(6);
      expect(rows[7]).toEqual({ kind: "more", count: 4, bytes: (0.9 + 0.8 + 0.7 + 0.6) * GiB });
    });

    test("opening the folded row lists those tabs, and smaller apps still are not", () => {
      const apps = Array.from({ length: 9 }, (_, i) => app(`App${i}`, 10 - i));
      const many: SessionInfo[] = [{ name: "w", id: "$1", attached: 0, windows: Array.from({ length: 3 }, (_, i) => ({ id: `@${i}`, index: i, name: `t${i}`, active: false, panes: 1 })) }];
      const wins = Array.from({ length: 3 }, (_, i) => win(`@${i}`, 0.5 - i / 10));
      const rows = panelRows(apps, wins, many, "mem", NOW, 8, true);
      expect(rows.map((r) => (r.kind === "app" ? r.app.name : r.kind === "tab" ? r.windowId : "more"))).toEqual([
        "App0", "App1", "App2", "App3", "App4", "App5", "App6", "@0", "@1", "@2",
      ]);
    });

    test("sorted by CPU when asked", () => {
      const rows = panelRows([app("Busy", 0.1, 30)], [win("@1", 1.5, 2)], sessions, "cpu", NOW);
      expect(rows[0].kind === "app" && rows[0].app.name).toBe("Busy");
    });
  });
});

describe("sparkPath", () => {
  test("on a scale of its own, with unknown readings as gaps", () => {
    expect(sparkPath([10, null, 20, 30], 4, 40)).toEqual({ line: "M0,75.0M2,50.0L3,25.0", area: "M2,50.0L3,25.0L3,100L2,100Z" });
  });
});

describe("resampleRates", () => {
  const MiB = 1024 ** 2;
  test("five minutes as sixty five-second slots, each the latest reading, in MB/s", () => {
    const now = 1_000_000;
    const pts = [{ at: now - 290_000, rate: 2 * MiB }, { at: now - 7_000, rate: 22 * MiB }, { at: now - 2_000, rate: 20 * MiB }];
    const r = resampleRates(pts, now);
    expect(r).toHaveLength(60);
    expect(r[59]).toBe(20);
    expect(r[58]).toBe(22);
    expect(r[1]).toBe(2);
    expect(r[0]).toBeNull(); // before the first reading
    expect(r[30]).toBeNull(); // long after it, with nothing since: a gap, not a held value
  });

  test("an unknown reading stays unknown", () => {
    const now = 1_000_000;
    expect(resampleRates([{ at: now - 1_000, rate: null }], now)[59]).toBeNull();
  });
});
