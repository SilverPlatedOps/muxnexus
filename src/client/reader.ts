// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * A Markdown file read beside the terminal -- a plan an agent linked to --
 * styled as a note is (note-editor.ts) but never edited, and read again while
 * it is open, so a plan the agent revises shows its new version where you are.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLook } from "./note-editor";

/** How often an open file is read again. */
const READ_MS = 2000;
/** A read that has not answered by then is given up: one hung read must not stop every later one. */
const GIVE_UP_MS = 10_000;

/**
 * The one span where the file's text `raw` differs from the document `prev`,
 * or null when they are the same. Replacing only that keeps everything above
 * it where it was on screen. The document keeps line breaks as \n, whatever
 * the file has: compared raw, a CRLF file would differ on every read.
 */
export function textChange(prev: string, raw: string): { from: number; to: number; insert: string } | null {
  const next = raw.replace(/\r\n?/g, "\n");
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  return { from: start, to: prev.length - end, insert: next.slice(start, next.length - end) };
}

export interface Reader {
  readonly el: HTMLElement;
  /** Show the file at `target`, a `/file` address, from its top. */
  open(target: string): void;
  close(): void;
  focus(): void;
}

export function createReader(): Reader {
  const view = new EditorView({
    state: EditorState.create({
      extensions: [markdownLook, EditorState.readOnly.of(true), EditorView.editable.of(false)],
    }),
  });
  // Not editable, CodeMirror takes no focus. The scroller does, so the keys
  // scroll it and the pane it is in knows it was chosen.
  view.scrollDOM.tabIndex = 0;
  view.scrollDOM.setAttribute("aria-label", "File");
  const el = document.createElement("div");
  el.className = "reader";
  const missing = document.createElement("p");
  missing.className = "reader-missing";
  missing.hidden = true;
  el.append(view.dom, missing);
  el.addEventListener("pointerdown", () => view.scrollDOM.focus({ preventScroll: true }));

  /** What was opened, and what to read again: the file it resolved to, not a reference relative to a directory that can change. */
  let target: string | null = null;
  let again: string | null = null;
  /** The file a read is out for: one at a time per file, a newly opened one never waiting on the last. */
  let reading: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function show(text: string) {
    const change = textChange(view.state.doc.toString(), text);
    if (change) view.dispatch({ changes: change });
  }

  async function read() {
    const asked = target;
    if (!asked || reading === asked) return;
    reading = asked;
    try {
      const res = await fetch(again ?? asked, { cache: "no-store", signal: AbortSignal.timeout(GIVE_UP_MS) }).catch(() => null);
      if (asked !== target) return;
      if (!res?.ok) {
        // Gone or unreadable: say so the first time, and keep the last version shown after that.
        if (view.state.doc.length === 0) {
          missing.textContent = "Can't read this file.";
          missing.hidden = false;
        }
        return;
      }
      const resolved = res.headers.get("x-file-path");
      if (resolved) again = `/file?path=${resolved}`;
      const text = await res.text().catch(() => null);
      if (text === null || asked !== target) return;
      missing.hidden = true;
      show(text);
    } finally {
      if (reading === asked) reading = null;
    }
  }

  function close() {
    clearInterval(timer);
    timer = undefined;
    target = again = null;
    missing.hidden = true;
    show("");
  }

  return {
    el,
    open(next) {
      close();
      target = next;
      void read();
      // Only while it is on screen: not behind a zoomed terminal, nor in a hidden page.
      timer = setInterval(() => { if (!document.hidden && el.offsetParent !== null) void read(); }, READ_MS);
    },
    close,
    focus: () => view.scrollDOM.focus({ preventScroll: true }),
  };
}
