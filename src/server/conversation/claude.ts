// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import type { ConvAdapter, KeyPlan } from "./adapter";
import { afterHeader, clip, inputText, peerOf, plain, stepSummary, textOf } from "./items";
import {
  allDim, blank, block, cardOption, findRow, findRowBack, fingerprint, highlighted, indentOf, isRule, lastFilled, lasting, nextFilled,
  optionRow, paneLines, scanOptions, UNREADABLE, type PaneLine, type PaneOption, type PaneRead,
} from "./pane";

type Out = (ConvItem | StepResult)[];

const INTERRUPT = /^\[Request interrupted by user/;

/** What the first `<tag>…</tag>` in `text` holds, or "". */
const inside = (text: string, tag: string): string => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? "";

/**
 * What the harness writes in the user's turn, known by the tag it starts
 * with: a slash command and its output, a shell command typed with `!` and
 * what it printed (`parent` is the command's row), a background task's or
 * another agent's news. Undefined for anything else, the user's own words.
 */
function harness(id: string, at: string, text: string, parent: string | undefined): Out | undefined {
  switch (/^\s*<([a-z-]+)[\s>]/.exec(text)?.[1]) {
    case "command-name":
    case "command-message": {
      const name = plain(inside(text, "command-name")).trim();
      const args = plain(inside(text, "command-args")).trim();
      return name ? [{ id, kind: "notice", at, text: clip(args ? `${name} ${args}` : name, 120) }] : [];
    }
    case "local-command-stdout":
    case "local-command-stderr":
    case "local-command-caveat":
    // A task may report more than once, and the agent's reply says what came of it.
    case "task-notification":
      return [];
    case "agent-message":
      return [{ id, kind: "notice", at, text: "Message from another agent" }];
    case "bash-input": {
      const command = plain(inside(text, "bash-input"));
      return [{ id, kind: "step", at, tool: "Bash", summary: stepSummary("Bash", { command }), input: command }];
    }
    case "bash-stdout":
    case "bash-stderr": {
      if (!parent) return [];
      const out = plain(inside(text, "bash-stdout")).trimEnd();
      const err = plain(inside(text, "bash-stderr")).trimEnd();
      // No exit status is written down: only an error and nothing else counts as failed.
      return [{ id: parent, kind: "step-result", ok: out !== "" || err === "", output: [out, err].filter(Boolean).join("\n"), at }];
    }
    default:
      return undefined;
  }
}

/** A user's text: the human's own, a peer's message from a room, or what the harness wrote in the user's turn. */
function said(id: string, at: string, text: string, queued: boolean, parent?: string): Out {
  if (INTERRUPT.test(text)) return [{ id, kind: "notice", at, text: "Interrupted" }];
  const from = peerOf(text);
  if (from !== null) return [{ id, kind: "peer", at, text: afterHeader(text), from }];
  const written = harness(id, at, text, parent);
  if (written) return written;
  return [queued ? { id, kind: "you", at, text, queued: true } : { id, kind: "you", at, text }];
}

// Rows are whatever the agent wrote: read loosely, never throw.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowItems(row: any): Out {
  try {
    if (!row || typeof row !== "object" || row.isSidechain) return [];
    const at = String(row.timestamp ?? "");
    const uuid = String(row.uuid ?? at);
    if (row.type === "system") return row.subtype === "compact_boundary" ? [{ id: uuid, kind: "notice", at, text: "Conversation compacted" }] : [];
    if (row.type === "attachment") {
      const a = row.attachment;
      // Not on `isMeta`, which a room's message queued mid-turn carries too.
      if (a?.type !== "queued_command" || typeof a.prompt !== "string" || a.commandMode === "task-notification") return [];
      return said(uuid, at, a.prompt, true);
    }
    const content = row.message?.content;
    if (row.type === "user") {
      // Rows the harness marks as its own: a command's output (/context), a caveat, a compacted conversation's summary.
      const meta = row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true;
      const parent = typeof row.parentUuid === "string" ? row.parentUuid : undefined;
      if (typeof content === "string") return meta ? [] : said(uuid, at, content, row.promptSource === "queued", parent);
      if (!Array.isArray(content)) return [];
      const out: Out = [];
      const only = content.length === 1;
      content.forEach((b, i) => {
        const id = only ? uuid : `${uuid}:${i}`;
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          out.push({ id: b.tool_use_id, kind: "step-result", ok: !b.is_error && !row.toolDenialKind, output: textOf(b.content), at });
        } else if (b?.type === "text" && typeof b.text === "string" && !meta) {
          out.push(...said(id, at, b.text, row.promptSource === "queued", parent));
        }
      });
      return out;
    }
    if (row.type === "assistant" && Array.isArray(content)) {
      const out: Out = [];
      const only = content.length === 1;
      content.forEach((b, i) => {
        const id = only ? uuid : `${uuid}:${i}`;
        if (b?.type === "text" && typeof b.text === "string" && b.text) out.push({ id, kind: "agent", at, text: b.text });
        else if (b?.type === "tool_use" && typeof b.id === "string") {
          const tool = String(b.name ?? "tool");
          out.push({ id: b.id, kind: "step", at, tool, summary: stepSummary(tool, b.input), input: inputText(b.input) });
        }
      });
      return out;
    }
    return [];
  } catch {
    return [];
  }
}

// --- Reading the pane (the Claude checks doc, "Reading the pane (fail closed)") ---
//
// The prompt is the box between the last two `───` rules. A dialog replaces
// it, and each dialog is matched whole, anchored at the bottom of the screen:
// any row out of place (a wrapped label, a focused text field, a changed
// footer) and it's unrecognised. A dialog whose row for the user's words has
// focus is read on its own (`field`), as the same dialog, so an answer can
// check its words go into that field and nowhere else.

const QUEUED = "Press up to edit queued messages";
/** `✽ Frosting… (9s · ↓ 82 tokens)`; the glyph cycles. Idle reads `✻ Baked for 24s · done …`. */
const SPINNER = /^\S \S.*… \(\d/u;
const PERMISSION_FOOTER = "Esc to cancel · Tab to amend";
const PERMISSION_FIELD_FOOTER = "Esc to cancel";
const QUESTION_FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const QUESTION_FIELD_FOOTER = "Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel";
/** A call with one question: no tabs to move between. */
const ONE_QUESTION_FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const ONE_QUESTION_FIELD_FOOTER = "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel";
const QUESTION_OTHER = "Type something.";
const PLAN_FOOTER = "ctrl+g to edit in Vim · ";
const PLAN_FEEDBACK = "Tell Claude what to change";
const PLAN_HINT = "shift+tab to approve with this feedback";
const PLAN_ASK = "Claude has written up a plan and is ready to execute. Would you like to proceed?";
/** One sentence, its only `?` at the end: `Do you want to proceed?`, `Do you want to create notes.txt?`. */
const PERMISSION_ASK = /^Do you want to [^?]+\?$/u;

const rule = (t: string) => isRule(t, "─");
const dashes = (t: string) => isRule(t, "╌");
const option = (t: string) => optionRow(t, "❯") !== null;

interface Box { top: number; bottom: number }

/** The prompt box: the rows strictly between rules `top` and `bottom`. */
function inputBox(texts: string[]): Box | null {
  const bottom = findRowBack(texts, rule, texts.length);
  const top = findRowBack(texts, rule, bottom);
  if (top < 0 || bottom - top < 2) return null;
  const head = texts[top + 1]!;
  // The box's `❯` is followed by a no-break space (trimmed away when the box is empty); a submitted
  // prompt's in the history, and a dialog's selected row, by a plain one. Anything else is not the box.
  if (head !== "❯" && !head.startsWith("❯\u00a0")) return null;
  if (!texts.slice(top + 2, bottom).every((t) => t === "" || t.startsWith("  "))) return null;
  return { top, bottom };
}

function draftIn(lines: PaneLine[], texts: string[], box: Box): Pick<PaneRead, "draft" | "draftText"> {
  const rest = texts[box.top + 1]!.slice(2);
  const more = texts.slice(box.top + 2, box.bottom).map((t) => t.slice(2));
  // Dim, but it stands for messages waiting to go: never an empty prompt.
  if (more.length === 0 && rest.trim() === QUEUED) return { draft: "text", draftText: QUEUED };
  if (more.length === 0 && allDim(lines[box.top + 1]!, 2)) return { draft: "empty" };
  return { draft: "text", draftText: [rest, ...more].join("\n").replace(/\n+$/, "") };
}

function workingAround(texts: string[], box: Box): boolean {
  if (texts.slice(box.bottom + 1).some((t) => t.includes("esc to interrupt"))) return true;
  // The spinner is the last unindented row above the box (a `⎿  Tip:` may sit under it).
  const row = findRowBack(texts, (t) => t !== "" && !/^\s/.test(t), box.top);
  return row >= 0 && SPINNER.test(texts[row]!);
}

/** The rows between the content and the first option: one sentence, which may wrap. */
function askBefore(texts: string[], from: number, to: number): string {
  return texts.slice(from, to).filter((t) => !blank(t) && !rule(t)).map((t) => t.trim()).join(" ");
}

/** With `field`, the dialog after Tab on its No row: the card as it read before, for its fingerprint. */
function permission(texts: string[], field = false): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || texts[last]!.trim() !== (field ? PERMISSION_FIELD_FOOTER : PERMISSION_FOOTER)) return null;
  const top = findRowBack(texts, rule, last);
  const head = top < 0 ? -1 : nextFilled(texts, top + 1, last);
  if (head < 0) return null;
  const title = texts[head]!.trim();
  if (title !== "Bash command" && title !== "Create file" && title !== "Edit file") return null;
  const open = findRow(texts, dashes, head + 1, last);
  const close = open < 0 ? -1 : findRow(texts, dashes, open + 1, last);
  if (close < 0 || findRow(texts, dashes, close + 1, last) >= 0) return null;
  const first = findRow(texts, option, close + 1, last);
  if (first < 0 || !PERMISSION_ASK.test(askBefore(texts, close + 1, first))) return null;
  // Focused, the No row's field runs down to the footer.
  const scan = scanOptions(texts, first, "❯", undefined, field ? last : undefined);
  if (!scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const no = opts[opts.length - 1]!;
  // Focused, the No row reads `No, ` and the user's words (its placeholder until there are some).
  if (field && !(no.selected && no.label.startsWith("No, "))) return null;
  const labels = opts.map((o) => (field && o === no ? "No" : o.label));
  if (opts.length < 2 || labels[0] !== "Yes" || labels[labels.length - 1] !== "No" || !labels.slice(1, -1).every((l) => lasting(l))) return null;
  const body = block(texts, open + 1, close, 1);
  const parts = [title];
  let detail = body;
  if (title !== "Bash command") {
    // The file's path: the one row between the heading and the content.
    const rows = texts.slice(head + 1, open).filter((t) => !blank(t));
    if (rows.length !== 1) return null;
    const path = rows[0]!.trim();
    detail = `${path}\n${body}`;
    parts.push(path);
  }
  const options = opts.map((o, k) => cardOption(o, { label: labels[k], secondary: lasting(labels[k]!), takesText: o === no }));
  return { kind: "permission", title, detail, options, fingerprint: fingerprint([...parts, body, ...options.map((o) => o.label)]), ...highlighted(opts) };
}

/** With `field`, the dialog with its change request focused: the card as it read before, for its fingerprint. */
function plan(texts: string[], field = false): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || !texts[last]!.trim().startsWith(PLAN_FOOTER)) return null;
  const title = "Ready to code?";
  const head = findRowBack(texts, (t) => t.trim() === title, last);
  if (head < 1 || !rule(texts[head - 1]!)) return null;
  const intro = nextFilled(texts, head + 1, last);
  if (intro < 0 || texts[intro]!.trim() !== "Here is Claude's plan:" || !dashes(texts[intro + 1] ?? "")) return null;
  const open = intro + 1;
  const close = findRow(texts, dashes, open + 1, last);
  // Exactly two dashed rules: a third would cut the plan short and leave the rest out of the fingerprint.
  if (close < 0 || findRow(texts, dashes, close + 1, last) >= 0) return null;
  const first = findRow(texts, option, close + 1, last);
  if (first < 0 || askBefore(texts, close + 1, first) !== PLAN_ASK) return null;
  // Focused, the change request's field runs down to its hint, the last one on screen (the words may quote it).
  const hint = field ? findRowBack(texts, (t) => t.trim() === PLAN_HINT, last) : -1;
  const between = (t: string, prev: PaneOption) => !field && prev.label === PLAN_FEEDBACK && t.trim() === PLAN_HINT;
  const scan = scanOptions(texts, first, "❯", between, field ? hint + 1 : undefined);
  if (!scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const feedback = opts[opts.length - 1]!;
  // With that row selected its text field has focus: a digit would be typed, not chosen.
  if (feedback.selected !== field) return null;
  // Focused, the row shows the user's words (its placeholder until there are some), the hint still under them.
  if (field && texts[scan.end - 1]!.trim() !== PLAN_HINT) return null;
  const labels = opts.map((o) => (field && o === feedback ? PLAN_FEEDBACK : o.label));
  if (opts.length < 2 || labels[labels.length - 1] !== PLAN_FEEDBACK || !labels.slice(0, -1).every((l) => l.startsWith("Yes"))) return null;
  const detail = block(texts, open + 1, close, 1);
  const options = opts.map((o, k) => cardOption(o, { label: labels[k], secondary: lasting(labels[k]!), takesText: o === feedback }));
  return { kind: "plan", title, detail, options, fingerprint: fingerprint([title, detail, ...options.map((o) => o.label)]), ...highlighted(opts) };
}

interface Tab { glyph: string; header: string; lit: boolean }

const isTabBar = (t: string) => t.startsWith("←") && t.endsWith("→") && t.includes("✔ Submit");

/** `←  ☐ Colour  ☒ Size  ✔ Submit  →`: each tab, and which one is highlighted (exactly one). */
function tabBar(line: PaneLine): Tab[] | null {
  const t = line.text.trimEnd();
  const tabs: Tab[] = [];
  const re = /([☐☒✔]) (.+?)(?=\s+[☐☒✔] |\s+→$)/gu;
  for (let m; (m = re.exec(t)); ) tabs.push({ glyph: m[1]!, header: m[2]!, lit: line.highlight[m.index] === true });
  const submit = tabs[tabs.length - 1];
  if (!submit || submit.glyph !== "✔" || submit.header !== "Submit" || tabs.slice(0, -1).some((x) => x.glyph === "✔")) return null;
  return tabs.filter((x) => x.lit).length === 1 ? tabs : null;
}

const CHIP = /^ ☐ ([^☐☒✔←→]+)$/u;

/** ` ☐ Fruit`, highlighted, under the dialog's rule: the header of a call's one question, in place of the tab bar. */
function isChip(lines: PaneLine[], texts: string[], row: number): boolean {
  const t = texts[row]!;
  return CHIP.test(t) && lines[row]!.highlight[1] === true && row > 0 && rule(texts[row - 1]!);
}

/** Where the questions' header row is, and which question of how many shows: the tab bar's lit tab, or the one chip. */
function questionHeader(lines: PaneLine[], texts: string[], last: number, field: boolean): { bar: number; at: number; of: number } | null {
  const footer = texts[last]!.trim();
  if (footer === (field ? QUESTION_FIELD_FOOTER : QUESTION_FOOTER)) {
    const bar = findRowBack(texts, isTabBar, last);
    const tabs = bar < 0 ? null : tabBar(lines[bar]!);
    if (!tabs) return null;
    const questions = tabs.slice(0, -1);
    return { bar, at: questions.findIndex((x) => x.lit) + 1, of: questions.length };
  }
  if (footer === (field ? ONE_QUESTION_FIELD_FOOTER : ONE_QUESTION_FOOTER)) {
    const bar = findRowBack(texts, (t) => CHIP.test(t), last);
    return bar >= 0 && isChip(lines, texts, bar) ? { bar, at: 1, of: 1 } : null;
  }
  return null;
}

/** With `field`, the question with "Type something." focused: the card as it read before, for its fingerprint. */
function question(lines: PaneLine[], texts: string[], field = false): Card | null {
  const last = lastFilled(texts);
  const header = last < 0 ? null : questionHeader(lines, texts, last, field);
  if (!header) return null;
  const { bar, at, of } = header;
  const first = findRow(texts, option, bar + 1, last);
  if (at === 0 || first < 0) return null;
  const title = block(texts, bar + 1, first, 0);
  // Under each option its description, indented to the label; a rule sets "Chat about this" apart. Focused, the field
  // of "Type something." runs down to that rule, over the last option on screen.
  const fieldTo = field ? findRowBack(texts, option, last) - 1 : undefined;
  const scan = scanOptions(texts, first, "❯", (t, prev) => rule(t) || (!blank(t) && indentOf(t) >= prev.labelAt), fieldTo);
  if (!title || !scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const chat = opts[opts.length - 1]!;
  const other = opts[opts.length - 2];
  if (!other || opts.length < 3 || chat.label !== "Chat about this") return null;
  // With "Type something." selected its text field has focus: a digit would be typed, not chosen.
  // Focused, it shows the user's words (its placeholder until there are some).
  if (other.selected !== field) return null;
  const labels = opts.map((o) => (field && o === other ? QUESTION_OTHER : o.label));
  if (labels[labels.length - 2] !== QUESTION_OTHER) return null;
  const inField = (row: number) => !!scan.field && row >= scan.field.from && row < scan.field.to;
  const rules = texts.slice(first, scan.end).flatMap((t, k) => (rule(t) && !inField(first + k) ? [first + k] : []));
  if (rules.length !== 1 || rules[0] !== chat.row - 1) return null;
  // Multi-select rows carry a checkbox: not a card in this version (Decision 4).
  if (labels.some((l) => /^\[.\] /u.test(l))) return null;
  const options = opts.map((o, k) => cardOption(o, { label: labels[k], secondary: o === chat, takesText: o === other }));
  return {
    kind: "question", title, options, fingerprint: fingerprint([`${at}/${of}`, title, ...options.map((o) => o.label)]), question: { at, of },
    ...highlighted(opts),
  };
}

/** The step after the last question: the answers, then Submit or Cancel. It has no footer. */
function review(lines: PaneLine[], texts: string[]): Card | null {
  const last = lastFilled(texts);
  const bar = findRowBack(texts, isTabBar, last);
  const tabs = bar < 0 ? null : tabBar(lines[bar]!);
  if (!tabs || !tabs[tabs.length - 1]!.lit) return null;
  const title = "Review your answers";
  const head = nextFilled(texts, bar + 1, last);
  if (head < 0 || texts[head]!.trim() !== title) return null;
  const ready = findRow(texts, (t) => t.trim() === "Ready to submit your answers?", head + 1, last);
  const first = ready < 0 ? -1 : nextFilled(texts, ready + 1, last + 1);
  const scan = first < 0 ? null : scanOptions(texts, first, "❯");
  if (!scan || scan.end !== last + 1 || scan.options.map((o) => o.label).join("\n") !== "Submit answers\nCancel") return null;
  const detail = block(texts, head + 1, ready, 1);
  const options = scan.options.map((o) => cardOption(o));
  return { kind: "question", title, detail, options, fingerprint: fingerprint([title, detail, ...options.map((o) => o.label)]), ...highlighted(scan.options) };
}

function readPane(ansi: string): PaneRead {
  try {
    const lines = paneLines(ansi);
    const texts = lines.map((l) => l.text.trimEnd());
    const box = inputBox(texts);
    if (box) return { dialog: null, unrecognised: false, ...draftIn(lines, texts, box), working: workingAround(texts, box) };
    const dialog = permission(texts) ?? plan(texts) ?? question(lines, texts) ?? review(lines, texts);
    if (dialog) return { dialog, unrecognised: false, draft: "unknown", working: false };
    const field = permission(texts, true) ?? plan(texts, true) ?? question(lines, texts, true);
    return field ? { ...UNREADABLE, field: { fingerprint: field.fingerprint } } : { ...UNREADABLE };
  } catch {
    return { ...UNREADABLE };
  }
}

// --- Answering (the Claude checks doc, "Key mapping per dialog") ---
//
// A digit chooses its row at once, wherever the highlight is. A row that
// takes the user's words becomes a text field: the plan's change request once
// the highlight is on it, the permission's No after Tab on it, a question's
// "Type something." once its digit is pressed. The lists wrap (Down on the last
// row goes to the first), so moves count from the highlight the pane shows.

/** Down from the highlighted row to row `to`. */
function downTo(card: Card, to: number): string[] | null {
  if (card.selected === undefined || card.selected > to) return null;
  return Array<string>(to - card.selected).fill("Down");
}

function keysFor(card: Card, option: number, hasText: boolean): KeyPlan | null {
  const o = card.options.find((x) => x.index === option);
  // One key per choice: a two-digit option would be two choices.
  if (!o || option > 9) return null;
  if (!hasText) {
    // A field is no choice without its words; the permission's No is (its digit says No outright).
    return o.takesText && card.kind !== "permission" ? null : { keys: [String(option)] };
  }
  if (!o.takesText) return null;
  if (card.kind === "question") return { keys: [String(option)], text: "paste-then-enter" };
  const moves = downTo(card, option);
  if (!moves) return null;
  return { keys: card.kind === "permission" ? [...moves, "Tab"] : moves, text: "paste-then-enter" };
}

export const claudeAdapter: ConvAdapter = {
  kind: "claude",
  rowItems,
  readPane,
  keysFor,
  // C-u clears one line of a multi-line draft only. C-c clears the lot, but
  // arms "Press Ctrl-C again to exit", and while a turn runs it interrupts the
  // turn instead (the draft stays): so it is sent once, and only when idle.
  clearDraft: ["C-c"],
};
