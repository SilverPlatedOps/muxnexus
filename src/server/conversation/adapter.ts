// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { PaneLine, PaneRead } from "./pane";

/** What answering takes: keys, optionally the user's text pasted then Enter, optionally a follow-up message once the pane is idle again. */
export interface KeyPlan { keys: string[]; text?: "paste-then-enter"; followUp?: boolean }

export interface ConvAdapter {
  kind: AgentKind;
  /** One parsed JSONL row in, zero or more items out. */
  rowItems(row: unknown): (ConvItem | StepResult)[];
  /** A `capture-pane -p -e` of the agent's window: its dialog, draft and working state. Fails closed. */
  readPane(ansi: string): PaneRead;
  /** The keys that choose `option` on `card`, a card just read from the pane; null when the card offers no such choice. */
  keysFor(card: Card, option: number, hasText: boolean): KeyPlan | null;
  /** The keys that empty the prompt. Sent only to an idle prompt that holds text. */
  clearDraft: string[];
  /**
   * Whether the prompt `read` shows holds `words`, just pasted into it, and nothing else (`shows`). False when that
   * can't be told: Enter would send whatever the prompt holds.
   */
  owns(read: PaneRead, words: string): boolean;
  /**
   * Whether `shown`, what a prompt or a dialog's field holds as drawn, is `words` and nothing else: the same text,
   * wrapping, indentation and the prompt glyphs aside, or the agent's own placeholder for a paste of their size.
   */
  shows(shown: string, words: string): boolean;
  /**
   * The screen's rows as a Screen key's token sees them (`rowKey`: text and attributes), with what the agent
   * redraws on its own, unasked, made steady: a timer's redraw is no change while anything else is.
   */
  steady(lines: PaneLine[]): string[];
}

const ADAPTERS: Record<AgentKind, ConvAdapter> = { claude: claudeAdapter, codex: codexAdapter };

export function adapterFor(kind: AgentKind): ConvAdapter {
  return ADAPTERS[kind];
}
