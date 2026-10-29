// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/** Keyed, in-place DOM patching shared by the views: a rebuild per push steals focus and scroll. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(cls: string, text?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

/** Only touch the DOM when the text changed: a needless write is a needless mutation. */
export function setText(e: Element, text: string) {
  if (e.textContent !== text) e.textContent = text;
}

/**
 * Put `items`' elements under `parent` in order, reusing each one's element by
 * key. Children are replaced only when the order changed, so an element that
 * stayed keeps its focus and the list keeps its scroll.
 */
export function place<T>(
  parent: HTMLElement,
  items: readonly T[],
  key: (t: T) => string,
  cache: Map<string, HTMLElement>,
  seen: Set<string>,
  make: () => HTMLElement,
  patch: (e: HTMLElement, t: T) => void,
): void {
  const want = items.map((t) => {
    const k = key(t);
    seen.add(k);
    let e = cache.get(k);
    if (!e) {
      e = make();
      cache.set(k, e);
    }
    patch(e, t);
    return e;
  });
  const same = want.length === parent.children.length && want.every((e, i) => parent.children[i] === e);
  if (!same) parent.replaceChildren(...want);
}

export function sweep(cache: Map<string, HTMLElement>, seen: Set<string>) {
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
}
