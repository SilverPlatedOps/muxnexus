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
  setNotice(n: SwapNotice): void;
  window(id: string): { text: string; tone: ChipTone } | null;
  session(windows: readonly WindowInfo[]): { text: string; tone: "" } | null;
  clear(): void;
}

export function createMemoryStore(): MemoryStore {
  let table = new Map<string, WindowMemory>();
  let notice: SwapNotice | null = null;
  return {
    set(m, tmuxServer) {
      table = m.tmuxServer !== null && m.tmuxServer === tmuxServer ? new Map(m.windows.map((w) => [w.windowId, w])) : new Map();
    },
    setNotice(n) {
      notice = n;
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
