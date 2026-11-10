// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

const THEME_KEY = "muxnexus.termTheme";
/** The palette: `?theme=` when given, else the one picked in Settings, else dark. */
export function termTheme(): "dark" | "light" {
  if (typeof location === "undefined") return "dark";
  const asked = new URLSearchParams(location.search).get("theme");
  if (asked === "light" || asked === "dark") return asked;
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
}
/** Saved for the next load: the palette is fixed when the terminals are made. */
export function setTermTheme(t: "dark" | "light"): void {
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private window */ }
}
