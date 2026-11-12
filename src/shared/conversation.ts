// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * What the phone's conversation view shows: a transcript boiled down to a few
 * kinds of item. Thinking is never one of them.
 */

export type ConvItem =
  | { id: string; kind: "you"; at: string; text: string; queued?: boolean }
  | { id: string; kind: "peer"; at: string; text: string; from: string }
  | { id: string; kind: "agent"; at: string; text: string }
  | { id: string; kind: "step"; at: string; tool: string; summary: string; input: string; result?: { ok: boolean; output: string; at: string } }
  | { id: string; kind: "notice"; at: string; text: string };

/** A later sighting of a step's result, merged by id. */
export interface StepResult {
  id: string;
  kind: "step-result";
  ok: boolean;
  output: string;
  at: string;
}

export type ConvError = "another-conversation" | "prompt-changed" | "waiting" | "no-agent";
export type GenericKey = "1" | "2" | "3" | "4" | "5" | "Enter" | "Escape" | "Up" | "Down" | "Tab";
