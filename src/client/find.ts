/**
 * The sidebar's search: sessions by their name, windows by theirs or by the git
 * checkout their agent works in. Every word typed has to be found, in any case,
 * the way the notes search reads.
 */
import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { sessionLabel, tabLabel } from "./labels";

export const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** The last part of a checkout's path: `cms-backend`, the name a repo goes by. */
export function folderOf(w: WindowInfo): string {
  return w.agent?.checkout?.split("/").filter(Boolean).pop() ?? "";
}

export interface SessionHit<S extends SessionInfo = SessionInfo> {
  session: S;
  /** The windows worth a row of their own: found by something of their own, not just their session's name. */
  windows: WindowInfo[];
}

/**
 * The sessions a query finds, in the order given. A window counts when every
 * word is in its session's name, its own name or its folder taken together, and
 * at least one of them is its own: "refactor cms" finds the Refactor session's
 * windows in cms-backend, where "refactor" alone finds the session and stops.
 */
export function findSessions<S extends SessionInfo>(sessions: readonly S[], query: string): SessionHit<S>[] {
  const ws = queryWords(query);
  if (!ws.length) return sessions.map((session) => ({ session, windows: [] }));
  const hits: SessionHit<S>[] = [];
  for (const s of sessions) {
    const name = sessionLabel(s).toLowerCase();
    const windows = s.windows.filter((w) => {
      const own = `${tabLabel(w)} ${folderOf(w)}`.toLowerCase();
      return ws.every((x) => name.includes(x) || own.includes(x)) && ws.some((x) => own.includes(x));
    });
    if (windows.length || ws.every((x) => name.includes(x))) hits.push({ session: s, windows });
  }
  return hits;
}
