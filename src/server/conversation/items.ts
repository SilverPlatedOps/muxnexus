// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { basename } from "node:path";

/** The handle in a muxnexus room header at the start of `text`, else null. */
export function peerOf(text: string): string | null {
  const m = /^\[muxnexus · [^\]]*? · #\d+ · (?:from @([^\s]+) \([^)]*\) · peer, not the user|from @user · the human, via muxnexus|from muxnexus · the room, not the user)\]/.exec(text);
  if (!m) return null;
  if (m[1]) return m[1];
  return m[0].includes("from @user") ? "user" : "muxnexus";
}

/** The text after a room header line. */
export function afterHeader(text: string): string {
  return text.replace(/^\[muxnexus · [^\n]*\]\n*/, "");
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** One line saying what a tool did. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stepSummary(tool: string, input: any): string {
  const file = typeof input?.file_path === "string" ? basename(input.file_path) : "";
  switch (tool) {
    case "Bash": {
      const cmd = typeof input?.command === "string" ? input.command : typeof input?.cmd === "string" ? input.cmd : "";
      return cmd ? `Ran ${clip(cmd.split("\n")[0]!, 80)}` : tool;
    }
    case "Edit": return file ? `Edited ${file}` : tool;
    case "Write": return file ? `Wrote ${file}` : tool;
    case "Read": return file ? `Read ${file}` : tool;
    case "Grep":
    case "Glob": return typeof input?.pattern === "string" ? `Searched ${clip(input.pattern, 80)}` : tool;
    default: return tool;
  }
}

/** A tool result's text, whether a string or a list of text blocks. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : "")).join("");
}

/** The raw input, shown when a step is opened. */
export function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input ?? {}, null, 2); } catch { return ""; }
}

/** A stable short id for rows that carry none. */
export function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
