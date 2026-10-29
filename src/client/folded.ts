// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Store } from "./display";

const KEY = "muxnexus.collapsed";

/**
 * Which groups this browser keeps folded, shared by the sidebar and any view:
 * folding a group in one folds it in the other, so each subscribes. A
 * convenience, so a failed read is just "none" and a failed write still folds
 * for the life of the page.
 */
export interface Folded {
  has(key: string): boolean;
  set(key: string, folded: boolean): void;
  toggle(key: string): void;
  keys(): ReadonlySet<string>;
  subscribe(fn: () => void): () => void;
}

function load(store?: Store): Set<string> {
  try {
    const raw = JSON.parse((store ?? localStorage).getItem(KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function createFolded(store?: Store): Folded {
  const keys = load(store);
  const listeners = new Set<() => void>();
  function set(key: string, folded: boolean) {
    if (keys.has(key) === folded) return;
    if (folded) keys.add(key);
    else keys.delete(key);
    try { (store ?? localStorage).setItem(KEY, JSON.stringify([...keys])); } catch { /* not remembered, still folded */ }
    for (const fn of listeners) fn();
  }
  return {
    has: (key) => keys.has(key),
    set,
    toggle: (key) => set(key, !keys.has(key)),
    keys: () => keys,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
