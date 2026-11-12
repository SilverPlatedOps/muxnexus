// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { AgentKind } from "../../shared/chat";
import type { ConvItem, StepResult } from "../../shared/conversation";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { PaneRead } from "./pane";

export interface ConvAdapter {
  kind: AgentKind;
  /** One parsed JSONL row in, zero or more items out. */
  rowItems(row: unknown): (ConvItem | StepResult)[];
  /** A `capture-pane -p -e` of the agent's window: its dialog, draft and working state. Fails closed. */
  readPane(ansi: string): PaneRead;
}

const ADAPTERS: Record<AgentKind, ConvAdapter> = { claude: claudeAdapter, codex: codexAdapter };

export function adapterFor(kind: AgentKind): ConvAdapter {
  return ADAPTERS[kind];
}
