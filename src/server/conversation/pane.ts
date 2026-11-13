// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { createHash } from "node:crypto";
import type { Card, CardOption } from "../../shared/conversation";

/**
 * What an agent's pane shows, read from `capture-pane -p -e`. Every reader
 * fails closed: a layout it wasn't written against is `unrecognised`, never a
 * guess, because an answer is a keystroke into whatever is on screen.
 */
export interface PaneRead {
  /** The dialog on screen, when it matches a known layout exactly. */
  dialog: Card | null;
  /** Something dialog-like is on screen (the prompt is gone) that no known layout matches. */
  unrecognised: boolean;
  /** Whether the prompt holds text; "unknown" when there is no prompt to read or it's ambiguous. */
  draft: "empty" | "text" | "unknown";
  /** The prompt's text as shown, whenever `draft` is "text". */
  draftText?: string;
  working: boolean;
  /**
   * A dialog whose text field has focus, taking the user's words: named by the
   * fingerprint of the card it reads as with the field unfocused. No card is
   * offered then (`dialog` null, `unrecognised` true): a digit would be typed.
   */
  field?: { fingerprint: string };
}

/** Nothing on screen can be trusted. */
export const UNREADABLE: PaneRead = { dialog: null, unrecognised: true, draft: "unknown", working: false };

/** One screen row without its escapes, and per character whether it was drawn dim or highlighted (a background colour or reverse video). */
export interface PaneLine {
  text: string;
  dim: boolean[];
  highlight: boolean[];
}

/**
 * Splits a capture into rows. Attributes carry across rows, as tmux writes
 * them. Only SGR is interpreted; other escapes (hyperlinks, cursor moves) are
 * dropped.
 */
export function paneLines(ansi: string): PaneLine[] {
  const lines: PaneLine[] = [];
  let cur: PaneLine = { text: "", dim: [], highlight: [] };
  let dim = false;
  let bg = false;
  let reverse = false;
  for (let i = 0; i < ansi.length; i++) {
    const ch = ansi[i]!;
    if (ch === "\x1b") {
      const next = ansi[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < ansi.length && !/[@-~]/.test(ansi[j]!)) j++;
        if (ansi[j] === "m") ({ dim, bg, reverse } = sgr(ansi.slice(i + 2, j), { dim, bg, reverse }));
        i = j;
      } else if (next === "]" || next === "P" || next === "_" || next === "^") {
        // A string ends at BEL or ST (ESC \).
        let j = i + 2;
        while (j < ansi.length && ansi[j] !== "\x07" && !(ansi[j] === "\x1b" && ansi[j + 1] === "\\")) j++;
        i = ansi[j] === "\x07" ? j : j + 1;
      } else if (next === "(" || next === ")") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "\n") {
      lines.push(cur);
      cur = { text: "", dim: [], highlight: [] };
      continue;
    }
    if (ch < " " || ch === "\x7f") continue;
    cur.text += ch;
    cur.dim.push(dim);
    cur.highlight.push(bg || reverse);
  }
  lines.push(cur);
  return lines;
}

interface Attrs { dim: boolean; bg: boolean; reverse: boolean }

function sgr(body: string, a: Attrs): Attrs {
  const out = { ...a };
  const params = body.split(";");
  for (let k = 0; k < params.length; k++) {
    const p = params[k]!;
    const code = p === "" ? 0 : Number(p.split(":")[0]);
    if (code === 0) { out.dim = false; out.bg = false; out.reverse = false; }
    else if (code === 2) out.dim = true;
    else if (code === 22) out.dim = false;
    else if (code === 7) out.reverse = true;
    else if (code === 27) out.reverse = false;
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) out.bg = true;
    else if (code === 49) out.bg = false;
    if (code === 38 || code === 48 || code === 58) {
      if (code === 48) out.bg = true;
      // Extended colours: `38;5;n` or `38;2;r;g;b`, whose arguments are not codes (`38;2;2;2;2` is not dim).
      if (!p.includes(":")) k += params[k + 1] === "5" ? 2 : params[k + 1] === "2" ? 4 : 0;
    }
  }
  return out;
}

/** True when every visible character of `line` from `from` on is dim (blank counts as dim). */
export function allDim(line: PaneLine, from = 0): boolean {
  for (let i = from; i < line.text.length; i++) if (!/\s/u.test(line.text[i]!) && !line.dim[i]) return false;
  return true;
}

/** sha1 hex of the parts joined by newlines. */
export function fingerprint(parts: string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/** A row that is one box-drawing character repeated, such as `───` or `╌╌╌`. */
export function isRule(text: string, ch: string): boolean {
  const t = text.trim();
  return t.length >= 10 && [...t].every((c) => c === ch);
}

export const blank = (text: string): boolean => text.trim() === "";

/** Index of the last row with something on it, or -1. */
export function lastFilled(texts: string[]): number {
  for (let i = texts.length - 1; i >= 0; i--) if (!blank(texts[i]!)) return i;
  return -1;
}

/** The first row in `from`..`to` (exclusive) that `pred` accepts, or -1. */
export function findRow(texts: string[], pred: (text: string) => boolean, from: number, to = texts.length): number {
  for (let i = Math.max(0, from); i < to; i++) if (pred(texts[i]!)) return i;
  return -1;
}

/** The last row before `before` that `pred` accepts, or -1. */
export function findRowBack(texts: string[], pred: (text: string) => boolean, before: number): number {
  for (let i = before - 1; i >= 0; i--) if (pred(texts[i]!)) return i;
  return -1;
}

/** The next row in `from`..`to` (exclusive) with something on it, or -1. */
export const nextFilled = (texts: string[], from: number, to = texts.length): number => findRow(texts, (t) => !blank(t), from, to);

export interface PaneOption {
  index: number;
  label: string;
  selected: boolean;
  /** The row it's on. */
  row: number;
  /** The column its label starts at. */
  labelAt: number;
}

const OPTION = /^(\s*)(?:(\S)(\s+))?(\d+)\.(\s+)(\S.*?)\s*$/u;

/** A numbered option row such as ` ❯ 1. Yes` or `   2. No`; `marker` is the agent's glyph for the selected row. */
export function optionRow(text: string, marker: string, row = -1): PaneOption | null {
  const m = OPTION.exec(text);
  if (!m) return null;
  if (m[2] !== undefined && m[2] !== marker) return null;
  const labelAt = m[1]!.length + (m[2] ? m[2].length + m[3]!.length : 0) + m[4]!.length + 1 + m[5]!.length;
  return { index: Number(m[4]), label: m[6]!, selected: m[2] === marker, row, labelAt };
}

/**
 * The numbered options starting at row `from`: consecutive option rows, with
 * only the rows `between` accepts in between (descriptions, a separator).
 * Null unless they are numbered 1..N in order. `end` is the row after the last
 * one consumed.
 *
 * With `fieldTo`, the highlighted option is a text field holding the user's
 * words, and every row after it up to `fieldTo` (the dialog's own end, found
 * from the bottom) is theirs, blank or indented under its label: a `1. …` or
 * a rule in the words is never read as the dialog's. Those rows are `field`.
 */
export function scanOptions(
  texts: string[],
  from: number,
  marker: string,
  between: (text: string, prev: PaneOption) => boolean = () => false,
  fieldTo?: number,
): { options: PaneOption[]; end: number; field?: { from: number; to: number } } | null {
  const options: PaneOption[] = [];
  let field: { from: number; to: number } | undefined;
  let i = from;
  for (; i < texts.length; i++) {
    const o = optionRow(texts[i]!, marker, i);
    if (o) {
      options.push(o);
      if (o.selected && fieldTo !== undefined) {
        if (fieldTo <= i) return null;
        for (let k = i + 1; k < fieldTo; k++) if (!blank(texts[k]!) && indentOf(texts[k]!) < o.labelAt) return null;
        field = { from: i + 1, to: fieldTo };
        i = fieldTo - 1;
      }
      continue;
    }
    const prev = options[options.length - 1];
    if (!prev || !between(texts[i]!, prev)) break;
  }
  if (options.length === 0 || options.some((o, k) => o.index !== k + 1)) return null;
  if (fieldTo !== undefined && !field) return null;
  return { options, end: i, ...(field ? { field } : {}) };
}

/** How far a row is indented. */
export const indentOf = (text: string): number => text.length - text.trimStart().length;

/** A card's `selected`: the highlighted option, when one is. */
export function highlighted(opts: PaneOption[]): { selected?: number } {
  const o = opts.find((x) => x.selected);
  return o ? { selected: o.index } : {};
}

/** "Yes, and …" choices make a lasting change (a rule, a mode switch). */
export const lasting = (label: string): boolean => label.startsWith("Yes, and ");

export function cardOption(o: PaneOption, flags: { label?: string; secondary?: boolean; takesText?: boolean } = {}): CardOption {
  return {
    index: o.index,
    label: flags.label ?? o.label,
    ...(flags.secondary ? { secondary: true } : {}),
    ...(flags.takesText ? { takesText: true } : {}),
  };
}

/** Rows `from`..`to` (exclusive) as text, without the dialog's left margin and with blank rows at either end dropped. */
export function block(texts: string[], from: number, to: number, margin: number): string {
  const rows = texts.slice(from, to).map((t) => (t.slice(0, margin).trim() === "" ? t.slice(margin) : t.trimStart()).trimEnd());
  while (rows.length && rows[0] === "") rows.shift();
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.join("\n");
}
