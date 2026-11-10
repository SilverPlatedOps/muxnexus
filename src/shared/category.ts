// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * A session's category, from the tag its name starts with: `[Work] Banner
 * Migration` is Banner Migration in Work. The tag is the user's own habit,
 * typed into names to group the sidebar by hand; reading it back means the
 * sidebar can group for them without a second place to keep the grouping.
 *
 * `rest` is what the row shows under its group's header. A name that is only a
 * tag, `[Personal]`, is its own category's catch-all and shows the category.
 */
export function splitCategory(label: string): { category: string; rest: string } | null {
  const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(label.trim());
  if (!m) return null;
  const category = m[1].trim();
  if (category === "") return null;
  return { category, rest: m[2].trim() || category };
}

/** Categories match whatever their case: `[work]` joins `[Work]`. */
export function categoryKey(category: string): string {
  return category.toLowerCase();
}

/** The label with its group set to `category`, or untagged for null. */
export function retag(label: string, category: string | null): string {
  const rest = editableName(label);
  return category ? `[${category}] ${rest}` : rest;
}

/** What a rename field shows: the name without its group. */
export function editableName(label: string): string {
  return splitCategory(label)?.rest ?? label.trim();
}

/**
 * The full name after typing `typed` into a rename field: the group stays, so
 * renaming ELF in Work keeps it in Work -- unless a tag was typed, which wins.
 */
export function renameKeepingTag(label: string, typed: string): string {
  if (splitCategory(typed)) return typed.trim();
  const cat = splitCategory(label);
  return cat ? `[${cat.category}] ${typed.trim()}` : typed.trim();
}
