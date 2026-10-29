// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { MAX_NOTES, type Chat, type ChatNotes } from "../../shared/chat";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

type NotesResult = Extract<ServerMessage, { t: "chat-notes-result" }>;

const DRAFTS_KEY = "muxnexus.chat-notes-drafts";
/** Typing stops this long before a save goes. */
const DEBOUNCE_MS = 800;
/** A save with no answer by now is taken as lost: the draft stays and Retry shows. */
const LOST_MS = 15_000;

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag); e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
function button(text: string, action: () => void) {
  const b = node("button", "chat-btn", text); b.type = "button"; b.onclick = action; return b;
}

/** Unsaved notes per chat, and the revision they were written on: they outlive a reload or a dropped socket. */
interface Draft { text: string; baseRev: number }
function drafts(): Record<string, Draft> {
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, Draft>; } catch { return {}; }
}
function keepDraft(chatId: string, d: Draft | null) {
  const all = drafts();
  if (d) all[chatId] = d; else delete all[chatId];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch { /* private window: the editor still holds it */ }
}

const EMPTY: ChatNotes = { text: "", rev: 0, updatedAt: "" };

/**
 * The user's notes on a chat: one document, saved by revision so two browsers
 * can't overwrite each other, and never handed to an agent. Saved means the
 * server wrote it, not that it was sent.
 */
export function createChatNotes(send: (m: ClientMessage) => boolean, shareAsBrief: (text: string) => void) {
  const el = node("section", "chat-notes");
  const bar = node("div", "chat-notes-bar");
  const status = node("span", "chat-notes-status"); status.setAttribute("role", "status");
  const count = node("span", "chat-notes-count");
  const share = button("Share as brief…", () => {
    const sel = area.value.slice(area.selectionStart, area.selectionEnd);
    shareAsBrief(sel.trim() ? sel : area.value);
  });
  share.title = "Selected text, or the whole note, as the shared brief. You review it first; agents are not woken.";
  bar.append(status, node("span", "sp"), count, share);
  const area = node("textarea", "chat-notes-text");
  area.maxLength = MAX_NOTES;
  area.placeholder = "Your notes on this chat. Only you see them: agents never receive them.";
  area.setAttribute("aria-label", "Chat notes");
  const conflict = node("div", "chat-notes-conflict"); conflict.setAttribute("role", "alert"); conflict.hidden = true;
  el.append(bar, conflict, area);

  let chatId: string | null = null;
  /** The server's notes for the open chat, as last heard. */
  let server: ChatNotes = EMPTY;
  /** The revision the editor's text was written on. */
  let baseRev = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves sent and not answered, by request id: an answer for a chat no longer open still settles its draft. */
  const inflight = new Map<string, { chatId: string; text: string; lost: ReturnType<typeof setTimeout> }>();
  /** Saves given up on as lost: an answer that comes late still settles them. */
  const late = new Map<string, { chatId: string; text: string }>();
  let clash: ChatNotes | null = null;
  let failure = "";
  /** What the status and conflict bar last showed: rebuilt only on a change, so a click never lands on a replaced button. */
  let shown = "";
  let shownClash: ChatNotes | null = null;

  const busy = () => [...inflight.values()].some((f) => f.chatId === chatId);
  const dirty = () => area.value !== server.text || baseRev !== server.rev;

  function paint() {
    count.textContent = `${area.value.length.toLocaleString("en-US")} / ${MAX_NOTES.toLocaleString("en-US")}`;
    share.disabled = !area.value.trim();
    const state = clash ? "conflict" : busy() ? "saving" : failure ? "error" : dirty() ? "unsaved" : "saved";
    el.dataset.state = state;
    const said =
      state === "conflict" ? "Conflict: changed in another window"
        : state === "saving" ? "Saving…"
        : state === "error" ? `Not saved: ${failure}`
        : state === "unsaved" ? "Unsaved"
        : server.rev ? `Saved${server.updatedAt ? ` · ${new Date(server.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}` : "No notes yet";
    if (said !== shown) {
      shown = said;
      status.replaceChildren(said);
      if (state === "error") status.append(" ", button("Retry", save));
    }
    conflict.hidden = !clash;
    if (clash && clash !== shownClash) {
      const theirs = clash;
      const peek = node("details", "chat-notes-theirs");
      const pre = node("pre", "", theirs.text || "(empty)");
      peek.append(node("summary", "", `Their version · rev ${theirs.rev}`), pre);
      const mine = button("Save mine over it", () => { clash = null; baseRev = theirs.rev; server = theirs; keepDraft(chatId!, { text: area.value, baseRev }); save(); });
      const take = button("Use theirs, drop mine", () => { clash = null; server = theirs; baseRev = theirs.rev; area.value = theirs.text; keepDraft(chatId!, null); paint(); });
      conflict.replaceChildren(node("p", "", "These notes were saved from another window since you started editing. Your text is kept here."), peek, mine, take);
    }
    shownClash = clash;
  }

  function save() {
    clearTimeout(timer);
    if (!chatId || clash || busy() || !dirty()) return paint();
    const req = crypto.randomUUID();
    const text = area.value;
    failure = "";
    if (!send({ t: "chat-notes", id: chatId, text, rev: baseRev, req })) { failure = "offline; it saves when the connection is back"; return paint(); }
    const id = chatId;
    inflight.set(req, { chatId: id, text, lost: setTimeout(() => { inflight.delete(req); late.set(req, { chatId: id, text }); if (chatId === id) { failure = "no answer from the server"; paint(); } }, LOST_MS) });
    paint();
  }

  area.addEventListener("input", () => {
    if (!chatId) return;
    keepDraft(chatId, { text: area.value, baseRev });
    failure = "";
    clearTimeout(timer);
    timer = setTimeout(save, DEBOUNCE_MS);
    paint();
  });
  area.addEventListener("blur", () => { if (dirty()) save(); });

  /** Open a chat's notes: the saved text, or the draft left unsaved on it. */
  function load(c: Chat) {
    // What was typed in the last moment before switching goes now, not when this chat is next opened.
    if (chatId && dirty()) save();
    clearTimeout(timer);
    chatId = c.id; server = c.notes ?? EMPTY; clash = null; failure = "";
    const d = drafts()[c.id];
    if (d && d.text !== server.text) {
      area.value = d.text; baseRev = d.baseRev;
      if (d.baseRev !== server.rev) clash = server;
      else timer = setTimeout(save, DEBOUNCE_MS);
    } else {
      if (d) keepDraft(c.id, null);
      area.value = server.text; baseRev = server.rev;
    }
  }

  return {
    el,
    focus() { area.focus({ preventScroll: true }); },
    update(c: Chat | null) {
      if (!c) { chatId = null; return; }
      if (c.id !== chatId) { load(c); return paint(); }
      const next = c.notes ?? EMPTY;
      if (next.rev === server.rev) return paint();
      // Another window saved. Untouched text follows it; edited text is kept and the clash shown.
      const edited = area.value !== server.text;
      server = next;
      if (busy()) return paint();
      if (!edited) { area.value = next.text; baseRev = next.rev; keepDraft(c.id, null); }
      else if (baseRev !== next.rev) clash = next;
      paint();
    },
    result(r: NotesResult) {
      const f = inflight.get(r.req) ?? late.get(r.req);
      if (!f || f.chatId !== r.id) return;
      if (inflight.has(r.req)) clearTimeout(inflight.get(r.req)!.lost);
      inflight.delete(r.req);
      late.delete(r.req);
      if (r.ok && r.notes) {
        if (r.id !== chatId) {
          const d = drafts()[r.id];
          keepDraft(r.id, d && d.text !== f.text ? { text: d.text, baseRev: r.notes.rev } : null);
          return;
        }
        server = r.notes; baseRev = r.notes.rev;
        if (area.value === f.text) keepDraft(r.id, null);
        else { keepDraft(r.id, { text: area.value, baseRev }); timer = setTimeout(save, DEBOUNCE_MS); }
      } else if (r.id === chatId) {
        if (r.conflict && r.notes) clash = r.notes;
        else failure = r.error ?? "the server refused it";
      }
      paint();
    },
    /** A connection back: anything still unsaved goes again. */
    reconnected() { if (chatId && dirty() && !clash) save(); },
  };
}
