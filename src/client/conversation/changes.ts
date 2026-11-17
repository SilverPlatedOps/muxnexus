// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ChangedFile, ChangesError } from "../../shared/conversation";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

/**
 * The Changes sheet: what is uncommitted in the folder the tab's agent works
 * in, against the last commit, read on the phone before saying "commit". It is
 * the folder's state, not the agent's work: an agent that has committed leaves
 * nothing here, and a change made at the desk shows too. Each file's diff is
 * read when it is opened, so a long list costs one git call.
 */

export interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx" | "note";
  text: string;
}

/** A unified diff as rows, from its first hunk: the file headers above it say nothing the list doesn't. */
export function diffRows(diff: string): DiffRow[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first === -1) return [];
  return lines.slice(first).map((l): DiffRow => {
    if (l.startsWith("@@")) return { kind: "hunk", text: l };
    if (l.startsWith("+")) return { kind: "add", text: l.slice(1) };
    if (l.startsWith("-")) return { kind: "del", text: l.slice(1) };
    if (l.startsWith("\\")) return { kind: "note", text: l.slice(2) };
    return { kind: "ctx", text: l.slice(1) };
  });
}

/** "3 files · +12 −4": the whole change in a line, or, with files not listed, the lines of those that are. */
export function changesLine(files: readonly ChangedFile[], more: number): string {
  const n = files.length + more;
  const added = files.reduce((s, f) => s + (f.added ?? 0), 0);
  const removed = files.reduce((s, f) => s + (f.removed ?? 0), 0);
  return `${n} file${n === 1 ? "" : "s"} · +${added} −${removed}${more > 0 ? ` in the ${files.length} listed` : ""}`;
}

/** What a diff with no lines means, for a file of this status. */
const NO_LINES: Record<ChangedFile["status"], string> = {
  added: "An empty file, added",
  untracked: "An empty file",
  deleted: "An empty file, deleted",
  modified: "No lines changed: only the file's mode",
};

export const CHANGES_ERROR: Record<ChangesError, string> = {
  "no-folder": "This tab has no agent, so no folder to read",
  "not-git": "The agent's folder isn't in a git repository",
  git: "Couldn't read the changes: git failed",
  gone: "Not changed any more: refresh the list",
};

const STATUS: Record<ChangedFile["status"], { mark: string; word: string }> = {
  modified: { mark: "M", word: "Modified" },
  added: { mark: "A", word: "Added" },
  deleted: { mark: "D", word: "Deleted" },
  untracked: { mark: "U", word: "New, not added to git" },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A home folder written as `~`, as the desk's prompt shows it. */
const homeShort = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

export function createChanges(deps: { send: (m: ClientMessage) => void; windowId: () => string | null }) {
  const pane = el("div", "conv-sheet-pane conv-changes");
  let seq = 0;
  let listReq: string | null = null;
  /** Each diff asked for: where it goes. A refresh forgets them. */
  const diffs = new Map<string, HTMLElement>();
  const note = (text: string) => el("div", "conv-sheet-note", text);

  function show() {
    const windowId = deps.windowId();
    if (!windowId) return;
    listReq = `changes-${++seq}`;
    diffs.clear();
    pane.replaceChildren(note("Reading changes…"));
    deps.send({ t: "conv-changes", req: listReq, windowId });
  }

  function drawList(m: Extract<ServerMessage, { t: "conv-changes-result" }>) {
    if (m.error || m.root === null) {
      pane.replaceChildren(note(CHANGES_ERROR[m.error ?? "git"]));
      return;
    }
    const head = el("div", "conv-changes-head");
    const where = el("div", "conv-changes-where");
    where.append(el("span", "conv-changes-branch", m.branch ?? "detached HEAD"), el("span", "conv-changes-root", homeShort(m.root)));
    const refresh = el("button", "conv-sheet-btn", "Refresh");
    refresh.type = "button";
    refresh.onclick = show;
    const top = el("div", "conv-changes-top");
    top.append(where, refresh);
    head.append(top, el("div", "conv-changes-line", m.files.length === 0 ? "Nothing uncommitted" : `${changesLine(m.files, m.more)}, uncommitted`));
    const rows = m.files.map((f) => fileRow(m.windowId, f));
    if (m.more > 0) rows.push(note(`${m.more} more not listed`));
    pane.replaceChildren(head, ...rows);
  }

  function fileRow(windowId: string, f: ChangedFile): HTMLElement {
    const d = el("details", `conv-change ${f.status}`);
    const s = el("summary", "conv-change-row");
    const st = STATUS[f.status];
    const mark = el("span", "conv-change-mark", st.mark);
    mark.title = st.word;
    mark.setAttribute("aria-label", st.word);
    const slash = f.path.lastIndexOf("/");
    const path = el("span", "conv-change-path");
    if (slash >= 0) path.append(el("span", "conv-change-dir", f.path.slice(0, slash + 1)));
    path.append(el("span", "conv-change-name", f.path.slice(slash + 1)));
    const counts = el("span", "conv-change-counts");
    if (f.binary) counts.append(el("span", "conv-change-bin", "binary"));
    else {
      if (f.added !== null) counts.append(el("span", "conv-change-add", `+${f.added}`));
      if (f.removed !== null && f.removed > 0) counts.append(el("span", "conv-change-del", `−${f.removed}`));
    }
    s.append(mark, path, counts);
    const body = el("div", "conv-diff");
    body.dataset.status = f.status;
    d.append(s, body);
    // Read when first opened; a file opened again shows what it read then (Refresh reads the list again).
    d.addEventListener("toggle", () => {
      if (!d.open || body.dataset.asked) return;
      body.dataset.asked = "1";
      if (f.binary) {
        body.append(note("A binary file: no lines to show"));
        return;
      }
      const req = `diff-${++seq}`;
      diffs.set(req, body);
      body.append(note("Reading the diff…"));
      deps.send({ t: "conv-diff", req, windowId, path: f.path });
    });
    return d;
  }

  function drawDiff(body: HTMLElement, m: Extract<ServerMessage, { t: "conv-diff-result" }>) {
    if (m.error) {
      // Opened again, it asks again.
      delete body.dataset.asked;
      return body.replaceChildren(note(CHANGES_ERROR[m.error]));
    }
    if (m.binary) return body.replaceChildren(note("A binary file: no lines to show"));
    const rows = diffRows(m.diff);
    if (rows.length === 0) return body.replaceChildren(note(NO_LINES[(body.dataset.status ?? "modified") as ChangedFile["status"]]));
    // Long lines scroll sideways together, each row's colour as wide as the widest.
    const lines = el("div", "conv-diff-lines");
    const inner = el("div", "conv-diff-inner");
    for (const r of rows) {
      const row = el("div", `conv-diff-row ${r.kind}`);
      row.append(el("span", "conv-diff-sign", r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""), el("span", "conv-diff-text", r.text));
      inner.append(row);
    }
    lines.append(inner);
    body.replaceChildren(lines);
    if (m.truncated) body.append(note("Cut short here: the rest is at the desk"));
  }

  /** A message for the sheet: whether it was one. */
  function onMessage(m: ServerMessage): boolean {
    if (m.t === "conv-changes-result") {
      if (m.req === listReq && m.windowId === deps.windowId()) {
        listReq = null;
        drawList(m);
      }
      return true;
    }
    if (m.t === "conv-diff-result") {
      const body = diffs.get(m.req);
      if (body && m.windowId === deps.windowId()) {
        diffs.delete(m.req);
        drawDiff(body, m);
      }
      return true;
    }
    return false;
  }

  return { pane, show, onMessage };
}
