// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import type { ConvAdapter } from "./adapter";
import { afterHeader, inputText, peerOf, stepSummary, textOf } from "./items";
import {
  allDim, blank, block, cardOption, findRow, findRowBack, fingerprint, isRule, lastFilled, lasting, nextFilled, optionRow,
  paneLines, scanOptions, UNREADABLE, type PaneLine, type PaneRead,
} from "./pane";

type Out = (ConvItem | StepResult)[];

const INTERRUPT = /^\[Request interrupted by user/;

/** A user's text: the human's own, or a peer's message from a room. */
function said(id: string, at: string, text: string, queued: boolean): ConvItem[] {
  if (INTERRUPT.test(text)) return [{ id, kind: "notice", at, text: "Interrupted" }];
  const from = peerOf(text);
  if (from !== null) return [{ id, kind: "peer", at, text: afterHeader(text), from }];
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
      return a?.type === "queued_command" && typeof a.prompt === "string" ? said(uuid, at, a.prompt, true) : [];
    }
    const content = row.message?.content;
    if (row.type === "user") {
      if (typeof content === "string") return said(uuid, at, content, row.promptSource === "queued");
      if (!Array.isArray(content)) return [];
      const out: Out = [];
      const only = content.length === 1;
      content.forEach((b, i) => {
        const id = only ? uuid : `${uuid}:${i}`;
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          out.push({ id: b.tool_use_id, kind: "step-result", ok: !b.is_error && !row.toolDenialKind, output: textOf(b.content), at });
        } else if (b?.type === "text" && typeof b.text === "string") {
          out.push(...said(id, at, b.text, row.promptSource === "queued"));
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
// footer) and it's unrecognised.

const QUEUED = "Press up to edit queued messages";
/** `✽ Frosting… (9s · ↓ 82 tokens)`; the glyph cycles. Idle reads `✻ Baked for 24s · done …`. */
const SPINNER = /^\S \S.*… \(\d/u;
const PERMISSION_FOOTER = "Esc to cancel · Tab to amend";
const QUESTION_FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const PLAN_FOOTER = "ctrl+g to edit in Vim · ";
const PLAN_FEEDBACK = "Tell Claude what to change";

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

function permission(texts: string[]): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || texts[last]!.trim() !== PERMISSION_FOOTER) return null;
  const top = findRowBack(texts, rule, last);
  const head = top < 0 ? -1 : nextFilled(texts, top + 1, last);
  if (head < 0) return null;
  const title = texts[head]!.trim();
  if (title !== "Bash command" && title !== "Create file" && title !== "Edit file") return null;
  const open = findRow(texts, dashes, head + 1, last);
  const close = open < 0 ? -1 : findRow(texts, dashes, open + 1, last);
  if (close < 0 || findRow(texts, dashes, close + 1, last) >= 0) return null;
  const first = findRow(texts, option, close + 1, last);
  if (first < 0 || !/^Do you want to .+\?$/u.test(askBefore(texts, close + 1, first))) return null;
  const scan = scanOptions(texts, first, "❯");
  if (!scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const no = opts[opts.length - 1]!;
  if (opts.length < 2 || opts[0]!.label !== "Yes" || no.label !== "No" || !opts.slice(1, -1).every((o) => lasting(o.label))) return null;
  const body = block(texts, open + 1, close, 1);
  const parts = [title];
  let detail = body;
  if (title !== "Bash command") {
    // The file's path: the one row between the heading and the content.
    const rows = texts.slice(head + 1, open).filter((t) => !blank(t));
    if (rows.length !== 1) return null;
    const path = rows[0]!.trim();
    detail = title === "Edit file" ? `${path}\n${body}` : path;
    parts.push(path);
  }
  const options = opts.map((o) => cardOption(o, { secondary: lasting(o.label), takesText: o === no }));
  return { kind: "permission", title, detail, options, fingerprint: fingerprint([...parts, body, ...options.map((o) => o.label)]) };
}

function plan(texts: string[]): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || !texts[last]!.trim().startsWith(PLAN_FOOTER)) return null;
  const title = "Ready to code?";
  const head = findRowBack(texts, (t) => t.trim() === title, last);
  if (head < 1 || !rule(texts[head - 1]!)) return null;
  const intro = nextFilled(texts, head + 1, last);
  if (intro < 0 || texts[intro]!.trim() !== "Here is Claude's plan:" || !dashes(texts[intro + 1] ?? "")) return null;
  const open = intro + 1;
  const close = findRow(texts, dashes, open + 1, last);
  const first = close < 0 ? -1 : findRow(texts, option, close + 1, last);
  if (first < 0 || !askBefore(texts, close + 1, first).endsWith("Would you like to proceed?")) return null;
  const scan = scanOptions(texts, first, "❯", (t, prev) => prev.label === PLAN_FEEDBACK && t.trim() === "shift+tab to approve with this feedback");
  if (!scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const feedback = opts[opts.length - 1]!;
  if (opts.length < 2 || feedback.label !== PLAN_FEEDBACK || !opts.slice(0, -1).every((o) => o.label.startsWith("Yes"))) return null;
  // With that row selected its text field has focus: a digit would be typed, not chosen.
  if (feedback.selected) return null;
  const detail = block(texts, open + 1, close, 1);
  const options = opts.map((o) => cardOption(o, { secondary: lasting(o.label), takesText: o === feedback }));
  return { kind: "plan", title, detail, options, fingerprint: fingerprint([title, detail, ...options.map((o) => o.label)]) };
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

function question(lines: PaneLine[], texts: string[]): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || texts[last]!.trim() !== QUESTION_FOOTER) return null;
  const bar = findRowBack(texts, isTabBar, last);
  const tabs = bar < 0 ? null : tabBar(lines[bar]!);
  if (!tabs) return null;
  const questions = tabs.slice(0, -1);
  const at = questions.findIndex((x) => x.lit) + 1;
  const first = findRow(texts, option, bar + 1, last);
  if (at === 0 || first < 0) return null;
  const title = block(texts, bar + 1, first, 0);
  // Under each option its description, indented to the label; a rule sets "Chat about this" apart.
  const scan = scanOptions(texts, first, "❯", (t, prev) => rule(t) || (!blank(t) && t.length - t.trimStart().length >= prev.labelAt));
  if (!title || !scan || nextFilled(texts, scan.end, last) >= 0) return null;
  const opts = scan.options;
  const chat = opts[opts.length - 1]!;
  const other = opts[opts.length - 2];
  if (!other || opts.length < 3 || chat.label !== "Chat about this" || other.label !== "Type something.") return null;
  const rules = texts.slice(first, scan.end).flatMap((t, k) => (rule(t) ? [first + k] : []));
  if (rules.length !== 1 || rules[0] !== chat.row - 1) return null;
  // Multi-select rows carry a checkbox: not a card in this version (Decision 4).
  if (opts.some((o) => /^\[.\] /u.test(o.label))) return null;
  // With "Type something." selected its text field has focus: a digit would be typed, not chosen.
  if (other.selected) return null;
  const of = questions.length;
  const options = opts.map((o) => cardOption(o, { secondary: o === chat, takesText: o === other }));
  return { kind: "question", title, options, fingerprint: fingerprint([`${at}/${of}`, title, ...options.map((o) => o.label)]), question: { at, of } };
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
  return { kind: "question", title, detail, options, fingerprint: fingerprint([title, detail, ...options.map((o) => o.label)]) };
}

function readPane(ansi: string): PaneRead {
  try {
    const lines = paneLines(ansi);
    const texts = lines.map((l) => l.text.trimEnd());
    const box = inputBox(texts);
    if (box) return { dialog: null, unrecognised: false, ...draftIn(lines, texts, box), working: workingAround(texts, box) };
    const dialog = permission(texts) ?? plan(texts) ?? question(lines, texts) ?? review(lines, texts);
    return dialog ? { dialog, unrecognised: false, draft: "unknown", working: false } : { ...UNREADABLE };
  } catch {
    return { ...UNREADABLE };
  }
}

export const claudeAdapter: ConvAdapter = { kind: "claude", rowItems, readPane };
