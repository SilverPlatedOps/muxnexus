import { categoryKey, splitCategory } from "../shared/category";

/**
 * A run of the sidebar: one category's sessions under a header, or a single
 * untagged session standing on its own.
 */
export interface Block<S> {
  /** The category as its first session spells it; null for an untagged session. */
  category: string | null;
  sessions: S[];
}

/**
 * The sidebar's sessions gathered by category. A category sits where its first
 * session does in the stored order, and holds its sessions in that order; an
 * untagged session keeps its own place. So the order the user drags into is
 * still the order within a group. To put one group above another, drag the
 * lower group's first session above the other group; dragging a group's first
 * session down only hands "first" to the next one, and the group stays put.
 */
export function groupSessions<S>(sessions: readonly S[], label: (s: S) => string): Block<S>[] {
  const blocks: Block<S>[] = [];
  const byKey = new Map<string, Block<S>>();
  for (const s of sessions) {
    const cat = splitCategory(label(s));
    if (!cat) {
      blocks.push({ category: null, sessions: [s] });
      continue;
    }
    const key = categoryKey(cat.category);
    let block = byKey.get(key);
    if (!block) {
      block = { category: cat.category, sessions: [] };
      byKey.set(key, block);
      blocks.push(block);
    }
    block.sessions.push(s);
  }
  return blocks;
}

/** The sessions in the order the sidebar shows them, collapsed groups included. */
export function visualOrder<S>(sessions: readonly S[], label: (s: S) => string): S[] {
  return groupSessions(sessions, label).flatMap((b) => b.sessions);
}

/**
 * The full order after a drag that could only see some rows. `full` is every
 * session in visual order; `visible` the ones drawn (a collapsed group's are
 * not); `moved` those same visible ones in their new order. Hidden sessions keep
 * their slots and the visible ones fill the rest in turn, so the whole list is
 * always sent: stamping only the visible ones would leave two sessions claiming
 * one position.
 */
export function mergeOrder(full: readonly string[], visible: readonly string[], moved: readonly string[]): string[] {
  const shown = new Set(visible);
  const next = [...moved];
  return full.map((name) => (shown.has(name) ? next.shift() ?? name : name));
}

/**
 * The full order after "Move up" or "Move down" on `name`. Inside a group a
 * session trades places with its neighbour there; an untagged session moves
 * past the whole neighbouring block, since stepping into a group would only be
 * undone by the grouping. Null when there is nowhere to go.
 */
export function moveWithinBlocks<S>(blocks: readonly Block<S>[], key: (s: S) => string, name: string, delta: -1 | 1): string[] | null {
  const bi = blocks.findIndex((b) => b.sessions.some((s) => key(s) === name));
  if (bi < 0) return null;
  const next = blocks.map((b) => [...b.sessions]);
  if (blocks[bi].category !== null) {
    const list = next[bi];
    const i = list.findIndex((s) => key(s) === name);
    const j = i + delta;
    if (j < 0 || j >= list.length) return null;
    [list[i], list[j]] = [list[j], list[i]];
  } else {
    const bj = bi + delta;
    if (bj < 0 || bj >= next.length) return null;
    [next[bi], next[bj]] = [next[bj], next[bi]];
  }
  return next.flat().map(key);
}
