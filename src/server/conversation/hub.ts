// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { stat } from "node:fs/promises";
import type { AgentKind } from "../../shared/chat";
import type { Card, GenericKey } from "../../shared/conversation";
import type { ServerMessage } from "../../shared/protocol";
import type { Tmux, WindowAgentInfo } from "../tmux";
import { adapterFor } from "./adapter";
import { answer, conversationOf, pendingQuestionMulti, pressKey, screenPane, sendText, stop } from "./actions";
import { linksIn, readPage, readSince, searchFile } from "./reader";

/**
 * The conversation view's live side. A socket has at most one tab's
 * conversation open; while any socket has one, a timer reads what each agent
 * appended to its file and the dialog it waits on, and pushes both. Nothing
 * here attaches, selects a window or resizes: the desk's terminal never
 * changes because the phone looked.
 */

export type HubTmux = Pick<Tmux, "agentOfWindow" | "activePane" | "capturePane" | "pasteInto" | "sendKeys" | "paneSize">;

/** What the hub needs of a socket; Bun's ServerWebSocket is one. */
export interface HubSocket {
  readonly readyState: number;
  sendText(data: string): unknown;
}

export type ConversationHub = ReturnType<typeof createConversationHub>;

interface Sub {
  windowId: string;
  kind: AgentKind | null;
  conversation: string | null;
  path: string | null;
  /** Byte offset read up to; null while the file can't be read (not written yet). */
  end: number | null;
  /** The last `conv-card` sent, as `fingerprint|selected|screen|working`. */
  card: string | null;
  /** Whether the pending question has a multi-select part, for the card and file length it was worked out at. */
  multi: { key: string; value: boolean } | null;
  /** A read for it is under way: the timer skips it rather than read twice. */
  busy: boolean;
}

/** A second answer to the same dialog this soon is a double tap: it would answer whatever came next. */
const ANSWER_AGAIN_MS = 2000;
const OPEN = 1;

const transcriptOf = (info: WindowAgentInfo | null): string | null =>
  (info?.kind === "claude" ? info.conversation?.transcriptPath : info?.thread?.path) ?? null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createConversationHub({ tmux, pollMs = 1000 }: { tmux: HubTmux; pollMs?: number }) {
  const subs = new Map<HubSocket, Sub>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const send = (ws: HubSocket, m: ServerMessage) => {
    if (ws.readyState === OPEN) ws.sendText(JSON.stringify(m));
  };
  /** Still the socket's open conversation: a newer open or a close makes a read in flight moot. */
  const current = (ws: HubSocket, sub: Sub) => subs.get(ws) === sub;

  /** The timer runs only while some socket has a conversation open. */
  function sync() {
    if (subs.size > 0 && !timer) timer = setInterval(() => { for (const [ws, sub] of subs) void tick(ws, sub); }, pollMs);
    else if (subs.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * The tab's newest page as a fresh `conv`, replacing whatever the socket
   * showed; the card is sent anew after it. `retry`: the file couldn't be read
   * before, and still unreadable there is nothing new to say.
   */
  async function load(ws: HubSocket, sub: Sub, info: WindowAgentInfo | null, retry = false) {
    const kind = info?.kind ?? null;
    const path = transcriptOf(info);
    // The last page, never a read from 0 forward: a file can be tens of megabytes.
    const page = kind && path ? await readPage(kind, path, {}).catch(() => null) : null;
    if (!current(ws, sub) || (retry && !page)) return;
    Object.assign(sub, { kind, conversation: info ? conversationOf(info) : null, path, end: page?.end ?? null, card: null, multi: null });
    send(ws, {
      t: "conv", windowId: sub.windowId, agent: sub.kind, conversation: sub.conversation,
      items: page?.items ?? [], start: page?.start ?? 0, end: page?.end ?? 0,
    });
  }

  /** Rows appended since the last read, as `conv-items`. A file shorter than what was read was replaced: sent afresh. */
  async function appended(ws: HubSocket, sub: Sub, info: WindowAgentInfo | null) {
    if (!sub.kind || !sub.path) return;
    const size = (await stat(sub.path).catch(() => null))?.size;
    if (size === undefined) return;
    if (sub.end === null) return load(ws, sub, info, true);
    if (size < sub.end) return load(ws, sub, info);
    if (size === sub.end) return;
    const page = await readSince(sub.kind, sub.path, sub.end);
    if (!current(ws, sub)) return;
    // readSince starts over from 0 on a file shorter than asked: it was replaced between the two looks.
    if (page.start !== sub.end) return load(ws, sub, info);
    sub.end = page.end;
    if (page.items.length > 0) send(ws, { t: "conv-items", windowId: sub.windowId, items: page.items });
  }

  /**
   * What the tab waits on, sent when it changed. The pane is read only while
   * the stamp says waiting; anything a card can't answer shows Screen.
   */
  async function card(ws: HubSocket, sub: Sub, info: WindowAgentInfo | null) {
    let card: Card | null = null;
    let screen = false;
    let working = info?.state === "running";
    if (info?.state === "input") {
      const read = await tmux.capturePane(info.paneId).then((ansi) => adapterFor(info.kind).readPane(ansi)).catch(() => null);
      card = read?.dialog ?? null;
      working ||= read?.working ?? false;
      // A waiting stamp over a pane showing no dialog may be stale: Screen, never a guess.
      screen = !read || read.unrecognised || !!read.field || !card;
      // The pane shows one question at a time: a multi-select one later in the call would be met half-answered (Decision 4).
      if (card?.kind === "question" && !screen) screen = await multiSelect(sub, info, card);
      if (screen) card = null;
    }
    const key = `${card?.fingerprint ?? ""}|${card?.selected ?? ""}|${screen}|${working}`;
    if (!current(ws, sub) || key === sub.card) return;
    sub.card = key;
    send(ws, { t: "conv-card", windowId: sub.windowId, card, screen, working });
  }

  async function multiSelect(sub: Sub, info: WindowAgentInfo, card: Card): Promise<boolean> {
    const key = `${card.fingerprint}@${sub.end}`;
    if (sub.multi?.key !== key) {
      sub.multi = { key, value: await pendingQuestionMulti(info.kind, transcriptOf(info) ?? "").catch(() => true) };
    }
    return sub.multi.value;
  }

  const sameTab = (sub: Sub, info: WindowAgentInfo | null) =>
    (info?.kind ?? null) === sub.kind && (info ? conversationOf(info) : null) === sub.conversation && transcriptOf(info) === sub.path;

  async function tick(ws: HubSocket, sub: Sub) {
    if (sub.busy) return;
    sub.busy = true;
    try {
      const info = await tmux.agentOfWindow(sub.windowId);
      if (!current(ws, sub)) return;
      if (sameTab(sub, info)) await appended(ws, sub, info);
      else await load(ws, sub, info);
      if (current(ws, sub)) await card(ws, sub, info);
    } catch {
      // A file or pane that vanished mid-read: the next tick reads again.
    } finally {
      sub.busy = false;
    }
  }

  /** The conversation file behind `windowId`: the open one's while it is open, so the offsets the socket holds mean that file. */
  async function fileOf(ws: HubSocket, windowId: string): Promise<{ kind: AgentKind; path: string } | null> {
    const sub = subs.get(ws);
    if (sub?.windowId === windowId && sub.kind && sub.path) return { kind: sub.kind, path: sub.path };
    const info = await tmux.agentOfWindow(windowId);
    const path = transcriptOf(info);
    return info && path ? { kind: info.kind, path } : null;
  }

  /** One action at a time per tab, in the order they came: each reads the pane the one before left. */
  const lanes = new Map<string, Promise<unknown>>();
  function inLane<T>(windowId: string, work: () => Promise<T>): Promise<T> {
    const run = (lanes.get(windowId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    lanes.set(windowId, tail);
    void tail.then(() => { if (lanes.get(windowId) === tail) lanes.delete(windowId); });
    return run;
  }
  const lastAnswer = new Map<string, { fingerprint: string; at: number }>();

  /** An action that threw: its request is still answered, and the reason sent to show. */
  function failed(ws: HubSocket, req: string, e: unknown) {
    send(ws, { t: "conv-result", req, ok: false });
    send(ws, { t: "error", message: errorText(e) });
  }

  return {
    /** Shows `windowId`'s conversation on `ws`, in place of any other, then keeps it current. */
    async open(ws: HubSocket, windowId: string) {
      const sub: Sub = { windowId, kind: null, conversation: null, path: null, end: null, card: null, multi: null, busy: true };
      subs.set(ws, sub);
      sync();
      try {
        const info = await tmux.agentOfWindow(windowId);
        if (!current(ws, sub)) return;
        await load(ws, sub, info);
        if (current(ws, sub)) await card(ws, sub, info);
      } finally {
        sub.busy = false;
      }
    },

    close(ws: HubSocket) {
      subs.delete(ws);
      sync();
    },

    async more(ws: HubSocket, windowId: string, before: number) {
      const f = await fileOf(ws, windowId);
      const page = f ? await readPage(f.kind, f.path, { before }).catch(() => null) : null;
      send(ws, { t: "conv-page", windowId, items: page?.items ?? [], start: page?.start ?? 0, end: page?.end ?? 0 });
    },

    async around(ws: HubSocket, windowId: string, offset: number) {
      const f = await fileOf(ws, windowId);
      const page = f ? await readPage(f.kind, f.path, { around: offset }).catch(() => null) : null;
      send(ws, { t: "conv-page", windowId, items: page?.items ?? [], start: page?.start ?? 0, end: page?.end ?? 0 });
    },

    async search(ws: HubSocket, req: string, windowId: string, query: string, cursor?: number) {
      const f = await fileOf(ws, windowId);
      const r = f ? await searchFile(f.kind, f.path, query, cursor === undefined ? {} : { cursor }).catch(() => null) : null;
      send(ws, { t: "conv-search-result", req, hits: r?.hits ?? [], ...(r?.next !== undefined ? { next: r.next } : {}) });
    },

    async links(ws: HubSocket, req: string, windowId: string) {
      const f = await fileOf(ws, windowId);
      const links = f ? await linksIn(f.kind, f.path).catch(() => []) : [];
      send(ws, { t: "conv-links-result", req, links });
    },

    async send(ws: HubSocket, req: string, windowId: string, conversation: string, text: string, replace: boolean) {
      try {
        const r = await inLane(windowId, () => sendText(tmux, windowId, conversation, text, replace));
        send(ws, { t: "conv-result", req, ...r });
      } catch (e) {
        failed(ws, req, e);
      }
    },

    async answer(ws: HubSocket, req: string, windowId: string, conversation: string, fingerprint: string, option: number, text?: string) {
      // Counted from when an answer arrives, not when it is done: a double tap queued behind the first would answer the next dialog.
      const last = lastAnswer.get(windowId);
      if (last?.fingerprint === fingerprint && Date.now() - last.at < ANSWER_AGAIN_MS) {
        return send(ws, { t: "conv-result", req, ok: false, error: "prompt-changed" });
      }
      lastAnswer.set(windowId, { fingerprint, at: Date.now() });
      try {
        const r = await inLane(windowId, () => answer(tmux, windowId, conversation, fingerprint, option, text));
        send(ws, { t: "conv-result", req, ...r });
      } catch (e) {
        failed(ws, req, e);
      }
    },

    /** Stop: always answered for `req`, so a refusal can be shown. */
    async interrupt(ws: HubSocket, req: string, windowId: string) {
      try {
        const r = await inLane(windowId, () => stop(tmux, windowId));
        send(ws, { t: "conv-result", req, ...r });
      } catch (e) {
        failed(ws, req, e);
      }
    },

    async screen(ws: HubSocket, req: string, windowId: string) {
      try {
        const pane = await screenPane(tmux, windowId);
        const [ansi, size] = await Promise.all([tmux.capturePane(pane), tmux.paneSize(pane)]);
        send(ws, { t: "conv-screen-result", req, ansi, ...size });
      } catch (e) {
        send(ws, { t: "conv-screen-result", req, ansi: "", cols: 0, rows: 0 });
        send(ws, { t: "error", message: errorText(e) });
      }
    },

    async key(ws: HubSocket, windowId: string, key: GenericKey) {
      await inLane(windowId, () => pressKey(tmux, windowId, key)).catch((e) => send(ws, { t: "error", message: errorText(e) }));
    },

    /** Stops the timer; for the server's own stop. */
    stop() {
      subs.clear();
      sync();
    },
  };
}
