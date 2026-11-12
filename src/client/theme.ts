// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * Light or dark, for the whole page and every terminal at once. The choice is
 * kept per browser under the key the terminal-only switch used, so a saved
 * "light" or "dark" carries over; "system" follows the device. index.html's
 * head script applies the same rule before the first paint -- keep the two in
 * step (test/theme.test.ts runs both).
 */
export type Appearance = "dark" | "light";
export type ThemeChoice = Appearance | "system";

export const THEME_KEY = "muxnexus.termTheme";
const OS_DARK = "(prefers-color-scheme: dark)";

/** `?theme=light|dark` when given, else the saved choice, "system" following the OS; nothing saved stays dark. */
export function resolveAppearance(saved: string | null, asked: string | null, osDark: boolean): Appearance {
  const pick = asked === "light" || asked === "dark" ? asked : saved;
  return pick === "light" || (pick === "system" && !osDark) ? "light" : "dark";
}

/** What Settings shows: what the page follows, the address's `?theme=` or else the saved choice; dark when neither. */
export function themeChoice(): ThemeChoice {
  const asked = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("theme");
  const pick = asked === "light" || asked === "dark" ? asked : readSaved();
  return pick === "light" || pick === "system" ? pick : "dark";
}

/** A choice made where storage is refused (a private window): it holds for this page only. */
let unsaved: ThemeChoice | null = null;

function readSaved(): string | null {
  if (unsaved) return unsaved;
  try { return localStorage.getItem(THEME_KEY); } catch { return null; /* private window */ }
}

function resolveNow(): Appearance {
  if (typeof location === "undefined") return "dark";
  return resolveAppearance(readSaved(), new URLSearchParams(location.search).get("theme"), matchMedia(OS_DARK).matches);
}

let current: Appearance = resolveNow();
const listeners = new Set<(a: Appearance) => void>();

/** The appearance on screen now. */
export function appearance(): Appearance {
  return current;
}

/** Called on every switch; returns the unsubscribe. */
export function onAppearance(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply(): void {
  const next = resolveNow();
  if (typeof document !== "undefined") document.documentElement.dataset.theme = next;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn(next);
}

/** Saved and shown at once. A `?theme=` in the address would outrank it, so it is dropped. */
export function setThemeChoice(choice: ThemeChoice): void {
  try { localStorage.setItem(THEME_KEY, choice); } catch { unsaved = choice; }
  const url = new URL(location.href);
  if (url.searchParams.has("theme")) {
    url.searchParams.delete("theme");
    history.replaceState(history.state, "", url);
  }
  apply();
}

if (typeof window !== "undefined") {
  apply();
  // The OS switching (at sunset, say) only matters while the choice is "system"; apply() resolves that.
  matchMedia(OS_DARK).addEventListener("change", apply);
}
