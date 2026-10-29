// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Store } from "./display";
import type { WorldEvent } from "./transitions";
import type { WindowRef, World } from "./world";
import type { WorldActions } from "./world-actions";

/**
 * Where an alternative view lives: the main area, in place of the terminal,
 * which stays attached underneath. One view is mounted at a time; it gets the
 * world, the events between worlds, the actions, its own prefs, and a clock
 * that stops while the page is hidden. What it draws is its own business.
 */

export type ViewName = "terminal" | "debug";

/** What the Display modal offers, in order. */
export const VIEW_CHOICES: readonly { name: ViewName; title: string }[] = [
  { name: "terminal", title: "Terminal" },
  { name: "debug", title: "Debug" },
];

const CHOSEN_KEY = "muxnexus.view";

export interface ScopedStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** A view's own preferences, under `muxnexus.view.<view>.`: nothing it keeps can collide with another's. */
export function scopedStore(view: string, store?: Store): ScopedStore {
  const full = (key: string) => `muxnexus.view.${view}.${key}`;
  return {
    get(key) {
      try { return (store ?? localStorage).getItem(full(key)); } catch { return null; }
    },
    set(key, value) {
      try { (store ?? localStorage).setItem(full(key), value); } catch { /* this browser forgets */ }
    },
  };
}

export function loadChosen(store?: Store): ViewName {
  try {
    const v = (store ?? localStorage).getItem(CHOSEN_KEY);
    return VIEW_CHOICES.some((c) => c.name === v) ? (v as ViewName) : "terminal";
  } catch {
    return "terminal";
  }
}

function saveChosen(name: ViewName, store?: Store) {
  try { (store ?? localStorage).setItem(CHOSEN_KEY, name); } catch { /* chosen for this page */ }
}

export interface View {
  mount(host: ViewHost): void;
  /** After every world rebuild. Patch in place: a rebuild per push steals focus and scroll. */
  update(world: World, events: readonly WorldEvent[]): void;
  /** ⌘J while the view shows. Opening the window is the plain answer. */
  reveal(ref: WindowRef): void;
  unmount(): void;
}

export interface ViewHost {
  root: HTMLElement;
  actions: WorldActions;
  prefs: ScopedStore;
  reducedMotion(): boolean;
  now(): number;
  /** Call `cb` `fps` times a second while the page is visible; the returned function stops it. */
  tick(fps: number, cb: (now: number) => void): () => void;
}

/** The browser, as the host uses it; swapped for a fake under test. */
export interface HostEnv {
  hidden(): boolean;
  reducedMotion(): boolean;
  now(): number;
  every(ms: number, cb: () => void): () => void;
}

const browserEnv = (): HostEnv => ({
  hidden: () => document.visibilityState === "hidden",
  reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  now: () => Date.now(),
  every(ms, cb) {
    const t = setInterval(cb, ms);
    return () => clearInterval(t);
  },
});

export interface ViewController {
  chosen(): ViewName;
  /** From the Display modal: remembered, and shown at once unless it is the terminal. */
  choose(name: ViewName): void;
  showing(): boolean;
  /** The top bar's toggle between the terminal and the chosen view. */
  show(on: boolean): void;
  update(world: World, events: readonly WorldEvent[]): void;
  /** Whether a view took it; when not, ⌘J does what it always did. */
  reveal(ref: WindowRef): boolean;
}

export function createViewHost(opts: {
  slot: HTMLElement;
  actions: WorldActions;
  views: Partial<Record<ViewName, () => View>>;
  /** `showing()` flipped: the page repaints its main area. */
  changed: () => void;
  store?: Store;
  env?: HostEnv;
}): ViewController {
  const env = opts.env ?? browserEnv();
  let chosen = loadChosen(opts.store);
  let mounted: { view: View; stops: Set<() => void> } | null = null;
  let world: World | null = null;

  function mount(): boolean {
    const make = opts.views[chosen];
    if (!make || mounted) return false;
    const view = make();
    const stops = new Set<() => void>();
    mounted = { view, stops };
    opts.slot.hidden = false;
    view.mount({
      root: opts.slot,
      actions: opts.actions,
      prefs: scopedStore(chosen, opts.store),
      reducedMotion: env.reducedMotion,
      now: env.now,
      tick(fps, cb) {
        const stop = env.every(1000 / fps, () => { if (!env.hidden()) cb(env.now()); });
        stops.add(stop);
        return () => { stop(); stops.delete(stop); };
      },
    });
    if (world) view.update(world, []);
    return true;
  }

  function unmount(): boolean {
    if (!mounted) return false;
    for (const stop of mounted.stops) stop();
    mounted.view.unmount();
    mounted = null;
    opts.slot.replaceChildren();
    opts.slot.hidden = true;
    return true;
  }

  return {
    chosen: () => chosen,
    choose(name) {
      if (name === chosen) return;
      unmount();
      chosen = name;
      saveChosen(name, opts.store);
      if (name !== "terminal") mount();
      // Always: the top bar's toggle follows the choice even when nothing was showing.
      opts.changed();
    },
    showing: () => mounted !== null,
    show(on) {
      if (on ? mount() : unmount()) opts.changed();
    },
    update(next, events) {
      world = next;
      mounted?.view.update(next, events);
    },
    reveal(ref) {
      if (!mounted) return false;
      mounted.view.reveal(ref);
      return true;
    },
  };
}
