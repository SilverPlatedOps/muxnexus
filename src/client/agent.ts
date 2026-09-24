import type { AgentInfo, WindowInfo } from "../shared/protocol";

/**
 * What a row says about the agents inside it.
 *
 * Five appearances, one column wide, ranked by how much they want you. The
 * ranking is the whole point: a session's row shows the worst of its windows,
 * so one glance down the sidebar finds the thing that is blocked.
 */
export type Glyph = "input" | "running" | "unread" | "seen" | "none";

const RANK: Record<Glyph, number> = { input: 0, running: 1, unread: 2, seen: 3, none: 4 };

/** The character for each. Red is applied by CSS, and only to `input`. */
export const GLYPH: Record<Glyph, string> = {
  input: "●",   // filled circle, the only red thing in the sidebar
  running: "",  // the ASCII spinner is drawn by .glyph.running::before in style.css
  unread: "●",  // filled, but foreground rather than red
  seen: "·",    // middle dot
  none: " ",    // a space that still takes its column
};

export const GLYPH_TITLE: Record<Glyph, string> = {
  input: "waiting for you",
  running: "running",
  unread: "finished — not looked at yet",
  seen: "idle",
  none: "no agent",
};

/**
 * A window's appearance. `unread` outranks a plain `done` because "it finished
 * while you were away" is the second most useful thing a glance can say; a
 * window with a bell but no agent still shows unread, since something rang.
 */
export function windowGlyph(w: Pick<WindowInfo, "agent" | "unread">): Glyph {
  if (w.agent?.state === "input") return "input";
  if (w.agent?.state === "running") return "running";
  if (w.unread) return "unread";
  return w.agent ? "seen" : "none";
}

export function worstGlyph(glyphs: readonly Glyph[]): Glyph {
  let worst: Glyph = "none";
  for (const g of glyphs) if (RANK[g] < RANK[worst]) worst = g;
  return worst;
}

export function sessionGlyph(windows: readonly Pick<WindowInfo, "agent" | "unread">[]): Glyph {
  return worstGlyph(windows.map(windowGlyph));
}

/**
 * The agent a session's row is speaking for: the one that has been waiting
 * longest, so "needs you · 40m" is the oldest wait and not an arbitrary one.
 */
export function sessionAgent(windows: readonly Pick<WindowInfo, "agent" | "unread">[]): AgentInfo | undefined {
  const glyph = sessionGlyph(windows);
  if (glyph !== "input" && glyph !== "running") return undefined;
  const matching = windows
    .map((w) => w.agent)
    .filter((a): a is AgentInfo => a?.state === glyph);
  return matching.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0];
}

/**
 * How long a row has been in its state: "4m", "1h12", "2d03". Blank under a
 * minute -- a prompt that just appeared needs no duration, and a number
 * flickering between "0m" and "1m" draws the eye for nothing.
 */
export function formatElapsed(since: string | undefined, now: number): string {
  if (!since) return "";
  const at = Date.parse(since);
  if (Number.isNaN(at)) return "";
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return "";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, "0")}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 === 0 ? "" : String(hours % 24).padStart(2, "0")}`;
}

/** How many sessions are blocked on the human -- the number on the hamburger. */
export function needsYouCount(sessions: readonly { windows: WindowInfo[] }[]): number {
  return sessions.filter((s) => sessionGlyph(s.windows) === "input").length;
}

/**
 * The session ⌘J should jump to: the next one needing you after `current`,
 * wrapping; failing that the next unread. Returns null when nothing wants you,
 * so the key does nothing rather than moving you somewhere arbitrary.
 */
export function nextAttention(
  sessions: readonly { name: string; windows: WindowInfo[] }[],
  current: string | null,
): string | null {
  const from = Math.max(0, sessions.findIndex((s) => s.name === current));
  const rotated = [...sessions.slice(from + 1), ...sessions.slice(0, from + 1)];
  for (const want of ["input", "unread"] as const) {
    const hit = rotated.find((s) => sessionGlyph(s.windows) === want);
    if (hit) return hit.name;
  }
  return null;
}
