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
  | { id: string; kind: "notice"; at: string; text: string }
  /** Images the user sent, by the paths the agent read them from: shown under their message. */
  | { id: string; kind: "images"; at: string; paths: string[] };

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
  /** What the agent says about it, under its label (a question's answers): plain text. */
  description?: string;
  /** Changes more than this one prompt (a lasting rule, a mode switch): offered, but not as the main button. */
  secondary?: boolean;
  /** Choosing it asks for the user's words ("No, and tell Claude what to do differently"). */
  takesText?: boolean;
}

/** A dialog the agent is waiting on, read from its pane. */
export interface Card {
  /** `trust`: the agent's first screen in a folder not trusted yet, before it runs anything (its hooks included). */
  kind: "permission" | "plan" | "question" | "approval" | "trust";
  title: string;
  /** What the agent says the request does, in its words (a Bash permission's description): plain text. */
  description?: string;
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
 * `unsent`: the words were pasted, but Enter wasn't pressed: the screen changed, or the prompt never showed them, so
 * they may be waiting in the desk's prompt. `attachment`: a file attached is no longer on the server.
 */
export type ConvError = "another-conversation" | "prompt-changed" | "waiting" | "no-agent" | "working" | "unsent" | "attachment";
export type GenericKey = "1" | "2" | "3" | "4" | "5" | "Enter" | "Escape" | "Up" | "Down" | "Tab";

/**
 * A file in the uncommitted changes of the folder a tab's agent works in (the Changes sheet), against the last
 * commit. `untracked`: new and not added to git yet. A count is null when it is not known (an untracked file too
 * large to count); a binary file has none.
 */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked";
  added: number | null;
  removed: number | null;
  binary: boolean;
}
export type ChangesError = "no-folder" | "not-git" | "git" | "gone";
