// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { makeReorderable } from "./reorder";
import { onContextMenu, type Anchor } from "./popover";
import { agentTitle, formatElapsed, GLYPH, GLYPH_TITLE, sessionAgent, sessionGlyph, sharedCheckouts, sharingTitle, windowDots, dotCounts, windowGlyph, type Sharing } from "./agent";
import { findSessions, folderOf } from "./find";
import { ICONS } from "./icons";
import { marksShown, memoryShown } from "./display";
import { memoryStore } from "./memory";
import { sessionLabel, tabLabel, windowPlace } from "./labels";
import { groupSessions, isArchived, mergeOrder, splitArchived, visualOrder, type Block } from "./groups";
import { categoryKey, editableName, renameKeepingTag, splitCategory } from "../shared/category";
import { createFolded, type Folded } from "./folded";

/** The fold key recording that the Archived section was opened (it starts folded). */
const ARCHIVE_OPEN = "\u0000archived-open";

export type Row =
  | { kind: "session"; name: string; label: string; orphan: boolean; attached: boolean; current: boolean; windows: WindowInfo[] }
  | { kind: "window"; session: string; index: number; name: string; active: boolean; panes: number };

export { sessionLabel };

export function sidebarModel(sessions: SessionInfo[], current: string | null): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    rows.push({
      kind: "session",
      name: s.name,
      // `name` stays tmux's, which every action targets; only the display differs.
      label: sessionLabel(s),
      orphan: s.orphan === true,
      attached: s.attached > (s.name === current ? 1 : 0),
      current: s.name === current,
      windows: s.windows,
    });
    for (const w of s.windows) {
      rows.push({ kind: "window", session: s.name, index: w.index, name: w.name, active: w.active, panes: w.panes });
    }
  }
  return rows;
}

export interface SidebarActions {
  attach(session: string): void;
  newSession(name: string): void;
  killSession(session: string): void;
  renameSession(session: string, name: string): void;
  /** The whole wanted sidebar order, by tmux session name. */
  reorderSessions(names: string[]): void;
  /** A window found by the search: its session, showing it. */
  openWindow(session: string, id: string): void;
  /** The row's menu (`⋯` or right-click): agent or workspace, menu-actions.ts decides. */
  openMenu(session: string, at: Anchor): void;
  /** A group header's menu. */
  openGroupMenu(category: string, at: Anchor): void;
  /** A tab's menu, from its sub-row under a workspace with several. */
  openTabMenu(session: string, id: string, at: Anchor): void;
  /** The ＋ on a group header: a new agent in that group. */
  newInGroup(category: string): void;
}

export interface Sidebar {
  render(sessions: SessionInfo[], current: string | null): void;
  toast(message: string): void;
  toggle(): void;
  /** Open the "new session" prompt in the footer and focus it, optionally prefilled (`[Work] `). */
  startNewSession(prefill?: string): void;
  focusSearch(): void;
  /** Rename a workspace in place, from its menu; `seed` puts other text in the field (a `[]` to type a new group into). */
  startRename(session: string, seed?: { text: string; caret: number }): void;
  /** Rename a group in place on its header; `commit` gets the new group name. */
  startGroupRename(category: string, commit: (name: string) => void): void;
  /** Whether a group is folded, and fold or unfold it. */
  isFolded(category: string): boolean;
  toggleFold(category: string): void;
}

const ICON = {
  dots: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12" cy="8" r="1.1"></circle></svg>',
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

interface UiState {
  editing: string | null;
}

export function createSidebar(
  root: HTMLElement,
  layout: HTMLElement,
  actions: SidebarActions,
  foot?: HTMLElement | null,
  search?: HTMLInputElement | null,
  folded?: Folded,
): Sidebar {
  const ui: UiState = { editing: null };
  let prefill = "";
  const collapsed = folded ?? createFolded();
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;
  let sharing = new Map<string, Sharing>();
  /** The windows each session's search found, by session name; null when nothing is searched for. */
  let found: Map<string, WindowInfo[]> | null = null;

  const rerender = () => draw(lastSessions, lastCurrent);
  // A group folded from a view folds here too.
  collapsed.subscribe(rerender);
  let retry: ReturnType<typeof setTimeout> | undefined;

  function menuButton(name: string): HTMLElement {
    const b = button("row-btn menu-btn");
    b.setAttribute("aria-label", `${name} menu`);
    b.innerHTML = ICON.dots;
    b.title = "Menu (or right-click the row)";
    b.onclick = (e) => {
      e.stopPropagation();
      actions.openMenu(name, b);
    };
    return b;
  }

  /**
   * The sidebar's order as drawn, by tmux name, collapsed groups included --
   * what every reorder is expressed against. Grouping moves a session away
   * from its stored position, so the stored order is not the one on screen.
   */
  function orderNames(): string[] {
    // As drawn: the live groups, then the Archived section.
    const { live, archived } = splitArchived(lastSessions, (s) => isArchived(s, sessionLabel(s)));
    return [...visualOrder(live, sessionLabel), ...visualOrder(archived, sessionLabel)].map((s) => s.name);
  }

  function inlineRename(row: HTMLElement, name: string, commit: (next: string) => void, seed?: { text: string; caret: number }) {
    const labelEl = row.querySelector(".label");
    if (!labelEl) return;
    ui.editing = name;
    const input = el("input", "rename") as HTMLInputElement;
    input.type = "text";
    input.value = name;
    input.setAttribute("aria-label", "Session name");
    labelEl.replaceWith(input);
    const nameBtn = row.querySelector(".name") as HTMLButtonElement | null;
    if (nameBtn) nameBtn.onclick = (e) => e.preventDefault();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      ui.editing = null;
      const next = input.value.trim();
      if (save && next && next !== name) commit(next);
      rerender();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
      e.stopPropagation();
    };
    input.onblur = () => finish(true);
    input.focus();
    if (seed) {
      input.value = seed.text;
      input.setSelectionRange(seed.caret, seed.caret);
    } else input.select();
  }

  /** The field shows the name without its group; saving keeps the group. */
  function renameRow(r: HTMLElement, session: string, label: string, seed?: { text: string; caret: number }) {
    inlineRename(r, editableName(label), (next) => {
      // A "New group…" seed left with its brackets empty is a plain rename.
      const typed = next.replace(/^\[\s*\]\s*/, "");
      if (typed) actions.renameSession(session, renameKeepingTag(label, typed));
    }, seed);
  }

  function renderSession(row: Extract<Row, { kind: "session" }>, windows: number, move: { up: boolean; down: boolean }) {
    const group = el("div", `group${row.current ? " current" : ""}`);
    group.dataset.name = row.name;
    // Under its group's header the tag would only repeat the header; the rename
    // box still starts from the whole name, so renaming keeps the session in
    // its group unless the tag itself is edited.
    const shown = splitCategory(row.label)?.rest ?? row.label;
    const r = el("div", `row session${row.orphan ? " orphan" : ""}`);

    const name = button("name");
    // The glyph replaces the old attached dot and window count: from a phone
    // with cmux closed the dot was always off, and the count was never
    // something you could act on. What an agent wants is.
    const glyph = sessionGlyph(row.windows);
    const mark = el("span", `glyph ${glyph}`, GLYPH[glyph]);
    mark.title = GLYPH_TITLE[glyph];
    name.append(mark, el("span", "label", shown));
    // A session with an agent in someone else's checkout says so here as well
    // as on the tab: the tab strip only shows the session you are attached to.
    const shared = row.windows.map((w) => sharing.get(w.id)).filter((x): x is Sharing => x !== undefined);
    if (shared.length > 0) {
      const m = el("span", "shared-checkout");
      m.innerHTML = ICONS.checkout;
      m.title = shared.map(sharingTitle).join("\n");
      m.setAttribute("role", "img");
      m.setAttribute("aria-label", m.title);
      name.append(m);
    }
    // The session's tabs summed, when the viewer asked for it: the tab strip
    // shows only the attached session's, so this is where the others say.
    const mem = memoryShown() ? memoryStore.session(row.windows) : null;
    if (mem) {
      const chip = el("span", "mem-chip", mem.text);
      chip.title = "Memory held by this session's tabs";
      name.append(chip);
    }
    // Only for a session that is blocked: how long it has been waiting changes
    // what you do about it, where how long a turn has run does not.
    const elapsed = glyph === "input" ? formatElapsed(sessionAgent(row.windows)?.since, Date.now()) : "";
    if (elapsed) name.append(el("span", "elapsed", elapsed));
    // One dot per window, in tab order, so a session with several agents says
    // which of its tabs is the one shouting. windowDots says when that is
    // worth the space; a session with one agent gets nothing beyond its glyph.
    const dotGlyphs = windowDots(row.windows);
    if (dotGlyphs.length > 0) {
      const dots = el("span", "wdots full");
      dotGlyphs.forEach((g, i) => {
        const w = row.windows[i]!;
        const d = el("span", `glyph ${g}`, GLYPH[g]);
        d.title = `${w.label ?? w.name}: ${agentTitle(w)}`;
        dots.append(d);
      });
      // The same, counted per state, for when the row is too tight for a dot
      // per window (fitDots picks which one shows).
      const counts = dotCounts(dotGlyphs);
      const compact = el("span", "wdots compact");
      compact.title = counts.map((c) => `${c.count} ${GLYPH_TITLE[c.glyph]}`).join(", ");
      for (const c of counts) {
        const n = el("span", "wcount");
        n.append(el("span", `glyph ${c.glyph}`, GLYPH[c.glyph]), String(c.count));
        compact.append(n);
      }
      name.append(dots, compact);
    }
    if (row.orphan) name.title = `${row.name} — its cmux workspace is closed`;
    name.onclick = () => actions.attach(row.name);
    // Double-click renames in place. renameSession reaches cmux too, resolved by
    // the stamped workspace id, so a row showing a cmux title renames there.
    name.ondblclick = (e) => {
      e.preventDefault();
      renameRow(r, row.name, row.label);
    };
    onContextMenu(r, (at) => actions.openMenu(row.name, at));

    // The whole row drags: reorder.ts arms on the name after enough travel, so
    // a click still attaches and a double-click still renames.
    r.append(name, menuButton(row.name));
    group.append(r);
    // A workspace with several tabs lists them under its row (one tab is the row itself).
    if (!found && row.windows.length > 1) for (const w of row.windows) group.append(renderHit(row.name, w, true));
    for (const w of found?.get(row.name) ?? []) group.append(renderHit(row.name, w));

    return group;
  }

  /** A window the search found, under its session: one click shows it. */
  function renderHit(session: string, w: WindowInfo, sub = false): HTMLElement {
    const b = button(`row ${sub ? "win-sub" : "win-hit"}${w.active && session === lastCurrent ? " current" : ""}`);
    if (sub) onContextMenu(b, (at) => actions.openTabMenu(session, w.id, at));
    const g = windowGlyph(w);
    const mark = el("span", `glyph ${g}`, GLYPH[g]);
    mark.title = agentTitle(w);
    b.append(mark, el("span", "label", tabLabel(w)));
    const folder = folderOf(w);
    if (folder) b.append(el("span", "folder", folder));
    b.title = `${tabLabel(w)}${folder ? ` \u2014 ${folder}` : ""}`;
    b.onclick = () => actions.openWindow(session, w.id);
    return b;
  }

  function newSessionButton(): HTMLElement {
    const b = button("btn block");
    b.innerHTML = ICON.plus;
    b.append(el("span", "", "New session"));
    b.onclick = () => startNewSession();
    return b;
  }

  function newSessionPrompt(): HTMLElement {
    const input = el("input", "rename") as HTMLInputElement;
    input.type = "text";
    input.placeholder = "name";
    input.setAttribute("aria-label", "New session name");
    input.value = prefill;
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) { ui.editing = null; actions.newSession(input.value.trim()); drawFoot(); }
      else if (e.key === "Escape") { ui.editing = null; drawFoot(); }
    };
    input.onblur = () => { if (ui.editing === "new-session") { ui.editing = null; drawFoot(); } };
    return input;
  }

  function drawFoot() {
    if (!foot) return;
    // "+ New session" gave way to the ＋ at the top of the list (the New agent form).
    if (ui.editing !== "new-session") { foot.replaceChildren(); foot.hidden = true; return; }
    foot.hidden = false;
    // Keep an open prompt, and what is typed in it: with agents running, a
    // state push redraws the sidebar every few seconds.
    if (ui.editing === "new-session" && foot.querySelector("input")) return;
    foot.replaceChildren(ui.editing === "new-session" ? newSessionPrompt() : newSessionButton());
    if (ui.editing === "new-session") (foot.firstElementChild as HTMLInputElement | null)?.focus();
  }

  function startNewSession(pre = "") {
    prefill = pre;
    ui.editing = "new-session";
    drawFoot();
    const input = foot?.querySelector("input");
    if (input && pre) input.setSelectionRange(pre.length, pre.length);
  }

  function draw(sessions: SessionInfo[], current: string | null) {
    lastSessions = sessions;
    lastCurrent = current;
    if (ui.editing && ui.editing !== "new-session") return; // keep an open rename input alive
    // Mid-drag, a rebuild would take the dragged row and the drop marker with
    // it, and with agents running a state push lands every few seconds. Try
    // again shortly: a drag that ends without a move sends nothing to redraw on.
    if (root.classList.contains("reordering")) {
      clearTimeout(retry);
      retry = setTimeout(rerender, 250);
      return;
    }
    root.replaceChildren();
    if (sessions.length === 0) {
      root.append(el("div", "row note", "No tmux server"));
      drawFoot();
      return;
    }
    sharing = marksShown() ? sharedCheckouts(sessions, windowPlace) : new Map();
    // Windows live in the tab strip now; the sidebar is one row per session --
    // and, while searching, the windows the search found under theirs.
    const query = search?.value.trim() ?? "";
    found = query ? new Map(findSessions(sessions, query).map((h) => [h.session.name, h.windows])) : null;
    root.classList.toggle("searching", found !== null);
    const sessionRows = sidebarModel(sessions, current).filter(
      (r): r is Extract<Row, { kind: "session" }> => r.kind === "session" && (!found || found.has(r.name)),
    );
    if (found && sessionRows.length === 0) {
      root.append(el("div", "row note", "Nothing matches"));
      drawFoot();
      return;
    }
    const windowCount = (name: string) => sessions.find((s) => s.name === name)?.windows.length ?? 0;
    // Archived workspaces leave their groups for one folded section at the bottom.
    const byName = new Map(sessions.map((x) => [x.name, x]));
    const { live, archived } = splitArchived(sessionRows, (r) => isArchived(byName.get(r.name) ?? {}, r.label));
    const blocks = groupSessions(live, (r) => r.label);
    blocks.forEach((block, bi) => {
      if (block.category === null) {
        const row = block.sessions[0]!;
        root.append(renderSession(row, windowCount(row.name), { up: bi > 0, down: bi < blocks.length - 1 }));
        return;
      }
      root.append(renderCategory(block, (row, i) =>
        renderSession(row, windowCount(row.name), { up: i > 0, down: i < block.sessions.length - 1 })));
    });
    if (archived.length) {
      root.append(renderCategory({ category: "Archived", sessions: archived }, (row) =>
        renderSession(row, windowCount(row.name), { up: false, down: false }), { archive: true }));
    }
    fitDots();
    drawFoot();
  }

  /**
   * A dot per window where the row has room for them and for the whole name;
   * the per-state counts where it does not. Measured, not guessed from the
   * sidebar's width: how much room a row has depends on its name.
   */
  function fitDots() {
    for (const r of root.querySelectorAll<HTMLElement>(".row.session")) {
      const dots = r.querySelector<HTMLElement>(".wdots.full");
      if (!dots) continue;
      r.classList.remove("tight");
      const label = r.querySelector<HTMLElement>(".label");
      const cut = (e: HTMLElement | null) => !!e && e.scrollWidth > e.clientWidth + 1;
      r.classList.toggle("tight", cut(dots) || cut(label));
    }
  }
  let fitting = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(fitDots);
  }).observe(root);

  /**
   * A category's header and, unless folded, its sessions. Folded, the header
   * still carries the group's most urgent glyph -- a session needing you is
   * never hidden by a fold -- and the attached session's tint, so "where am I"
   * is answered with its group closed.
   */
  function renderCategory(
    block: Block<Extract<Row, { kind: "session" }>>,
    renderRow: (row: Extract<Row, { kind: "session" }>, i: number) => HTMLElement,
    opts: { archive?: boolean } = {},
  ): HTMLElement {
    const category = block.category!;
    // The Archived section starts folded: its key records it being opened, not closed.
    const key = opts.archive ? ARCHIVE_OPEN : categoryKey(category);
    // A search looks inside folded groups too: a hit you cannot see is no hit.
    const folded = (opts.archive ? !collapsed.has(key) : collapsed.has(key)) && found === null;
    const holdsCurrent = block.sessions.some((r) => r.current);
    const section = el("section", `cat${opts.archive ? " archive" : ""}${folded ? " folded" : ""}${folded && holdsCurrent ? " current" : ""}`);

    const head = button("cat-head");
    head.setAttribute("aria-expanded", String(!folded));
    const chevron = el("span", "chevron");
    chevron.innerHTML = ICONS.chevron;
    head.append(chevron, el("span", "cat-name", category));
    if (!opts.archive) {
      const add = el("span", "cat-add", "＋");
      add.setAttribute("role", "button");
      add.tabIndex = 0;
      add.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); actions.newInGroup(category); } };
      add.setAttribute("aria-label", `New agent in ${category}`);
      add.title = `New agent in ${category}`;
      add.onclick = (e) => { e.stopPropagation(); actions.newInGroup(category); };
      head.append(add);
    }
    // The count only when folded: open, the rows below already are the count.
    if (folded && opts.archive) {
      // Put away means quiet: no urgency on the header, only how many.
      head.append(el("span", "cat-count", String(block.sessions.length)));
    } else if (folded) {
      const glyph = sessionGlyph(block.sessions.flatMap((r) => r.windows));
      const mark = el("span", `glyph ${glyph}`, GLYPH[glyph]);
      mark.title = GLYPH_TITLE[glyph];
      head.append(mark, el("span", "cat-count", String(block.sessions.length)));
    }
    head.onclick = () => {
      collapsed.toggle(key); // redraws through the subscription
    };
    if (!opts.archive) onContextMenu(head, (at) => actions.openGroupMenu(category, at));
    section.append(head);
    if (!folded) block.sessions.forEach((row, i) => section.append(renderRow(row, i)));
    return section;
  }

  drawFoot();

  if (search) {
    search.addEventListener("input", rerender);
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        search.value = "";
        rerender();
        search.blur();
      } else if (e.key === "Enter") {
        // The box is shared with the Chats list; there, Enter is the chat list's.
        if (root.hidden) return;
        // The first thing found, as drawn: a window if the search named one.
        e.preventDefault();
        const first = root.querySelector<HTMLElement>(".win-hit") ?? root.querySelector<HTMLElement>(".group .name");
        first?.click();
      }
    });
  }

  // Every drawn session row, in or out of a group, in the order shown. A folded
  // group's sessions are not drawn, so the drag sees only some of the order and
  // mergeOrder puts the rest back in their places.
  // Nothing drags while a search has the list cut down: the order it would
  // commit could only be the visible part of it.
  const drawnRows = () => (found ? [] : [...root.querySelectorAll<HTMLElement>(".group")]);
  makeReorderable(root, {
    rows: drawnRows,
    commit: (order) => {
      const visible = drawnRows().map((r) => r.dataset.name ?? "");
      const moved = order.map((i) => visible[i]).filter((n): n is string => n !== undefined);
      actions.reorderSessions(mergeOrder(orderNames(), visible, moved));
    },
  });

  return {
    render: draw,
    toast(message) {
      const t = el("div", "toast");
      t.append(el("span", "", message));
      document.body.append(t);
      setTimeout(() => t.remove(), 4000);
    },
    toggle() {
      layout.classList.toggle("collapsed");
    },
    startNewSession,
    startRename(session, seed) {
      const s = lastSessions.find((x) => x.name === session);
      const rowOf = () => root.querySelector<HTMLElement>(`.group[data-name="${CSS.escape(session)}"] .row.session`);
      // A row in a folded group (or the folded Archived section) is unfolded to be renamed.
      if (!rowOf() && s) {
        const cat = splitCategory(sessionLabel(s))?.category;
        if (isArchived(s, sessionLabel(s))) { if (!collapsed.has(ARCHIVE_OPEN)) collapsed.toggle(ARCHIVE_OPEN); }
        else if (cat && collapsed.has(categoryKey(cat))) collapsed.toggle(categoryKey(cat));
        if (search?.value) { search.value = ""; rerender(); }
      }
      const r = rowOf();
      if (r && s) renameRow(r, session, sessionLabel(s), seed);
    },
    startGroupRename(category, commit) {
      const head = [...root.querySelectorAll<HTMLElement>(".cat-head")].find((h) => h.querySelector(".cat-name")?.textContent === category);
      const nameEl = head?.querySelector<HTMLElement>(".cat-name");
      if (!head || !nameEl) return;
      ui.editing = `group:${category}`;
      const input = el("input", "rename") as HTMLInputElement;
      input.value = category;
      input.setAttribute("aria-label", "Group name");
      nameEl.replaceWith(input);
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        ui.editing = null;
        const next = input.value.trim().replace(/[[\]]/g, "");
        if (save && next && next !== category) commit(next);
        rerender();
      };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      };
      for (const ev of ["click", "pointerdown"] as const) input.addEventListener(ev, (e) => e.stopPropagation());
      input.onblur = () => finish(true);
      input.focus();
      input.select();
    },
    isFolded: (category) => collapsed.has(categoryKey(category)),
    toggleFold: (category) => collapsed.toggle(categoryKey(category)),
    focusSearch() {
      if (!search) return;
      layout.classList.remove("collapsed");
      search.focus();
      search.select();
    },
  };
}
