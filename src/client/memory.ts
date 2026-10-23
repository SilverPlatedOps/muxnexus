import type { ServerMessage, SwapNotice, WindowInfo, WindowMemory } from "../shared/protocol";
import { formatMem } from "./system";

/**
 * Each tab's memory, for the chips the Display switch puts on tabs and session
 * rows. A reading counts only under the tmux server it was taken from: tmux
 * hands its window ids out again after a restart, and an old table would put
 * one tab's size on another.
 *
 * The chips are grey. One takes colour only while memory is tight, and only on
 * a tab the server named among the biggest holders -- colour means trouble.
 */

export type ChipTone = "" | "warning" | "critical";

export interface MemoryStore {
  set(m: Extract<ServerMessage, { t: "memory" }>, tmuxServer: string | null): void;
  /** True when it changed some chip's colour: the one thing a notice can change on a tab. */
  setNotice(n: SwapNotice): boolean;
  window(id: string): { text: string; tone: ChipTone } | null;
  session(windows: readonly WindowInfo[]): { text: string; tone: "" } | null;
  clear(): void;
}

export function createMemoryStore(): MemoryStore {
  let table = new Map<string, WindowMemory>();
  let notice: SwapNotice | null = null;
  /** Which tabs are coloured, and how: what a repaint would change. */
  let toneKey = "";
  return {
    set(m, tmuxServer) {
      table = m.tmuxServer !== null && m.tmuxServer === tmuxServer ? new Map(m.windows.map((w) => [w.windowId, w])) : new Map();
    },
    setNotice(n) {
      notice = n;
      const tight = n.severity === "busy" || n.severity === "urgent";
      const key = tight ? `${n.severity} ${n.holders.filter((h) => h.kind === "tab").map((h) => h.name).sort().join(",")}` : "";
      const changed = key !== toneKey;
      toneKey = key;
      return changed;
    },
    window(id) {
      const w = table.get(id);
      if (!w) return null;
      const tight = notice?.severity === "busy" || notice?.severity === "urgent";
      const holder = tight && notice!.holders.some((h) => h.kind === "tab" && h.name === id);
      return { text: formatMem(w.bytes, w.processes, w.unreadable), tone: holder ? (notice!.severity === "urgent" ? "critical" : "warning") : "" };
    },
    session(windows) {
      const ws = windows.map((w) => table.get(w.id)).filter((w): w is WindowMemory => w !== undefined);
      if (ws.length === 0) return null;
      const sum = (k: "bytes" | "processes" | "unreadable") => ws.reduce((n, w) => n + w[k], 0);
      return { text: formatMem(sum("bytes"), sum("processes"), sum("unreadable")), tone: "" };
    },
    clear() {
      table = new Map();
    },
  };
}

/** The page's one store, which the tabs and the sidebar read as they draw. */
export const memoryStore = createMemoryStore();
