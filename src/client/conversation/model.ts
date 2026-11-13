// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Card, CardOption, ConvError, ConvItem, StepResult } from "../../shared/conversation";
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

/** Each refusal in a sentence the user can act on. */
export const CONV_ERROR: Record<ConvError, string> = {
  "another-conversation": "This tab now holds another conversation",
  "prompt-changed": "This prompt changed: refresh",
  waiting: "The agent is waiting on a prompt: answer it first",
  "no-agent": "No agent in this tab",
  working: "The agent is busy; try Replace once it's idle",
};

/**
 * A card's options as buttons: `primary` the large ones, in the agent's order,
 * the first of them the main button; `secondary` (a lasting rule, a mode
 * switch) the quieter row, so a "don't ask again" is never the obvious tap.
 */
export function cardButtons(card: Card): { primary: CardOption[]; secondary: CardOption[] } {
  return { primary: card.options.filter((o) => !o.secondary), secondary: card.options.filter((o) => o.secondary) };
}

/** Longer than this, a permission's first detail line is cut in the title (the detail shows it whole). */
const TITLE_DETAIL = 80;

/** What the card asks, in plain words: a permission as `Allow Bash command: ls?`, anything else as the agent words it. */
export function cardTitle(card: Card): string {
  if (card.kind !== "permission") return card.title;
  const first = card.detail?.split("\n", 1)[0]?.trim() ?? "";
  if (!first) return `Allow ${card.title}?`;
  return `Allow ${card.title}: ${first.length > TITLE_DETAIL ? `${first.slice(0, TITLE_DETAIL - 1)}…` : first}?`;
}

/** How long a dialog not shown before waits before its buttons take a tap. */
export const CARD_ARM_MS = 400;

/**
 * When the card read as `fingerprint` starts taking taps: a dialog not on
 * screen before waits `CARD_ARM_MS`, so a second tap meant for the one before
 * (Q2 drawn where Q1's options were) answers nothing; the same dialog again
 * keeps the time it had.
 */
export function cardArmedAt(before: { fingerprint: string; at: number } | null, fingerprint: string, now: number): number {
  return before?.fingerprint === fingerprint ? before.at : now + CARD_ARM_MS;
}

/**
 * Whether a `takesText` option of `card` may be chosen with no words: a
 * permission's No and a Codex decline say No outright, while a question's or a
 * plan's field is no answer without them (the server refuses it).
 */
export function wordsOptional(card: Card): boolean {
  return card.kind === "permission" || card.kind === "approval";
}

/** The longest a link's label gets in the Links sheet. */
const LINK_LABEL = 48;

/**
 * Links as rows for the Links sheet: a GitHub pull request reads `owner/repo#12`,
 * anything else as its host and path, cut to 48 characters (the full address is
 * what Open and Copy use).
 */
export function linkRows(links: { url: string; pr: boolean }[]): { url: string; label: string; pr: boolean }[] {
  return links.map(({ url, pr }) => {
    const gh = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)/i.exec(url);
    if (gh) return { url, label: `${gh[1]}/${gh[2]}#${gh[3]}`, pr };
    let label = url;
    try {
      const u = new URL(url);
      label = u.host + (u.pathname === "/" ? "" : u.pathname);
    } catch {
      // Not an address the browser reads: shown as it is.
    }
    return { url, label: label.length > LINK_LABEL ? `${label.slice(0, LINK_LABEL - 1)}…` : label, pr };
  });
}
