import { describe, expect, test } from "bun:test";
import { createViewHost, loadChosen, scopedStore, type HostEnv, type View, type ViewHost } from "../src/client/view-host";
import { sessionName, type WorldActions } from "../src/client/world-actions";
import { buildWorld } from "../src/client/world";

function memoryStore(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

const slot = () => ({ hidden: true, replaceChildren() {} }) as unknown as HTMLElement;
const actions = {} as WorldActions;
const world = buildWorld({ sessions: [], tmuxServer: null, usage: [], folded: new Set(), current: null, marksShown: true });

function fakeEnv() {
  const timers: { ms: number; cb: () => void; on: boolean }[] = [];
  const env: HostEnv & { hiddenNow: boolean; fire(): void; timers: typeof timers } = {
    hiddenNow: false,
    timers,
    hidden: () => env.hiddenNow,
    reducedMotion: () => false,
    now: () => 5000,
    every(ms, cb) {
      const t = { ms, cb, on: true };
      timers.push(t);
      return () => { t.on = false; };
    },
    fire() { for (const t of timers) if (t.on) t.cb(); },
  };
  return env;
}

function recordingView() {
  const calls: string[] = [];
  let host: ViewHost | null = null;
  const view: View = {
    mount(h) { host = h; calls.push("mount"); },
    update(_w, events) { calls.push(`update:${events.length}`); },
    reveal(ref) { calls.push(`reveal:${ref.window}`); },
    unmount() { calls.push("unmount"); },
  };
  return { view, calls, host: () => host };
}

describe("sessionName", () => {
  test("finds a session by id, under whatever it is called now", () => {
    const sessions = [{ id: "$1", name: "renamed since", attached: 0, windows: [] }];
    expect(sessionName(sessions, "$1")).toBe("renamed since");
    expect(sessionName(sessions, "$9")).toBeNull();
  });
});

describe("prefs", () => {
  test("a view's prefs live under its own name, and a broken store is shrugged off", () => {
    const store = memoryStore();
    scopedStore("garden", store).set("zoom", "2");
    expect(store.data.get("muxnexus.view.garden.zoom")).toBe("2");
    expect(scopedStore("garden", store).get("zoom")).toBe("2");
    const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(scopedStore("garden", broken).get("zoom")).toBeNull();
    scopedStore("garden", broken).set("zoom", "1");
  });

  test("the chosen view defaults to the terminal, and nonsense is the terminal", () => {
    expect(loadChosen(memoryStore())).toBe("terminal");
    expect(loadChosen(memoryStore({ "muxnexus.view": "debug" }))).toBe("debug");
    expect(loadChosen(memoryStore({ "muxnexus.view": "nope" }))).toBe("terminal");
  });
});

describe("createViewHost", () => {
  test("choosing a view mounts it, hands it the last world, and remembers the choice", () => {
    const store = memoryStore();
    const rec = recordingView();
    let changed = 0;
    const host = createViewHost({ slot: slot(), actions, views: { debug: () => rec.view }, changed: () => changed++, store, env: fakeEnv() });
    host.update(world, []);
    expect(host.showing()).toBe(false);
    host.choose("debug");
    expect(host.showing()).toBe(true);
    expect(rec.calls).toEqual(["mount", "update:0"]);
    expect(store.data.get("muxnexus.view")).toBe("debug");
    expect(changed).toBe(1);
  });

  test("hiding unmounts and stops its clock; the terminal choice never shows anything", () => {
    const env = fakeEnv();
    const rec = recordingView();
    const host = createViewHost({ slot: slot(), actions, views: { debug: () => rec.view }, changed: () => {}, store: memoryStore(), env });
    host.choose("debug");
    let ticks = 0;
    rec.host()!.tick(1, () => ticks++);
    env.fire();
    expect(ticks).toBe(1);
    host.show(false);
    expect(rec.calls).toContain("unmount");
    env.fire();
    expect(ticks).toBe(1);
    host.choose("terminal");
    host.show(true);
    expect(host.showing()).toBe(false);
  });

  test("choosing the terminal while the view is toggled off still repaints the page", () => {
    let changed = 0;
    const rec = recordingView();
    const host = createViewHost({ slot: slot(), actions, views: { debug: () => rec.view }, changed: () => changed++, store: memoryStore(), env: fakeEnv() });
    host.choose("debug");
    host.show(false);
    changed = 0;
    host.choose("terminal");
    expect(host.chosen()).toBe("terminal");
    expect(changed).toBe(1);
  });

  test("the clock pauses while the page is hidden", () => {
    const env = fakeEnv();
    const rec = recordingView();
    const host = createViewHost({ slot: slot(), actions, views: { debug: () => rec.view }, changed: () => {}, store: memoryStore(), env });
    host.choose("debug");
    let ticks = 0;
    rec.host()!.tick(1, () => ticks++);
    env.hiddenNow = true;
    env.fire();
    expect(ticks).toBe(0);
  });

  test("updates and reveals reach only a mounted view", () => {
    const rec = recordingView();
    const host = createViewHost({ slot: slot(), actions, views: { debug: () => rec.view }, changed: () => {}, store: memoryStore(), env: fakeEnv() });
    expect(host.reveal({ session: "$1", window: "@1" })).toBe(false);
    host.choose("debug");
    host.update(world, [{ kind: "appeared", ref: { session: "$1", window: "@1" }, at: 1 }]);
    expect(host.reveal({ session: "$1", window: "@1" })).toBe(true);
    expect(rec.calls).toEqual(["mount", "update:1", "reveal:@1"]);
  });
});

describe("full window", () => {
  test("a view that asks for the whole window has it only while it shows", () => {
    const { view } = recordingView();
    const host = createViewHost({
      slot: slot(), actions, views: { vault: () => ({ ...view, fullWindow: true }) }, changed() {},
      store: memoryStore({ "muxnexus.view": "vault" }), env: fakeEnv(),
    });
    expect(host.fullWindow()).toBe(false);
    host.show(true);
    expect(host.fullWindow()).toBe(true);
    host.show(false);
    expect(host.fullWindow()).toBe(false);
  });
});
