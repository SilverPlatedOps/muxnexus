import { open } from "node:fs/promises";
import type { AgentKind } from "../../shared/chat";
import { tagForms } from "./adapters";

/**
 * What an agent said in its own tab in one turn, read from its transcript, so
 * the user can hold a chat post against everything the agent concluded. Prose
 * only: its thinking, tool calls and their output stay out.
 */

export interface Said {
  text: string;
  /** The turn has closed in the transcript: nothing more will be added to it. */
  ended: boolean;
}

/**
 * Which turn: the one under way at byte `at`, where the transcript stood when
 * the agent posted; or the one holding `tag` after `from`, a message the chat
 * woke it with.
 */
export type Where = { at: number } | { from?: number; tag: string };

interface Row {
  pos: number;
  open?: boolean;
  close?: boolean;
  text?: string;
  tag?: boolean;
}

// Transcript rows are whatever the agent wrote: read loosely, never trusted.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Classify = (row: any) => Omit<Row, "pos" | "tag"> | null;

const blocks = (content: unknown, type: string): string =>
  Array.isArray(content) ? content.filter((b) => b?.type === type && typeof b.text === "string").map((b) => b.text as string).join("") : "";

/**
 * Claude Code: a prompt opens a turn -- the user's, a peer's, a finished
 * task's, not text Claude Code adds itself -- and `turn_duration` closes it.
 */
const claude: Classify = (r) => {
  if (r.isSidechain) return null;
  if (r.type === "system") return r.subtype === "turn_duration" ? { close: true } : null;
  if (r.type === "assistant") {
    const text = blocks(r.message?.content, "text");
    return text ? { text } : null;
  }
  if (r.type === "user") {
    const c = r.message?.content;
    const prompt = typeof c === "string" || blocks(c, "text") !== "";
    return prompt && (r.origin?.kind || (!r.isMeta && !r.isCompactSummary)) ? { open: true } : null;
  }
  return null;
};

/** Codex: `task_started` opens a turn, `task_complete` or `turn_aborted` closes it; it speaks in commentary and a final answer. */
const codex: Classify = (r) => {
  const p = r.payload ?? {};
  if (r.type === "event_msg") return p.type === "task_started" ? { open: true } : p.type === "task_complete" || p.type === "turn_aborted" ? { close: true } : null;
  if (r.type === "response_item" && p.type === "message" && p.role === "assistant") {
    const text = blocks(p.content, "output_text");
    return text ? { text } : null;
  }
  return null;
};

/** Each kind's rows, and a cheap test for lines worth parsing. */
const KINDS: Record<AgentKind, { classify: Classify; hint: RegExp }> = {
  claude: { classify: claude, hint: /"type":"(user|assistant|system)"/ },
  codex: { classify: codex, hint: /"type":"(event_msg|response_item)"/ },
};

/** How much of a transcript is read either side of where the turn is. */
const SPAN = 8 * 1024 * 1024;

/** What the agent said in one turn, or null when the transcript or the turn can't be found. */
export async function said(kind: AgentKind, path: string, where: Where): Promise<Said | null> {
  const { classify, hint } = KINDS[kind];
  let fh;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const tagged = "tag" in where;
    // A file shorter than `from` was replaced: all of it is new.
    const lo = tagged
      ? where.from === undefined ? Math.max(0, size - SPAN) : where.from <= size ? where.from : 0
      : Math.max(0, Math.min(where.at, size) - SPAN);
    const hi = Math.min(size, tagged ? lo + 2 * SPAN : where.at + SPAN);
    // From the byte before, so a window that starts mid-line skips that piece
    // and one that starts on a line keeps it.
    const base = Math.max(0, lo - 1);
    const buf = Buffer.alloc(hi - base);
    await fh.read(buf, 0, buf.length, base);
    const forms = tagged ? tagForms(where.tag) : [];

    const rows: Row[] = [];
    let i = lo === 0 ? 0 : buf.indexOf(10) + 1;
    if (lo > 0 && i === 0) return null;
    while (i < buf.length) {
      let j = buf.indexOf(10, i);
      if (j === -1) j = buf.length;
      const line = buf.toString("utf8", i, j);
      const pos = base + i;
      i = j + 1;
      const tag = tagged && forms.some((f) => line.includes(f));
      let row: Omit<Row, "pos" | "tag"> | null = null;
      if (hint.test(line)) {
        try {
          row = classify(JSON.parse(line));
        } catch {
          // a line still being written
        }
      }
      if (row || tag) rows.push({ pos, ...row, ...(tag ? { tag: true } : {}) });
    }

    let t = tagged ? rows.findIndex((r) => r.tag) : rows.findLastIndex((r) => r.pos < (where as { at: number }).at);
    if (t === -1) return null;
    // A post is always inside a turn: if the last row before it closed one,
    // its own turn hadn't reached the file yet, and is the next.
    if (!tagged && rows[t]!.close) {
      t = rows.findIndex((r, k) => k > t && r.open);
      if (t === -1) return { text: "", ended: false };
    }
    let start = 0;
    for (let k = t; k >= 0; k--) {
      if (rows[k]!.open) { start = k; break; }
      if (k < t && rows[k]!.close) { start = k + 1; break; }
    }
    let end = rows.length - 1;
    let ended = false;
    for (let k = t + 1; k < rows.length; k++) {
      if (rows[k]!.close) { end = k; ended = true; break; }
      if (rows[k]!.open) { end = k - 1; ended = true; break; }
    }
    const text = rows.slice(start, end + 1).map((r) => r.text?.trim() ?? "").filter(Boolean).join("\n\n");
    return { text, ended };
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
