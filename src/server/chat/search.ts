import { SEARCH_LIMITS, type Chat, type ChatSearchHit } from "../../shared/chat";

/**
 * The browser's search over chats: names, what was posted, and the user's
 * notes. Literal and case-insensitive: every word of the query must appear.
 * Only for the browser -- agents read chats through `mux read`, which never
 * sees notes, and this is no tool of theirs.
 */

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The text around the first word found, at most the excerpt limit, on one line. */
export function excerptOf(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const max = SEARCH_LIMITS.excerpt;
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), flat.length);
  const start = Math.max(0, Math.min(at - 60, flat.length - max + 1));
  const lead = start > 0 ? "…" : "";
  const body = flat.slice(start + (lead ? 1 : 0), start + max - 1);
  return `${lead}${body}${start + max - 1 < flat.length ? "…" : ""}`;
}

/**
 * Hits newest chat first; in each, its name, its notes, then its messages
 * newest first. `cursor` is how many hits earlier pages took.
 */
export function searchChats(chats: Iterable<Chat>, query: string, opts: { chatId?: string; cursor?: number } = {}): { hits: ChatSearchHit[]; next?: number } {
  const words = queryWords(query);
  if (!words.length) return { hits: [] };
  const has = (text: string) => { const t = text.toLowerCase(); return words.every((w) => t.includes(w)); };
  const from = opts.cursor ?? 0;
  const out: ChatSearchHit[] = [];
  let seen = 0;
  // One past the page says whether there is a next one.
  const take = (hit: () => ChatSearchHit) => {
    if (seen++ >= from) out.push(hit());
    return out.length > SEARCH_LIMITS.page;
  };
  const list = [...chats].filter((c) => !opts.chatId || c.id === opts.chatId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const c of list) {
    const base = { chatId: c.id, chatName: c.name, archived: !!c.archived };
    // Within one chat, its own name is no find.
    if (!opts.chatId && has(c.name) && take(() => ({ kind: "chat", ...base, excerpt: c.name }))) break;
    if (c.notes?.text && has(c.notes.text) && take(() => ({ kind: "note", ...base, at: c.notes!.updatedAt, excerpt: excerptOf(c.notes!.text, words) }))) break;
    let full = false;
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i]!;
      if (m.system || !has(m.text)) continue;
      if (take(() => ({ kind: "message", ...base, messageId: m.id, from: m.from, at: m.at, excerpt: excerptOf(m.text, words) }))) { full = true; break; }
    }
    if (full) break;
  }
  return out.length > SEARCH_LIMITS.page ? { hits: out.slice(0, SEARCH_LIMITS.page), next: from + SEARCH_LIMITS.page } : { hits: out };
}
