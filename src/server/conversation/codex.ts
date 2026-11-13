// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import type { ConvAdapter, KeyPlan } from "./adapter";
import { afterHeader, hashId, inputText, peerOf, stepSummary, textOf } from "./items";
import {
  allDim, blank, block, cardOption, findRow, findRowBack, fingerprint, highlighted, lastFilled, lasting, nextFilled, optionRow,
  paneLines, rowKey, scanOptions, UNREADABLE, type PaneLine, type PaneRead,
} from "./pane";

type Out = (ConvItem | StepResult)[];

/**
 * Context the harness injects as a user message (instructions, the note after an interrupt, an automation's
 * heartbeat, what the Codex app adds about the page in view); never the user's words.
 */
const INJECTED = /^\s*(?:<(?:environment_context|user_instructions|turn_aborted|heartbeat|external_codex_apps_[a-z_]+)>|# AGENTS\.md instructions)/;

/** The command inside an `exec` call's JS-ish input: `exec_command({cmd:"…"})`. */
function execCommand(input: string): string {
  const m = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (m) {
    try { return JSON.parse(m[1]!) as string; } catch { /* fall through */ }
  }
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(p: any, at: string): Out {
  let command = "";
  let input = "";
  if (p.type === "custom_tool_call") {
    input = typeof p.input === "string" ? p.input : inputText(p.input);
    command = execCommand(input);
  } else {
    input = typeof p.arguments === "string" ? p.arguments : inputText(p.arguments);
    try {
      const a = JSON.parse(input);
      command = Array.isArray(a?.command) ? a.command.join(" ") : String(a?.cmd ?? a?.command ?? "");
    } catch { /* not JSON: no command */ }
  }
  const tool = String(p.name ?? "tool");
  const id = String(p.call_id ?? hashId(at + p.type + tool + input));
  const summary = command ? stepSummary("Bash", { command }) : stepSummary(tool, undefined);
  return [{ id, kind: "step", at, tool, summary, input }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowItems(row: any): Out {
  try {
    if (!row || typeof row !== "object") return [];
    const at = String(row.timestamp ?? "");
    const p = row.payload;
    if (!p || typeof p !== "object") return [];
    if (row.type === "event_msg") {
      return p.type === "turn_aborted" ? [{ id: hashId(at + "turn_aborted"), kind: "notice", at, text: "Interrupted" }] : [];
    }
    if (row.type !== "response_item") return [];
    if (p.type === "message" && Array.isArray(p.content)) {
      // Messages carry no id, and several can share a timestamp (a forked agent's copied history): their words tell them apart.
      const idOf = (text: string) => hashId(at + p.type + p.role + text);
      if (p.role === "assistant") {
        const text = p.content.filter((b: any) => b?.type === "output_text" && typeof b.text === "string").map((b: any) => b.text).join("");
        return text ? [{ id: idOf(text), kind: "agent", at, text }] : [];
      }
      if (p.role === "user") {
        const text = p.content.filter((b: any) => b?.type === "input_text" && typeof b.text === "string").map((b: any) => b.text).join("");
        if (!text || INJECTED.test(text)) return [];
        const id = idOf(text);
        const from = peerOf(text);
        return [from !== null ? { id, kind: "peer", at, text: afterHeader(text), from } : { id, kind: "you", at, text }];
      }
      return [];
    }
    if (p.type === "custom_tool_call" || p.type === "function_call") return call(p, at);
    if ((p.type === "custom_tool_call_output" || p.type === "function_call_output") && typeof p.call_id === "string") {
      const output = textOf(p.output);
      return [{ id: p.call_id, kind: "step-result", ok: !/^aborted by user/.test(output), output, at }];
    }
    return [];
  } catch {
    return [];
  }
}

// --- Reading the pane (the Codex checks doc, "Implications for the builder") ---
//
// The composer is the last `›` row, drawn plain (a submitted prompt's `›` is
// dim, a dialog's selected row reversed), with only the status line below. A
// dialog replaces it.

const APPROVAL = "Would you like to run the following command?";
const APPROVAL_FOOTER = "Press enter to confirm or esc to cancel";
const HOTKEYS = ["y", "p", "esc"];
/** `• Working (7s • esc to interrupt)`, maybe followed by ` · 1 background terminal running · /ps to view …`. */
const WORKING = /^• \S.*\(\d[^)]*esc to interrupt\)(?: · .*)?$/u;

const option = (t: string) => optionRow(t, "›") !== null;
/** Rows of the dialog's block: `  Environment: local`, `  Reason: …` (the model's own words), `  $ touch probe.txt`. */
const KEYED = /^ {2}(Environment: |Reason: |\$ )/u;
/** A row wrapped from the one above, indented under it. */
const WRAPPED = /^ {3,}\S/u;

/**
 * The `$ ` row of the approval whose options start at row `options`, or -1.
 * The block above the options runs up to the header with no gap and holds,
 * in order, `Environment:` / `Reason:` rows, then one `$ ` row, each
 * optionally wrapped, with blank rows between. Anything else: not this dialog.
 */
function commandRow(texts: string[], options: number): number {
  let head = options - 1;
  while (head >= 0 && (blank(texts[head]!) || KEYED.test(texts[head]!) || WRAPPED.test(texts[head]!))) head--;
  if (head < 0 || texts[head] !== `  ${APPROVAL}`) return -1;
  let cmd = -1;
  for (let i = head + 1; i < options; i++) {
    const t = texts[i]!;
    if (blank(t)) continue;
    if (WRAPPED.test(t)) {
      if (i === head + 1 || blank(texts[i - 1]!)) return -1;
      continue;
    }
    // Only one command, and nothing keyed after it.
    if (cmd >= 0) return -1;
    if (t.startsWith("  $ ")) cmd = i;
  }
  return cmd;
}

function approval(texts: string[]): Card | null {
  const last = lastFilled(texts);
  if (last < 0 || texts[last]!.trim() !== APPROVAL_FOOTER) return null;
  const end = findRowBack(texts, (t) => !blank(t), last);
  let start = end;
  while (start > 0 && option(texts[start - 1]!)) start--;
  const scan = end < 0 ? null : scanOptions(texts, start, "›");
  if (!scan || scan.end !== end + 1) return null;
  const opts = scan.options;
  const keyed = opts.map((o) => /^(.+) \((\w+)\)$/u.exec(o.label));
  if (opts.length !== HOTKEYS.length || keyed.some((m, k) => m?.[2] !== HOTKEYS[k])) return null;
  const labels = keyed.map((m) => m![1]!);
  if (!labels[0]!.startsWith("Yes") || !lasting(labels[1]!) || !labels[2]!.startsWith("No")) return null;
  const cmd = commandRow(texts, start);
  if (cmd < 0) return null;
  const detail = block(texts, cmd, start, 2);
  const options = opts.map((o, k) => cardOption(o, { label: labels[k], secondary: k === 1, takesText: k === 2 }));
  return {
    kind: "approval", title: APPROVAL, detail, options, fingerprint: fingerprint([APPROVAL, detail, ...options.map((o) => o.label)]),
    ...highlighted(opts),
  };
}

/**
 * The composer: its rows run to the first blank row, and below them is only
 * the status line's block. Null when there is none (a dialog is up, or the
 * screen holds something else), so a submitted prompt is never taken for it.
 */
function composer(lines: PaneLine[], texts: string[]): { row: number; end: number } | null {
  const last = lastFilled(texts);
  const row = findRowBack(texts, (t) => /^›( |$)/u.test(t), last + 1);
  if (row < 0 || lines[row]!.dim[0] || lines[row]!.highlight[0] || option(texts[row]!)) return null;
  const end = findRow(texts, blank, row + 1);
  const status = end < 0 ? -1 : nextFilled(texts, end);
  if (status < 0 || findRow(texts, blank, status, last) >= 0) return null;
  return { row, end };
}

function draftIn(lines: PaneLine[], texts: string[], { row, end }: { row: number; end: number }): Pick<PaneRead, "draft" | "draftText"> {
  const more = texts.slice(row + 1, end);
  if (!more.every((t) => t.startsWith("  "))) return { draft: "unknown" };
  if (more.length === 0 && allDim(lines[row]!, 2)) return { draft: "empty" };
  return { draft: "text", draftText: [texts[row]!.slice(2), ...more.map((t) => t.slice(2))].join("\n") };
}

function readPane(ansi: string): PaneRead {
  try {
    const lines = paneLines(ansi);
    const texts = lines.map((l) => l.text.trimEnd());
    const dialog = approval(texts);
    if (dialog) return { dialog, unrecognised: false, draft: "unknown", working: false };
    const box = composer(lines, texts);
    if (!box) return { ...UNREADABLE };
    return { dialog: null, unrecognised: false, ...draftIn(lines, texts, box), working: texts.slice(0, box.row).some((t) => WORKING.test(t)) };
  } catch {
    return { ...UNREADABLE };
  }
}

// --- Answering (the Codex checks doc, "Key map for the approval dialog") ---

/** The approval's own hotkeys, which act at once wherever the highlight is. */
const APPROVAL_KEYS = ["y", "p", "Escape"];

function keysFor(card: Card, option: number, hasText: boolean): KeyPlan | null {
  const o = card.options.find((x) => x.index === option);
  if (card.kind !== "approval" || !o || (hasText && !o.takesText)) return null;
  // The dialog has no field for the words: declining ends the turn, and they go as the next message.
  return hasText ? { keys: ["Escape"], followUp: true } : { keys: [APPROVAL_KEYS[option - 1]!] };
}

// C-c empties the composer, and a running turn carries on (unlike Claude's).
// Steady as it is: over 75 s on 0.167.1 nothing on an idle composer or an approval changed on its own.
export const codexAdapter: ConvAdapter = { kind: "codex", rowItems, readPane, keysFor, clearDraft: ["C-c"], steady: (lines) => lines.map(rowKey) };
