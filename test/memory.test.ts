import { describe, expect, test } from "bun:test";
import type { Footprint } from "../src/server/footprint";
import { attribute, createMemoryReader, parsePs, processLabel, vmName, type Proc } from "../src/server/memory";

const MiB = 1024 ** 2;
const VM = "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine";

const proc = (pid: number, ppid: number, path: string, cpu = 0): Proc => ({ pid, ppid, cpu, rss: 0, path });
/** Footprints by pid, in MiB; "gone" and "denied" as libproc says them. */
const mem = (table: Record<number, number | "gone" | "denied">) => (pid: number): Footprint => {
  const v = table[pid];
  return typeof v === "number" ? { bytes: v * MiB } : { error: v ?? "gone" };
};

// tmux server 100 runs two windows: @1 (pane %1, shell 200) and @2 (pane %2, shell 300).
const PANES = [
  { windowId: "@1", paneId: "%1", pid: 200, server: "100-1" },
  { windowId: "@2", paneId: "%2", pid: 300, server: "100-1" },
];
const PROCS = [
  proc(1, 0, "/sbin/launchd"),
  proc(100, 1, "/opt/homebrew/bin/tmux"),
  proc(200, 100, "/bin/zsh"),
  proc(201, 200, "/Users/me/.local/share/claude/versions/2.1.304", 2),
  proc(202, 201, "/opt/homebrew/bin/node", 1),
  proc(300, 100, "/bin/zsh"),
  proc(301, 300, "/Users/me/.sdkman/candidates/java/25.0.1-tem/bin/java", 5),
  proc(400, 1, "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea", 3),
  proc(401, 400, "/Applications/IntelliJ IDEA.app/Contents/jbr/Contents/Home/bin/java", 1),
  proc(500, 1, VM, 0.5),
  proc(600, 1, "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer", 6),
];
const SIZES = { 1: "denied", 100: 5, 200: 2, 201: 400, 202: 120, 300: 2, 301: 1100, 400: 3000, 401: 200, 500: 3000, 600: "denied" } as const;

describe("attribute", () => {
  test("a pane's shell and everything under it belong to that tab; the rest group by app", () => {
    const a = attribute(PROCS, PANES, mem(SIZES));
    const w1 = a.windows.find((w) => w.windowId === "@1")!;
    expect(w1).toMatchObject({ bytes: (2 + 400 + 120) * MiB, processes: 3, unreadable: 0, cpu: 3 });
    expect(a.windows.find((w) => w.windowId === "@2")).toMatchObject({ bytes: 1102 * MiB, processes: 2 });
    const names = a.apps.map((x) => x.name);
    expect(names).toContain("IntelliJ IDEA");
    expect(names).not.toContain("claude");
    expect(names).not.toContain("node");
    expect(names).not.toContain("java");
    expect(a.apps.find((x) => x.name === "IntelliJ IDEA")).toMatchObject({ mem: 3200 * MiB, procs: 2 });
  });

  test("a process under two panes counts once, under the nearest", () => {
    // A pane whose shell runs inside another pane's tree (a nested tmux client's server, say).
    const panes = [...PANES, { windowId: "@3", paneId: "%3", pid: 201, server: "100-1" }];
    const a = attribute(PROCS, panes, mem(SIZES));
    expect(a.windows.find((w) => w.windowId === "@3")).toMatchObject({ processes: 2, bytes: 520 * MiB });
    expect(a.windows.find((w) => w.windowId === "@1")).toMatchObject({ processes: 1, bytes: 2 * MiB });
  });

  test("a process that exited is dropped; one that cannot be read is counted as unreadable, its CPU kept", () => {
    const a = attribute(PROCS, PANES, mem({ ...SIZES, 202: "gone", 301: "denied" }));
    expect(a.windows.find((w) => w.windowId === "@1")).toMatchObject({ processes: 2, unreadable: 0, bytes: 402 * MiB });
    const w2 = a.windows.find((w) => w.windowId === "@2")!;
    expect(w2).toMatchObject({ processes: 2, unreadable: 1, bytes: 2 * MiB, cpu: 5 });
    expect(w2.parts.find((p) => p.name === "java")).toEqual({ name: "java", bytes: null, cpu: 5 });
  });

  test("an app none of whose processes can be read is marked so, and still ranks by CPU", () => {
    const a = attribute(PROCS, PANES, mem(SIZES), { appLimit: 1 });
    expect(a.apps.find((x) => x.name === "WindowServer")).toMatchObject({ mem: 0, unreadable: true, cpu: 6 });
  });

  test("apps are ranked after the tabs took theirs, and every window is kept", () => {
    const many: Proc[] = [...PROCS];
    for (let i = 0; i < 20; i++) many.push(proc(1000 + i, 1, `/Applications/App${i}.app/Contents/MacOS/App${i}`, i / 10));
    const sizes: Record<number, number | "denied"> = { ...SIZES };
    for (let i = 0; i < 20; i++) sizes[1000 + i] = 10 + i;
    const a = attribute(many, PANES, mem(sizes), { appLimit: 8 });
    const byMem = [...a.apps].sort((x, y) => y.mem - x.mem).slice(0, 2).map((x) => x.name);
    expect(byMem).toEqual(["IntelliJ IDEA", "com.apple.Virtualization.VirtualMachine"]);
    expect(a.apps.length).toBeLessThanOrEqual(16);
    expect(a.apps.length).toBeGreaterThanOrEqual(8);
    expect(a.windows.map((w) => w.windowId).sort()).toEqual(["@1", "@2"]);
    expect(a.appsCpu).toBeCloseTo(PROCS.reduce((n, p) => n + p.cpu, 0) + 19, 6);
  });

  test("parts are grouped by label, a Maven test run named for what it is", () => {
    const args = (pid: number) => (pid === 301 ? "java -cp x org.apache.maven.surefire.booter.ForkedBooter /tmp/s" : undefined);
    const a = attribute(PROCS, PANES, mem(SIZES), { argsOf: args });
    expect(a.windows.find((w) => w.windowId === "@2")!.parts).toEqual([
      { name: "java · maven tests", bytes: 1100 * MiB, cpu: 5 },
      { name: "zsh", bytes: 2 * MiB, cpu: 0 },
    ]);
    expect(a.windows.find((w) => w.windowId === "@1")!.parts.map((p) => p.name)).toEqual(["claude", "node", "zsh"]);
  });

  test("the Virtualization VM takes the name its open files give it", () => {
    const a = attribute(PROCS, PANES, mem(SIZES), { vmNameOf: (pid) => (pid === 500 ? "Docker VM · Rancher" : undefined) });
    expect(a.apps.find((x) => x.name === "Docker VM · Rancher")).toMatchObject({ mem: 3000 * MiB });
  });
});

describe("labels", () => {
  test("version-named Claude binaries are claude; a Maven run is maven tests; else the file name", () => {
    expect(processLabel("/Users/me/.local/share/claude/versions/2.1.304")).toBe("claude");
    expect(processLabel("/opt/bin/java", "java org.apache.maven.surefire.booter.ForkedBooter")).toBe("java · maven tests");
    expect(processLabel("/opt/bin/java", "java -classpath /x/plexus-classworlds.jar org.codehaus.plexus.classworlds.launcher.Launcher -Dmaven.home=/x")).toBe("java · maven tests");
    expect(processLabel("/opt/bin/java", "java -jar app.jar")).toBe("java");
    expect(processLabel("/opt/homebrew/bin/node")).toBe("node");
  });

  test("a VM is named by the host whose disk it has open", () => {
    expect(vmName(["/Users/me/Library/Application Support/rancher-desktop/lima/0/diffdisk"])).toBe("Docker VM · Rancher");
    expect(vmName(["/Users/me/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"])).toBe("Docker VM · Docker Desktop");
    expect(vmName(["/Users/me/.colima/_lima/colima/diffdisk"])).toBe("Docker VM · Colima");
    expect(vmName(["/Users/me/vms/ubuntu.img"])).toBe("Linux VM");
    expect(vmName([])).toBe("Linux VM");
  });
});

describe("createMemoryReader", () => {
  const PS_TEXT = PROCS.map((p) => `${p.pid} ${p.ppid} ${p.cpu * 10} ${p.pid * 10} ${p.path}`).join("\n");

  function rig(opts: { footprint?: boolean; failPs?: boolean; failPanes?: boolean } = {}) {
    const calls: string[][] = [];
    const reader = createMemoryReader({
      panes: async () => {
        if (opts.failPanes) throw new Error("no tmux");
        return PANES;
      },
      footprint: opts.footprint === false ? null : mem(SIZES),
      cores: () => 10,
      now: () => 42,
      run: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "ps" && cmd[1] === "-Ao") {
          if (opts.failPs) throw new Error("ps failed");
          return PS_TEXT;
        }
        if (cmd[0] === "ps") return "301 java -cp x org.apache.maven.surefire.booter.ForkedBooter\n";
        if (cmd[0] === "lsof") return "p500\nfcwd\nn/\nf4\nn/Users/me/Library/Application Support/rancher-desktop/lima/0/diffdisk\n";
        throw new Error(`unexpected ${cmd[0]}`);
      },
    });
    return { reader, calls };
  }

  test("footprints when they can be read, and says so, with the tmux server its windows came from", async () => {
    const r = (await rig().reader.read())!;
    expect(r).toMatchObject({ at: 42, metric: "footprint", tmuxServer: "100-1" });
    expect(r.apps.find((a) => a.name === "IntelliJ IDEA")!.mem).toBe(3200 * MiB);
  });

  test("without footprints, resident memory throughout, never a mix", async () => {
    const r = (await rig({ footprint: false }).reader.read())!;
    expect(r.metric).toBe("rss");
    expect(r.apps.find((a) => a.name === "IntelliJ IDEA")!.mem).toBe((400 + 401) * 10 * 1024);
    expect(r.windows.find((w) => w.windowId === "@1")!.bytes).toBe((200 + 201 + 202) * 10 * 1024);
  });

  test("asks for arguments only of java inside tabs", async () => {
    const { reader, calls } = rig();
    const r = (await reader.read())!;
    const asked = calls.filter((c) => c[0] === "ps" && c[1] !== "-Ao");
    expect(asked).toEqual([["ps", "-o", "pid=,args=", "-p", "301"]]);
    expect(r.windows.find((w) => w.windowId === "@2")!.parts[0].name).toBe("java · maven tests");
  });

  test("names the VM from its open files, asking once per VM process", async () => {
    const { reader, calls } = rig();
    await reader.read();
    const r = (await reader.read())!;
    expect(calls.filter((c) => c[0] === "lsof")).toEqual([["lsof", "-Fn", "-p", "500"]]);
    expect(r.apps.map((a) => a.name)).toContain("Docker VM · Rancher");
  });

  test("a tmux that does not answer costs the reading its tabs, not the reading", async () => {
    const reader = createMemoryReader({
      panes: () => new Promise(() => {}),
      footprint: mem(SIZES),
      cores: () => 10,
      run: async (cmd) => (cmd[1] === "-Ao" ? PS_TEXT : ""),
    });
    const t0 = Date.now();
    const r = (await reader.read())!;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.windows).toEqual([]);
  });

  test("no process list, no reading; no panes, every process an app's", async () => {
    expect(await rig({ failPs: true }).reader.read()).toBeNull();
    const r = (await rig({ failPanes: true }).reader.read())!;
    expect(r.windows).toEqual([]);
    expect(r.apps.map((a) => a.name)).toContain("zsh");
  });
});

describe("parsePs", () => {
  test("pid, parent, CPU on the whole machine's scale, RSS in bytes and the path, spaces kept", () => {
    const text = "  201   200  24.0  61040 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper\n    1     0   0.0  10000 /sbin/launchd\n";
    expect(parsePs(text, 12)).toEqual([
      { pid: 201, ppid: 200, cpu: 2, rss: 61040 * 1024, path: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper" },
      { pid: 1, ppid: 0, cpu: 0, rss: 10000 * 1024, path: "/sbin/launchd" },
    ]);
  });
});
