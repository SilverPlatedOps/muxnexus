import { expect, test } from "bun:test";
import { deviceView, setDeviceView, type Store } from "../src/client/display";
import { conversationWindow, withLocalActive } from "../src/client/conversation/model";
import type { SessionInfo, WindowInfo } from "../src/shared/protocol";

const memory = (): Store => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

test("touch devices default to conversation, others to terminal, a choice wins", () => {
  const s = memory();
  expect(deviceView(s, 0)).toBe("terminal");
  expect(deviceView(s, 5)).toBe("conversation");
  setDeviceView("terminal", s);
  expect(deviceView(s, 5)).toBe("terminal");
  setDeviceView("conversation", s);
  expect(deviceView(s, 0)).toBe("conversation");
});

test("a store that throws falls back to the default", () => {
  const broken: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(deviceView(broken, 3)).toBe("conversation");
  expect(deviceView(broken, 0)).toBe("terminal");
  expect(() => setDeviceView("terminal", broken)).not.toThrow();
});

const win = (id: string, over: Partial<WindowInfo> = {}): WindowInfo => ({ id, index: 0, name: "sh", active: false, panes: 1, ...over });

test("the window shown is the asked one, else a waiting one, else tmux's active, else the first", () => {
  const ws = [win("@1"), win("@2", { active: true }), win("@3", { agent: { state: "input" } as WindowInfo["agent"] })];
  expect(conversationWindow(ws, "@1")).toBe("@1");
  expect(conversationWindow(ws, "@9")).toBe("@3");
  expect(conversationWindow(ws, null)).toBe("@3");
  expect(conversationWindow([win("@1"), win("@2", { active: true })], null)).toBe("@2");
  expect(conversationWindow([win("@1"), win("@2")], null)).toBe("@1");
  expect(conversationWindow([], null)).toBeNull();
});

test("withLocalActive marks only the chosen window of the chosen session active", () => {
  const sessions = [
    { name: "a", windows: [win("@1", { active: true }), win("@2")] },
    { name: "b", windows: [win("@3", { active: true })] },
  ] as SessionInfo[];
  const out = withLocalActive(sessions, "a", "@2");
  expect(out[0]!.windows.map((w) => w.active)).toEqual([false, true]);
  expect(out[1]).toBe(sessions[1]);
  expect(withLocalActive(sessions, null, null)).toBe(sessions);
});
