// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ConvItem, StepResult } from "../../shared/conversation";
import type { SessionInfo, WindowInfo } from "../../shared/protocol";
import { formatElapsed } from "../agent";

/**
 * The tab the conversation view shows for a workspace: the one asked for if it
 * still exists, else one waiting on the user, else the one tmux has active (the
 * desk's choice, only read), else the first.
 */
export function conversationWindow(windows: readonly WindowInfo[], wanted: string | null): string | null {
  if (wanted && windows.some((w) => w.id === wanted)) return wanted;
  return (windows.find((w) => w.agent?.state === "input") ?? windows.find((w) => w.active) ?? windows[0])?.id ?? null;
}

/**
 * The sessions with `windowId` marked active in `session` instead of tmux's own
 * choice: a phone picking a tab must not move the desk's, so the tab strip
 * follows the page's pick while tmux's stays as the desk left it.
 */
export function withLocalActive(sessions: SessionInfo[], session: string | null, windowId: string | null): SessionInfo[] {
  if (!session || !windowId) return sessions;
  return sessions.map((s) => (s.name === session ? { ...s, windows: s.windows.map((w) => ({ ...w, active: w.id === windowId })) } : s));
}

/** The messages that attach a terminal, size it or type into it: a conversation page sends none of them. */
export const TERMINAL_MESSAGES: ReadonlySet<string> = new Set(["attach", "attach-view", "select-window", "resize", "scroll"]);

/**
 * What the screen holds after `incoming` arrives: appended (what the agent wrote
 * since) or prepended (an older page). Ids already listed are not listed twice.
 * A `step-result` completes its step, whether listed or in the same batch; one
 * whose step isn't loaded is no item (the view keeps it for the page that has it).
 */
export function mergeItems(list: ConvItem[], incoming: (ConvItem | StepResult)[], where: "append" | "prepend"): ConvItem[] {
  const seen = new Set(list.map((i) => i.id));
  const added: ConvItem[] = [];
  const results: StepResult[] = [];
  for (const it of incoming) {
    if (it.kind === "step-result") results.push(it);
    else if (!seen.has(it.id)) {
      seen.add(it.id);
      added.push(it);
    }
  }
  const out = where === "append" ? [...list, ...added] : [...added, ...list];
  if (results.length === 0) return out;
  const byId = new Map(results.map((r) => [r.id, r]));
  return out.map((it) => {
    const r = it.kind === "step" ? byId.get(it.id) : undefined;
    return r ? { ...it, result: { ok: r.ok, output: r.output, at: r.at } } : it;
  });
}

/** A step's line in the past tense, as the server words it, turned to what is happening now. */
const NOW: Record<string, string> = { Ran: "Running", Edited: "Editing", Wrote: "Writing", Read: "Reading", Searched: "Searching" };

/**
 * The working line's words: the step still running and for how long
 * (`Running mvn -q test · 2m`), or null when none is. Only the steps at the very
 * end count: one that never got a result with the agent writing after it is
 * not what runs now.
 */
export function workingLine(items: ConvItem[], now: number): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== "step") return null;
    if (it.result) continue;
    const verb = /^(\S+) (.+)$/.exec(it.summary);
    const words = verb && NOW[verb[1]!] ? `${NOW[verb[1]!]} ${verb[2]}` : `Running ${it.summary}`;
    const elapsed = formatElapsed(it.at, now);
    return elapsed ? `${words} · ${elapsed}` : words;
  }
  return null;
}

/** Whether the list is scrolled to its end, give or take 40px: only then do new items scroll it. */
export function stuckToBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 40;
}
