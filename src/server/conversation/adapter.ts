// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { Card, ConvItem, StepResult } from "../../shared/conversation";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { PaneRead } from "./pane";

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
   * The screen's rows (escapes stripped) with what the agent redraws on its own, unasked, made steady: what a
   * Screen key's token is worked out from, so a timer's redraw is no change while anything else is.
   */
  steady(texts: string[]): string[];
}

const ADAPTERS: Record<AgentKind, ConvAdapter> = { claude: claudeAdapter, codex: codexAdapter };

export function adapterFor(kind: AgentKind): ConvAdapter {
  return ADAPTERS[kind];
}
