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
  running: "",  // an open arc, drawn by .glyph.running::before in style.css; it turns on the tab only
  unread: "●",  // filled, but foreground rather than red
  seen: "○",    // the empty counterpart of unread's ●, as mail marks read against unread
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
 * The per-window dots after a session's name, one per window in tab order, or
 * none. The row's own glyph already carries the worst of its windows, so the
 * dots earn their space only when at least two windows have something to say:
 * a session with one agent among plain shells would just repeat its own glyph
 * a few pixels to the right. Plain windows keep their slot, so a dot still
 * points at a tab.
 */
export function windowDots(windows: readonly Pick<WindowInfo, "agent" | "unread">[]): Glyph[] {
  const glyphs = windows.map(windowGlyph);
  return glyphs.filter((g) => g !== "none").length > 1 ? glyphs : [];
}

/**
 * A profile's badge: its initial, and a slot number that picks its colour. The
 * slot is the profile's row in the quota panel (`profiles`, as the server
 * orders them, `personal` first), so the panel is the legend. A profile the
 * panel does not list gets no slot and draws in the plain text colour.
 *
 * Identity, not state: worn by every tab with an agent, since a tab is exactly
 * one agent, because "which account is this burning" is what the user balances
 * quota by. It replaced a yellow "mismatch" tag on the session row that showed
 * only when a `[Work]` session ran on personal; the user switches accounts on
 * purpose to balance them, so that was a hazard colour on a choice.
 */
export interface ProfileBadge {
  profile: string;
  initial: string;
  slot: number | null;
}

/**
 * Initials for a list of profiles: the first letter, or the first two when
 * another profile shares it (`work`/`wife` -> `WO`/`WI`), so the letter alone
 * always tells them apart.
 */
export function profileInitials(profiles: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of profiles) {
    const first = p.slice(0, 1).toUpperCase();
    const clash = profiles.some((q) => q !== p && q.slice(0, 1).toUpperCase() === first);
    out.set(p, clash ? p.slice(0, 2).toUpperCase() : first);
  }
  return out;
}

export function profileBadge(profile: string, profiles: readonly string[]): ProfileBadge {
  const known = profiles.includes(profile);
  const initials = profileInitials(known ? profiles : [...profiles, profile]);
  return { profile, initial: initials.get(profile) ?? profile.slice(0, 1).toUpperCase(), slot: known ? profiles.indexOf(profile) : null };
}

/**
 * The distinct profiles among a set of windows' agents, in panel order, so a
 * session with two agents on one account shows one badge and a session with
 * agents on two accounts shows two, in the same order everywhere.
 */
export function profileBadges(windows: readonly Pick<WindowInfo, "agent">[], profiles: readonly string[]): ProfileBadge[] {
  const used = new Set(windows.map((w) => w.agent?.profile).filter((p): p is string => p !== undefined));
  const ordered = [...profiles.filter((p) => used.has(p)), ...[...used].filter((p) => !profiles.includes(p)).sort()];
  return ordered.map((p) => profileBadge(p, profiles));
}

/** A glyph's tooltip, with the account the agent spends when it is known. */
export function agentTitle(w: Pick<WindowInfo, "agent" | "unread">): string {
  const base = GLYPH_TITLE[windowGlyph(w)];
  return w.agent?.profile ? `${base} · ${w.agent.profile} profile` : base;
}

/** Two or more agents in one git checkout, as one of them sees it. */
export interface Sharing {
  checkout: string;
  /** The other agents there, each as `label` names it. */
  others: string[];
}

/**
 * Every agent that shares its git checkout with another, by window id. Two
 * agents in one checkout edit, commit and switch branches under each other;
 * separate worktrees are separate checkouts, so they never count. A window is
 * counted once however many sessions link it -- the server already folds cmux's
 * tab sessions into their base, and the id is the window either way.
 */
export function sharedCheckouts<S extends { windows: readonly WindowInfo[] }>(
  sessions: readonly S[],
  label: (s: S, w: WindowInfo) => string,
): Map<string, Sharing> {
  const byCheckout = new Map<string, Map<string, string>>();
  for (const s of sessions) {
    for (const w of s.windows) {
      const checkout = w.agent?.checkout;
      if (!checkout) continue;
      const there = byCheckout.get(checkout) ?? new Map<string, string>();
      if (!there.has(w.id)) there.set(w.id, label(s, w));
      byCheckout.set(checkout, there);
    }
  }
  const out = new Map<string, Sharing>();
  for (const [checkout, there] of byCheckout) {
    if (there.size < 2) continue;
    for (const id of there.keys()) {
      out.set(id, { checkout, others: [...there].filter(([other]) => other !== id).map(([, l]) => l) });
    }
  }
  return out;
}

/** What a tooltip says about a shared checkout. Home is `~`, as a shell prompt shows it. */
export function sharingTitle(sh: Sharing): string {
  const where = sh.checkout.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  return `Shared checkout ${where} — also ${sh.others.join(", ")}`;
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
