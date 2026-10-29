// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * Outside the building: the time of day is the real one, read off the local
 * clock; the weather is a setting the viewer picks, and is named as one --
 * nothing here pretends to know the sky over the user's head.
 */

export type SkyPhase = "dawn" | "day" | "dusk" | "night";
export type Weather = "clear" | "rain" | "snow" | "storm" | "fog";
export const WEATHERS: readonly Weather[] = ["clear", "rain", "snow", "storm", "fog"];

export function skyAt(now: Date): SkyPhase {
  const h = now.getHours();
  if (h >= 5 && h < 7) return "dawn";
  if (h >= 7 && h < 17) return "day";
  if (h >= 17 && h < 19) return "dusk";
  return "night";
}
