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

/** One choice in a dialog, numbered as the agent's screen numbers it. */
export interface CardOption {
  index: number;
  label: string;
  /** Changes more than this one prompt (a lasting rule, a mode switch): offered, but not as the main button. */
  secondary?: boolean;
  /** Choosing it asks for the user's words ("No, and tell Claude what to do differently"). */
  takesText?: boolean;
}

/** A dialog the agent is waiting on, read from its pane. */
export interface Card {
  kind: "permission" | "plan" | "question" | "approval";
  title: string;
  detail?: string;
  options: CardOption[];
  /** Of the dialog as read; an answer is refused once the pane no longer matches it. */
  fingerprint: string;
  /** Which of several questions is on screen. */
  question?: { at: number; of: number };
  /** The option the agent's screen highlights, where a move to another row starts. Not part of the fingerprint. */
  selected?: number;
}

/**
 * `working`: the desk's draft can't be cleared while the agent works (the key that clears it would interrupt).
 * `unsent`: the words went into the desk's prompt, but the screen changed before Enter, so they wait there.
 */
export type ConvError = "another-conversation" | "prompt-changed" | "waiting" | "no-agent" | "working" | "unsent";
export type GenericKey = "1" | "2" | "3" | "4" | "5" | "Enter" | "Escape" | "Up" | "Down" | "Tab";
