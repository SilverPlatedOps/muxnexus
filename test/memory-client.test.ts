import { describe, expect, test } from "bun:test";
import type { ServerMessage, SwapNotice, WindowInfo, WindowMemory } from "../src/shared/protocol";
import { memoryShown, setMemoryShown, type Store } from "../src/client/display";
import { createMemoryStore } from "../src/client/memory";

const GiB = 1024 ** 3;
const win = (windowId: string, gib: number, processes = 2, unreadable = 0): WindowMemory => ({ windowId, bytes: gib * GiB, processes, unreadable, cpu: 0, parts: [] });
const reading = (windows: WindowMemory[], tmuxServer: string | null = "123-456"): Extract<ServerMessage, { t: "memory" }> => ({ t: "memory", tmuxServer, at: 1, metric: "footprint", windows });
const tab = (id: string): WindowInfo => ({ id, index: 0, name: id, active: false, panes: 1 });
const notice = (over: Partial<SwapNotice>): SwapNotice => ({
  episode: 1, severity: "calm", reason: null, rate: null, swapUsed: null, written: null, bootTime: null, holders: [], acked: false, at: 0, ...over,
});

function memStore(): Store {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe("the Display switch", () => {
  test("is off until switched on", () => {
    const s = memStore();
    expect(memoryShown(s)).toBe(false);
    setMemoryShown(true, s);
    expect(memoryShown(s)).toBe(true);
    setMemoryShown(false, s);
    expect(memoryShown(s)).toBe(false);
  });
});

describe("createMemoryStore", () => {
  test("a reading from another tmux server labels nothing", () => {
    const m = createMemoryStore();
    m.set(reading([win("@1", 1.5)], "999-1"), "123-456");
    expect(m.window("@1")).toBeNull();
    m.set(reading([win("@1", 1.5)]), "123-456");
    expect(m.window("@1")).toEqual({ text: "1.5G", tone: "" });
    m.clear();
    expect(m.window("@1")).toBeNull();
  });

  test("a chip takes colour only while memory is tight, and only on a biggest holder", () => {
    const m = createMemoryStore();
    m.set(reading([win("@1", 1.5), win("@2", 0.4)]), "123-456");
    const holders = [{ kind: "tab" as const, name: "@1", bytes: 1.5 * GiB }];
    m.setNotice(notice({ severity: "urgent", reason: "writes", holders }));
    expect(m.window("@1")!.tone).toBe("critical");
    expect(m.window("@2")!.tone).toBe("");
    m.setNotice(notice({ severity: "busy", reason: "writes", holders }));
    expect(m.window("@1")!.tone).toBe("warning");
    m.setNotice(notice({ severity: "recovered", reason: "writes", holders }));
    expect(m.window("@1")!.tone).toBe("");
  });

  test("a notice says whether any chip's colour changed, so the tabs repaint only then", () => {
    const m = createMemoryStore();
    const holders = [{ kind: "tab" as const, name: "@1", bytes: 1.5 * GiB }];
    expect(m.setNotice(notice({ severity: "calm" }))).toBe(false);
    expect(m.setNotice(notice({ severity: "urgent", reason: "writes", holders }))).toBe(true);
    expect(m.setNotice(notice({ severity: "urgent", reason: "writes", holders, rate: 30 }))).toBe(false);
    expect(m.setNotice(notice({ severity: "busy", reason: "writes", holders }))).toBe(true);
    expect(m.setNotice(notice({ severity: "calm" }))).toBe(true);
  });

  test("a session sums its tabs, carrying a floor or an unknown", () => {
    const m = createMemoryStore();
    m.set(reading([win("@1", 1.5), win("@2", 0.5, 2, 1), win("@3", 0, 2, 2)]), "123-456");
    expect(m.session([tab("@1")])).toEqual({ text: "1.5G", tone: "" });
    expect(m.session([tab("@1"), tab("@2")])).toEqual({ text: "≥2G", tone: "" });
    expect(m.window("@3")!.text).toBe("?");
    expect(m.session([tab("@9")])).toBeNull();
  });
});
