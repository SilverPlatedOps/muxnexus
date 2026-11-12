// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ConvItem, StepResult } from "../../shared/conversation";
import type { ConvAdapter } from "./adapter";
import { afterHeader, hashId, inputText, peerOf, stepSummary, textOf } from "./items";

type Out = (ConvItem | StepResult)[];

/** Context the harness injects as a user message; never the user's words. */
const INJECTED = /^\s*<(environment_context|user_instructions)>/;

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
  const id = String(p.call_id ?? hashId(at + p.type));
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
    const id = hashId(at + p.type);
    if (p.type === "message" && Array.isArray(p.content)) {
      if (p.role === "assistant") {
        const text = p.content.filter((b: any) => b?.type === "output_text" && typeof b.text === "string").map((b: any) => b.text).join("");
        return text ? [{ id, kind: "agent", at, text }] : [];
      }
      if (p.role === "user") {
        const text = p.content.filter((b: any) => b?.type === "input_text" && typeof b.text === "string").map((b: any) => b.text).join("");
        if (!text || INJECTED.test(text)) return [];
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

export const codexAdapter: ConvAdapter = { kind: "codex", rowItems };
