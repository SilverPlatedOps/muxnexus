// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Card, CardOption, ConvError, ConvItem, StepResult } from "../../shared/conversation";
import type { ClientMessage, SessionInfo, WindowInfo } from "../../shared/protocol";
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

/**
 * The messages that attach a terminal, size it or type into it: a conversation
 * page sends none of them. A note's ⌘Enter (`paste-to-window`) goes to the
 * open conversation's text box instead, to be sent from there.
 */
export const TERMINAL_MESSAGES: ReadonlySet<string> = new Set(["attach", "attach-view", "select-window", "resize", "scroll", "paste-to-window"]);

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
/** The same, turned to what was tried. */
const TRIED: Record<string, string> = { Ran: "Run", Edited: "Edit", Wrote: "Write", Read: "Read", Searched: "Search" };

/** A step's line: as the server words it, or for one that failed or was denied what was tried (`Write note.txt`), never `Wrote`. */
export function stepLine(it: Extract<ConvItem, { kind: "step" }>): string {
  if (!it.result || it.result.ok) return it.summary;
  const verb = /^(\S+) (.+)$/.exec(it.summary);
  return verb && TRIED[verb[1]!] ? `${TRIED[verb[1]!]} ${verb[2]}` : it.summary;
}

export type Step = Extract<ConvItem, { kind: "step" }>;

/**
 * The list as shown: two or more steps in a row fold into one run, everything else stands alone. A step `apart` says
 * to (one that sent files, its pictures kept in sight) breaks the run it would be in.
 */
export function foldSteps(items: ConvItem[], apart: (s: Step) => boolean): (ConvItem | Step[])[] {
  const out: (ConvItem | Step[])[] = [];
  let run: Step[] = [];
  const end = () => {
    if (run.length > 1) out.push(run);
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (it.kind === "step" && !apart(it)) run.push(it);
    else {
      end();
      out.push(it);
    }
  }
  end();
  return out;
}

/** What a run calls each kind of step, one and several, by the verb the server words its line with. */
const NOUN: Record<string, [string, string]> = {
  Ran: ["command", "commands"], Edited: ["edit", "edits"], Wrote: ["edit", "edits"], Read: ["file read", "files read"], Searched: ["search", "searches"],
};

const EARLIER: [string, string] = ["earlier step", "earlier steps"];

/** A run's folded line: `2 commands, 1 file read, TaskUpdate ×2`, kinds in the order first done. */
export function runLine(steps: Step[]): string {
  const kinds = new Map<string, { n: number; noun?: [string, string] }>();
  for (const s of steps) {
    // A step listed from its result alone (its call too far back to read) has no tool to name.
    const noun = NOUN[/^(\S+) /.exec(s.summary)?.[1] ?? ""] ?? (s.tool ? undefined : EARLIER);
    const key = noun ? noun[1] : s.tool;
    const k = kinds.get(key);
    if (k) k.n++;
    else kinds.set(key, { n: 1, noun });
  }
  return [...kinds].map(([tool, { n, noun }]) => (noun ? `${n} ${noun[n === 1 ? 0 : 1]}` : n === 1 ? tool : `${tool} ×${n}`)).join(", ");
}

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

/** What the text box holds, and the conversation it was written for (null: none yet). */
export interface Composed { text: string; for: string | null }

/**
 * The text box once it holds `text`, with `showing` the conversation on
 * screen: words begun in an empty box are for `showing`, more words keep the
 * conversation they were begun for (a /clear at the desk doesn't move them),
 * and an empty box is for none.
 */
export function composedAs(before: Composed, text: string, showing: string | null): Composed {
  if (text.trim() === "") return { text, for: null };
  return { text, for: before.text.trim() === "" ? showing : before.for };
}

/** Whether the words were written for another conversation than the one the tab shows now (known). */
export function writtenElsewhere(c: Composed, showing: string | null): boolean {
  return showing !== null && c.text.trim() !== "" && c.for !== showing;
}

/**
 * What Send does: the words go to the conversation they were written for,
 * or, written for another than the tab shows now, only after the user says
 * so (`ask`). Null: nothing to send, or nothing to send it to.
 */
export function sendAs(c: Composed, showing: string | null): { send: string } | { ask: true } | null {
  if (c.text.trim() === "" || showing === null) return null;
  return c.for === showing ? { send: c.for } : { ask: true };
}

/**
 * Whether an answer (a page, search hits, links) read for `read` is for what
 * the view shows now: the same tab and the same conversation. One read before
 * a /clear or a tab switch is dropped.
 */
export function readForShown(read: { windowId: string; conversation: string | null }, shown: { windowId: string | null; conversation: string | null }): boolean {
  return read.windowId === shown.windowId && read.conversation === shown.conversation;
}

/**
 * Whether a search hit for `find` in `item` (the item listed under the hit's
 * id, if any) shows once it is opened: not for a step listed without its
 * result when the match is in neither its line nor its input, so in the
 * result, on a page not loaded (the page around the hit is read instead).
 * Matched as the server matches: ignoring case.
 */
export function hitShown(item: ConvItem | undefined, find: string): boolean {
  if (!item) return false;
  if (item.kind !== "step" || item.result) return true;
  const q = find.toLowerCase();
  return item.summary.toLowerCase().includes(q) || item.input.toLowerCase().includes(q);
}

/** The page requests out: an older page (`more`) and the page around a search hit (`around`), by request id. */
export interface PagesOut { more: string | null; around: string | null; start: number }

/**
 * Which request a `conv-page` answers, by the id it echoes: only one still
 * out counts. A jump tapped after another replaces it, so the first jump's
 * page, coming late, is dropped rather than shown for the second's target.
 */
export function pageFor(m: { req: string; start: number; end: number }, out: PagesOut): "more" | "around" | null {
  if (out.around !== null && m.req === out.around) return "around";
  if (out.more !== null && m.req === out.more) return "more";
  return null;
}

/**
 * A step's text as its body shows it: cut to `max` characters from the start,
 * or, when `query` (a search's, matched as the server matches it: ignoring
 * case) is found only past that, to a window of `max` around the match. Each
 * cut end says how much is cut. `at`: where the match is in the text shown.
 */
export function clipAround(text: string, max: number, query?: string): { text: string; at?: number } {
  const found = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const len = query?.length ?? 0;
  if (found < 0 || found + len <= max) {
    const cut = text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;
    return found < 0 ? { text: cut } : { text: cut, at: found };
  }
  const hi = Math.min(text.length, found - Math.floor((max - len) / 2) + max);
  const lo = Math.max(0, hi - max);
  const head = lo > 0 ? `… ${lo} characters before\n` : "";
  const tail = hi < text.length ? `\n… ${text.length - hi} more characters` : "";
  return { text: `${head}${text.slice(lo, hi)}${tail}`, at: head.length + found - lo };
}

/** Each refusal in a sentence the user can act on. */
export const CONV_ERROR: Record<ConvError, string> = {
  "another-conversation": "This tab now holds another conversation",
  "prompt-changed": "This prompt changed: refresh",
  waiting: "The agent is waiting on a prompt: answer it first",
  "no-agent": "No agent in this tab",
  working: "The agent is busy; try Replace once it's idle",
  // The words may have gone into the prompt and stayed there, or never shown (a survey took a digit, a leading `!`
  // made it Claude's bash mode): only Screen tells which.
  unsent: "Not sent. Your words may be in the prompt at the desk: check Screen.",
  attachment: "Not sent: an attached file is no longer on the server. Remove it and attach it again.",
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

/** A card as drawn, and the conversation it was read for (the `conv-card`'s). */
export interface ShownCard { card: Card; for: string | null }

/**
 * The `conv-answer` for choosing `option` (with `words`, for one that takes
 * them) on the card shown, in tab `target.windowId`: bound to the
 * conversation the card was read for, not whichever the view shows by the
 * tap, so a card left over from before a /clear can't answer the new
 * conversation's prompt (the server refuses it). Null for a card read for
 * none, but a trust question: an agent asks it before it has a conversation,
 * and the server presses only while that question, by its fingerprint, is up.
 */
export function answerMessage(
  shown: ShownCard, target: { windowId: string; conversation: string | null }, req: string, option: CardOption, words?: string,
): Extract<ClientMessage, { t: "conv-answer" }> | null {
  if (shown.for === null && shown.card.kind !== "trust") return null;
  const text = option.takesText && words?.trim() ? words : undefined;
  return {
    t: "conv-answer", req, windowId: target.windowId, conversation: shown.for,
    fingerprint: shown.card.fingerprint, option: option.index, ...(text !== undefined ? { text } : {}),
  };
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
