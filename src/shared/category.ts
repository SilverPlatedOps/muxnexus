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
