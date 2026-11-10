// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { NewWindowAgent, SessionInfo, WindowInfo } from "../shared/protocol";
import type { ChatSummary } from "../shared/chat";
import { makeReorderable } from "./reorder";
import { onContextMenu, openMenu, type Anchor } from "./popover";
import { agentTitle, GLYPH, profileBadge, sharedCheckouts, sharingTitle, windowGlyph, type Sharing } from "./agent";
import { ICONS } from "./icons";
import { tabLabel, windowPlace } from "./labels";
import { badgesShown, marksShown, memoryShown } from "./display";
import { memoryStore } from "./memory";

/** The windows of the attached session, in tmux order. Empty when nothing is attached. */
export function tabsModel(sessions: SessionInfo[], current: string | null): WindowInfo[] {
  if (!current) return [];
  return sessions.find((s) => s.name === current)?.windows ?? [];
}

export { tabLabel };

/** Every window is addressed by tmux's id (`@3`): an index is a slot windows move through. */
export interface TabActions {
  selectWindow(id: string): void;
  /** A plain shell, or with `agent` already started in it. */
  newWindow(agent?: NewWindowAgent): void;
  renameWindow(id: string, name: string): void;
  killWindow(id: string): void;
  /** The whole wanted tab order, as window ids. */
  reorderWindows(ids: string[]): void;
  /**
   * Open the account picker for this window. Only offered once a Claude Code
   * SessionStart has stamped the window, since without a transcript there is
   * nothing to carry.
   */
  moveWindow(id: string): void;
  /** Show this window in a second pane beside the one on screen. */
  openBeside(id: string): void;
  /** Open this window's note. */
  openNote(id: string): void;
  /** The tab's menu (`⋯` or right-click). */
  openMenu(id: string, at: Anchor): void;
  /** Where a tab dragged off the strip can land instead: the terminal, to open it beside. */
  dragOut?: {
    over(id: string, x: number, y: number): boolean;
    leave(): void;
    drop(id: string, x: number, y: number): void;
  };
}

export interface Tabs {
  render(sessions: SessionInfo[], current: string | null): void;
  /** The accounts a tab can spend (Claude profiles, then Codex), in the quota panel's order, which picks each badge's colour. */
  setProfiles(labels: string[]): void;
  /** The window shown in the beside pane, if the terminal is split. */
  setBeside(id: string | null): void;
  /** The chats each tab's agent is in; a tab in any wears a mark that lists them. */
  setChatMarks(marks: Map<string, ChatSummary[]>, open: (anchor: HTMLElement, chats: ChatSummary[], windowId: string) => void): void;
  /** Rename a tab in place, from its menu. */
  startRename(id: string): void;
}

const ICON = {
  dots: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12" cy="8" r="1.1"></circle></svg>',
  chevron: '<svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3.5 6 8 10.5 12.5 6"></polyline></svg>',
  plus: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="8" y1="3.5" x2="8" y2="12.5"></line><line x1="3.5" y1="8" x2="12.5" y2="8"></line></svg>',
};


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

/**
 * The mark on an agent that shares its git checkout with another: the tab is
 * where you would act on it, so it says which other agent and where.
 */
function checkoutMark(sh: Sharing): HTMLElement {
  const m = el("span", "shared-checkout");
  m.innerHTML = ICONS.checkout;
  m.title = sharingTitle(sh);
  m.setAttribute("role", "img");
  m.setAttribute("aria-label", sharingTitle(sh));
  return m;
}

/**
 * `solo`: where a one-tab workspace's tab goes instead of a strip -- the title
 * bar, which already names it. Its marks (account, note, chats, memory) and the
 * one-click `+` come along; the strip itself only shows for two tabs or more.
 */
export function createTabs(root: HTMLElement, actions: TabActions, solo?: HTMLElement): Tabs {
  // The tab being renamed, by window id: a poll arriving mid-rename leaves it alone.
  const ui: { editing: string | null } = { editing: null };
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;
  let sharing = new Map<string, Sharing>();
  let profiles: string[] = [];
  let beside: string | null = null;
  let chatMarks = new Map<string, ChatSummary[]>();
  let openChats: ((anchor: HTMLElement, chats: ChatSummary[], windowId: string) => void) | null = null;
  /** The active window the strip last scrolled to. */
  let revealed: string | null = null;

  const rerender = () => draw(lastSessions, lastCurrent);
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** Rename in place: the tab's label becomes an input. */
  function inlineRename(tab: HTMLElement, id: string, initial: string) {
    const labelEl = tab.querySelector(".label");
    if (!labelEl) return;
    ui.editing = id;
    const input = el("input", "tab-rename") as HTMLInputElement;
    input.type = "text";
    input.value = initial;
    input.setAttribute("aria-label", "Window name");
    labelEl.replaceWith(input);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      ui.editing = null;
      const name = input.value.trim();
      if (save && name && name !== initial) actions.renameWindow(id, name);
      rerender();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    };
    input.onblur = () => finish(true);
    input.focus();
    input.select();
  }

  function renderTab(w: WindowInfo): HTMLElement {
    const tab = el("div", `tab${w.active ? " active" : ""}${w.id === beside ? " beside" : ""}`);
    tab.dataset.id = w.id;

    const name = button("name");
    // The same glyph as the sidebar row, so the eye that found the session in
    // the list lands on the right tab without re-reading anything. This is the
    // one place a running arc turns: the tab is the window, and the window is
    // what runs. No index before it -- tmux's slot number told you nothing the
    // tab's position does not, and reordering changes it anyway.
    const glyph = windowGlyph(w);
    const mark = el("span", `glyph ${glyph}`, GLYPH[glyph]);
    mark.title = agentTitle(w);
    name.append(mark, el("span", "label", tabLabel(w)));
    // The account this agent spends, when the viewer wants to see it: the tab
    // is the one place, since a tab is exactly one agent. The glyph's tooltip
    // names it either way.
    if (w.agent?.profile && badgesShown()) {
      const b = profileBadge(w.agent.profile, profiles);
      const mark = el("span", `pbadge${b.slot === null ? "" : ` p${b.slot}`}`, b.initial);
      mark.title = `${b.profile} profile`;
      name.append(mark);
    }
    // What the tab and everything running in it hold, when the viewer asked
    // for it (Display): grey unless it is among what memory is short for.
    const mem = memoryShown() ? memoryStore.window(w.id) : null;
    if (mem) {
      const chip = el("span", `mem-chip${mem.tone ? ` ${mem.tone}` : ""}`, mem.text);
      chip.title = "Memory held by this tab and everything running in it";
      name.append(chip);
    }
    const shared = sharing.get(w.id);
    if (shared) name.append(checkoutMark(shared));
    if (w.noteId && !w.noteEmpty) {
      const n = el("span", "note-mark", "✎");
      n.title = "Has a note";
      name.append(n);
    }
    const inChats = chatMarks.get(w.id);
    if (inChats?.length) {
      const c = el("span", "chat-mark", `💬${inChats.length}`);
      c.title = `In ${inChats.length === 1 ? "a chat" : `${inChats.length} chats`}: ${inChats.map((x) => x.name).join(", ")}`;
      c.setAttribute("role", "button");
      c.onclick = (e) => { e.stopPropagation(); openChats?.(c, inChats, w.id); };
      name.append(c);
    }
    if (w.panes > 1) {
      const panes = el("span", "panes", String(w.panes));
      panes.title = `${w.panes} panes`;
      name.append(panes);
    }
    name.onclick = () => actions.selectWindow(w.id);
    // Rename edits the label shown; the commit targets the window's tmux name.
    name.ondblclick = (e) => {
      e.preventDefault();
      inlineRename(tab, w.id, tabLabel(w));
    };

    const menuBtn = button("row-btn tab-dots");
    menuBtn.setAttribute("aria-label", `Tab ${w.index} menu`);
    menuBtn.innerHTML = ICON.dots;
    menuBtn.title = "Menu (or right-click the tab)";
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      actions.openMenu(w.id, menuBtn);
    };
    onContextMenu(tab, (at) => actions.openMenu(w.id, at));

    // The whole tab drags: reorder.ts arms on the name after enough travel, so
    // a click still selects and a double-click still renames.
    tab.append(name, menuBtn);
    return tab;
  }

  function draw(sessions: SessionInfo[], current: string | null) {
    lastSessions = sessions;
    lastCurrent = current;
    if (ui.editing !== null) return; // keep an open rename input alive
    // Mid-drag, a rebuild would take the dragged row and the drop marker with
    // it, and with agents running a state push lands every few seconds. Try
    // again shortly: a drag that ends without a move sends nothing to redraw on.
    if (root.classList.contains("reordering")) {
      clearTimeout(retry);
      retry = setTimeout(rerender, 250);
      return;
    }
    const windows = tabsModel(sessions, current);
    root.replaceChildren();
    const lone = windows.length === 1 && solo !== undefined;
    root.hidden = windows.length === 0 || lone;
    if (solo) { solo.replaceChildren(); solo.hidden = !lone; }
    if (windows.length === 0) {
      revealed = null; // shown again, the strip starts at its left edge
      return;
    }

    sharing = marksShown() ? sharedCheckouts(sessions, windowPlace) : new Map();
    if (lone) {
      const tab = renderTab(windows[0]!);
      tab.classList.add("solo");
      solo!.append(tab, newTabButtons());
      revealed = null;
      return;
    }
    root.replaceChildren(...windows.map(renderTab), newTabButtons());
    fitTitles();
    revealActive(windows);
  }

  /**
   * `+` stays one click to a shell, the common case; Claude and Codex sit a
   * click further, behind the chevron, in the same menu as everywhere.
   */
  function newTabButtons(): HTMLElement {
    const adds = el("div", "tab-new");
    const add = button("row-btn");
    add.setAttribute("aria-label", "New tab");
    add.title = "New tab (a shell, in this tab's folder)";
    add.innerHTML = ICON.plus;
    add.onclick = () => actions.newWindow();
    const more = button("row-btn tab-new-more");
    more.setAttribute("aria-label", "New tab with an agent");
    more.title = "New tab with an agent";
    more.innerHTML = ICON.chevron;
    more.onclick = (e) => {
      e.stopPropagation();
      openMenu(more, { title: "New tab", sub: "In this workspace, in this tab's folder", sections: [[
        { action: "new-tab-claude", label: "Claude" },
        { action: "new-tab-codex", label: "Codex" },
        { action: "new-tab-shell", label: "Shell" },
      ]] }, (action) => actions.newWindow(action === "new-tab-claude" ? "claude" : action === "new-tab-codex" ? "codex" : undefined));
    };
    adds.append(add, more);
    return adds;
  }

  function fitTitles() {
    const last = root.lastElementChild as HTMLElement | null;
    if (!last) return;
    root.classList.toggle("lone", root.querySelectorAll(":scope > .tab").length === 1);
    root.classList.remove("crowded");
    // Where the strip's last item ends, not its scroll width: an open menu
    // overhangs the strip on purpose and is no sign of crowding.
    root.classList.toggle("crowded", last.offsetLeft + last.offsetWidth > root.clientWidth);
  }
  /**
   * Scroll the active tab into the strip when it changes -- picked in the
   * sidebar, by ⌘J, from another device -- but not on every redraw, which
   * would yank back a strip scrolled along to look at the others.
   */
  function revealActive(windows: WindowInfo[]) {
    const id = windows.find((w) => w.active)?.id ?? null;
    if (id === revealed) return;
    const tab = root.querySelector<HTMLElement>(":scope > .tab.active");
    // Not scrollable just now -- a menu or rename box holds it open: the next draw tries again.
    if (!tab || root.clientWidth === 0 || getComputedStyle(root).overflowX === "visible") return;
    revealed = id;
    const end = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < root.scrollLeft) root.scrollLeft = tab.offsetLeft;
    else if (end > root.scrollLeft + root.clientWidth) root.scrollLeft = end - root.clientWidth;
  }

  // The strip changes width without a redraw: the notes panel, the sidebar, the window.
  new ResizeObserver(fitTitles).observe(root);

  makeReorderable(root, {
    axis: "x",
    rows: () => [...root.querySelectorAll<HTMLElement>(":scope > .tab")],
    commit: (order) => {
      const ids = tabsModel(lastSessions, lastCurrent).map((w) => w.id);
      actions.reorderWindows(order.map((i) => ids[i]).filter((id) => id !== undefined));
    },
    outside: actions.dragOut && (() => {
      const out = actions.dragOut;
      const idAt = (i: number) => tabsModel(lastSessions, lastCurrent)[i]?.id;
      return {
        over: (from: number, x: number, y: number) => { const id = idAt(from); return id ? out.over(id, x, y) : false; },
        leave: () => out.leave(),
        drop: (from: number, x: number, y: number) => { const id = idAt(from); if (id) out.drop(id, x, y); },
      };
    })(),
  });

  return {
    render: draw,
    startRename(id) {
      const tab = (root.hidden ? solo : root)?.querySelector<HTMLElement>(`.tab[data-id="${CSS.escape(id)}"]`);
      const w = tabsModel(lastSessions, lastCurrent).find((x) => x.id === id);
      if (tab && w) inlineRename(tab, id, tabLabel(w));
    },
    setChatMarks(marks, open) {
      const key = (m: Map<string, ChatSummary[]>) => [...m].map(([w, cs]) => `${w}:${cs.map((c) => c.id).join(",")}`).join(";");
      openChats = open;
      if (key(marks) === key(chatMarks)) return;
      chatMarks = marks;
      if (lastCurrent) rerender();
    },
    setBeside(id) {
      if (id === beside) return;
      beside = id;
      if (lastCurrent) rerender();
    },
    setProfiles(labels) {
      if (labels.join("\n") === profiles.join("\n")) return;
      profiles = labels;
      if (lastCurrent) rerender();
    },
  };
}
