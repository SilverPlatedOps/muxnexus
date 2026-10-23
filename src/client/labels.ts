import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { splitCategory } from "../shared/category";

/** What a session is called on screen: the user's rename, else cmux's title, else tmux's name. */
export function sessionLabel(s: SessionInfo): string {
  return s.customName ?? s.label ?? s.name;
}

/** What a tab is called: the user's rename, else cmux's title, else tmux's window name. */
export function tabLabel(w: WindowInfo): string {
  return w.customName ?? w.label ?? w.name;
}

/** One window named from anywhere on the page: its session, then its tab. */
export function windowPlace(s: SessionInfo, w: WindowInfo): string {
  return `${sessionLabel(s)} › ${tabLabel(w)}`;
}

/**
 * A session's name as a path, its group first: "[Personal] Private" reads
 * "Personal / Private". A bare tag stays whole, not a group of nothing.
 */
export function crumbParts(label: string): { group: string | null; name: string } {
  const cat = splitCategory(label);
  return cat && cat.rest !== cat.category ? { group: cat.category, name: cat.rest } : { group: null, name: label };
}

/** That path to put on the page: the group quieter than the name, as the sidebar's header is. */
export function crumb(label: string): (Node | string)[] {
  const { group, name } = crumbParts(label);
  if (group === null) return [name];
  const tag = document.createElement("span");
  tag.className = "crumb-tag";
  tag.textContent = group;
  const sep = document.createElement("span");
  sep.className = "crumb-sep";
  sep.textContent = " / ";
  return [tag, sep, name];
}
