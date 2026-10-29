// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { View, ViewHost } from "../view-host";
import type { WorldEvent } from "../transitions";
import type { WindowRef, World, WorldAgent, WorldAttention, WorldGroup, WorldSession, WorldWindow } from "../world";

/**
 * The world, plainly: every group, session and window with what is known about
 * it and how, and the events between worlds. No art -- this proves the
 * foundation end to end, and is where to look when a playful view seems wrong.
 */

const LOG_MAX = 50;

export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const since = (iso: string, now: number) => formatSpan(now - Date.parse(iso));

export function agentLine(a: WorldAgent, now: number): string {
  let head: string;
  if (a.state === "working") {
    head = a.turnStartedAt
      ? `working ${since(a.turnStartedAt, now)} (turn from ${a.turnSource ?? "hook"})`
      : `working ${since(a.since, now)} (from stamp)`;
  } else if (a.state === "waiting") {
    head = a.waitingSince
      ? `waiting ${since(a.waitingSince, now)} (wait ${a.waitSource ?? "hook"})`
      : `waiting ${since(a.since, now)} (from stamp)`;
  } else {
    head = `idle, ${a.endedBy ?? "finished"}`;
    if (a.turnStartedAt && a.turnEndedAt) {
      head += ` (last turn ${formatSpan(Date.parse(a.turnEndedAt) - Date.parse(a.turnStartedAt))})`;
    }
  }
  return [head, `source ${a.source}`, a.kind, a.account ?? "default"].join(" · ");
}

export function attentionLine(a: WorldAttention, now: number): string {
  const waiting = a.oldestWaitSince ? `${a.waiting} waiting, longest ${since(a.oldestWaitSince, now)}` : `${a.waiting} waiting`;
  return `${waiting} · ${a.unread} unread`;
}

export function eventLine(e: WorldEvent): string {
  const time = new Date(e.at).toTimeString().slice(0, 8);
  const extra = e.kind === "replaced" && e.previous ? ` (was ${e.previous.window})`
    : e.kind === "account-changed" ? ` (${e.from ?? "default"} → ${e.to ?? "default"})`
    : e.source ? ` (${e.source})`
    : "";
  return `${time} ${e.kind} ${e.ref.session} ${e.ref.window}${extra}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text?: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

/** Only touch the DOM when the text changed: a needless write is a needless mutation. */
function setText(e: Element, text: string) {
  if (e.textContent !== text) e.textContent = text;
}

/**
 * Put `items`' elements under `parent` in order, reusing each one's element by
 * key. Children are replaced only when the order changed, so an element that
 * stayed keeps its focus and the list keeps its scroll.
 */
function place<T>(
  parent: HTMLElement,
  items: readonly T[],
  key: (t: T) => string,
  cache: Map<string, HTMLElement>,
  seen: Set<string>,
  make: () => HTMLElement,
  patch: (e: HTMLElement, t: T) => void,
): void {
  const want = items.map((t) => {
    const k = key(t);
    seen.add(k);
    let e = cache.get(k);
    if (!e) {
      e = make();
      cache.set(k, e);
    }
    patch(e, t);
    return e;
  });
  const same = want.length === parent.children.length && want.every((e, i) => parent.children[i] === e);
  if (!same) parent.replaceChildren(...want);
}

function sweep(cache: Map<string, HTMLElement>, seen: Set<string>) {
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
}

export function createDebugView(): View {
  let host: ViewHost | null = null;
  let world: World | null = null;
  let stopTick: (() => void) | null = null;
  const tree = el("div", "dbg-tree");
  const log = el("ol", "dbg-log");
  const groups = new Map<string, HTMLElement>();
  const sessions = new Map<string, HTMLElement>();
  const windows = new Map<string, HTMLElement>();

  const refOf = (row: HTMLElement): WindowRef => ({ session: row.dataset.session ?? "", window: row.dataset.window ?? "" });

  function makeGroup(): HTMLElement {
    const box = el("section", "dbg-group");
    const head = button("dbg-head");
    head.append(el("span", "dbg-name"), el("span", "dbg-meta"));
    head.onclick = () => {
      const key = box.dataset.group;
      if (key) host?.actions.setFolded(key, box.dataset.folded !== "1");
    };
    box.append(head, el("div", "dbg-sessions"));
    return box;
  }

  function makeSession(): HTMLElement {
    const box = el("div", "dbg-session");
    const head = el("div", "dbg-shead");
    head.append(el("span", "dbg-label"), el("span", "dbg-meta"));
    box.append(head, el("div", "dbg-windows"));
    return box;
  }

  function makeWindow(): HTMLElement {
    const row = el("div", "dbg-win");
    const open = button("dbg-open");
    open.append(el("span", "dbg-wname"), el("span", "dbg-line"), el("span", "dbg-line dbg-lineage"));
    open.onclick = () => host?.actions.openWindow(refOf(row));
    const note = button("btn", "note");
    note.onclick = () => host?.actions.openNote(refOf(row));
    const beside = button("btn", "beside");
    beside.onclick = () => host?.actions.openBeside(refOf(row));
    row.append(open, note, beside);
    return row;
  }

  function patchWindow(row: HTMLElement, w: WorldWindow, s: WorldSession, now: number) {
    row.dataset.session = s.id;
    row.dataset.window = w.id;
    row.className = `dbg-win ${w.agent?.state ?? "none"}${w.unread ? " unread" : ""}`;
    const [name, line, lineage] = row.querySelectorAll(".dbg-open > span");
    setText(name, `${w.name}  ${w.id}`);
    setText(line, w.agent ? agentLine(w.agent, now) : "no agent");
    const keys = Object.entries(w.lineage).map(([k, v]) => `${k} ${v.slice(0, 8)}`);
    if (w.sharedWith.length) keys.push(`shares checkout with ${w.sharedWith.map((r) => r.window).join(", ")}`);
    setText(lineage, keys.join(" · "));
  }

  function patchSession(box: HTMLElement, s: WorldSession, now: number, seen: Set<string>) {
    box.classList.toggle("current", s.current);
    const [label, meta] = box.querySelectorAll(".dbg-shead > span");
    setText(label, `${s.label}  ${s.id}`);
    setText(meta, attentionLine(s.attention, now));
    place(box.querySelector<HTMLElement>(".dbg-windows")!, s.windows, (w) => w.id, windows, seen, makeWindow,
      (row, w) => patchWindow(row, w, s, now));
  }

  function patchGroup(box: HTMLElement, g: WorldGroup, now: number, seenS: Set<string>, seenW: Set<string>) {
    box.dataset.group = g.key ?? "";
    box.dataset.folded = g.folded ? "1" : "0";
    const head = box.querySelector<HTMLElement>(".dbg-head")!;
    head.hidden = g.key === null; // an untagged session stands on its own, as in the sidebar
    head.setAttribute("aria-expanded", String(!g.folded));
    const [name, meta] = head.querySelectorAll("span");
    setText(name, `${g.folded ? "▸" : "▾"} ${g.name ?? ""}`);
    setText(meta, attentionLine(g.attention, now));
    const list = box.querySelector<HTMLElement>(".dbg-sessions")!;
    list.hidden = g.folded;
    place(list, g.sessions, (s) => s.id, sessions, seenS, makeSession, (e, s) => patchSession(e, s, now, seenW));
  }

  function draw() {
    if (!host) return;
    if (!world) {
      if (!tree.querySelector(".dbg-note")) tree.replaceChildren(el("p", "dbg-note", "Waiting for the first state…"));
      return;
    }
    const now = host.now();
    const seenG = new Set<string>();
    const seenS = new Set<string>();
    const seenW = new Set<string>();
    place(tree, world.groups, (g) => g.key ?? `solo ${g.sessions[0]?.id ?? ""}`, groups, seenG, makeGroup,
      (e, g) => patchGroup(e, g, now, seenS, seenW));
    sweep(groups, seenG);
    sweep(sessions, seenS);
    sweep(windows, seenW);
  }

  function record(events: readonly WorldEvent[]) {
    for (const e of events) log.prepend(el("li", undefined, eventLine(e)));
    while (log.children.length > LOG_MAX) log.lastElementChild?.remove();
  }

  return {
    mount(h) {
      host = h;
      const side = el("aside", "dbg-side");
      side.append(el("h2", "dbg-title", "Events"), log);
      const wrap = el("div", "dbg");
      wrap.append(tree, side);
      h.root.replaceChildren(wrap);
      stopTick = h.tick(1, draw);
      draw();
    },
    update(next, events) {
      world = next;
      record(events);
      draw();
    },
    reveal(ref) {
      host?.actions.openWindow(ref);
    },
    unmount() {
      stopTick?.();
      stopTick = null;
      host = null;
      groups.clear();
      sessions.clear();
      windows.clear();
    },
  };
}
