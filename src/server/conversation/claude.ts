// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ConvItem, StepResult } from "../../shared/conversation";
import type { ConvAdapter } from "./adapter";
import { afterHeader, inputText, peerOf, stepSummary, textOf } from "./items";

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

export const claudeAdapter: ConvAdapter = { kind: "claude", rowItems };
