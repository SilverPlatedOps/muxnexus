import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { makeReorderable } from "./reorder";
import { formatElapsed, GLYPH, GLYPH_TITLE, sessionAgent, sessionGlyph, sharedCheckouts, sharingTitle, windowDots, type Sharing } from "./agent";
import { ICONS } from "./icons";
import { sessionLabel, windowPlace } from "./labels";
import { groupSessions, mergeOrder, moveWithinBlocks, visualOrder, type Block } from "./groups";
import { categoryKey, splitCategory } from "../shared/category";

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
}

export interface Sidebar {
  render(sessions: SessionInfo[], current: string | null): void;
  toast(message: string): void;
  toggle(): void;
  /** Open the "new session" prompt in the footer and focus it. */
  startNewSession(): void;
}

const ICON = {
  dots: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12" cy="8" r="1.1"></circle></svg>',
  plus: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="8" y1="3.5" x2="8" y2="12.5"></line><line x1="3.5" y1="8" x2="12.5" y2="8"></line></svg>',
  chevron: '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"></path></svg>',
};

const COLLAPSED_KEY = "muxnexus.collapsed";

/** Which groups this browser keeps folded. A convenience, so a failed read is just "none". */
function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(keys: Set<string>) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...keys])); } catch { /* not remembered, still folded */ }
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

interface UiState {
  menu: string | null;
  confirm: string | null;
  editing: string | null;
}

export function createSidebar(
  root: HTMLElement,
  layout: HTMLElement,
  actions: SidebarActions,
  foot?: HTMLElement | null,
): Sidebar {
  const ui: UiState = { menu: null, confirm: null, editing: null };
  const collapsed = loadCollapsed();
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;
  let sharing = new Map<string, Sharing>();

  const rerender = () => draw(lastSessions, lastCurrent);
  let retry: ReturnType<typeof setTimeout> | undefined;

  function menuButton(name: string): HTMLElement {
    const b = button("row-btn menu-btn");
    b.setAttribute("aria-label", `${name} menu`);
    b.innerHTML = ICON.dots;
    b.title = "Rename or kill";
    b.onclick = (e) => {
      e.stopPropagation();
      ui.menu = ui.menu === name ? null : name;
      ui.confirm = null;
      rerender();
    };
    return b;
  }

  function menuFor(onRename: () => void, onKill: () => void, move?: { up?: () => void; down?: () => void }): HTMLElement {
    const m = el("div", "menu");
    const rename = button("btn", "Rename");
    rename.onclick = () => { ui.menu = null; m.remove(); onRename(); };
    m.append(rename);
    // The keyboard- and touch-reachable half of reordering; dragging is the
    // other half, and neither is the fallback for the other.
    if (move?.up) {
      const up = button("btn", "Move up");
      up.onclick = () => { ui.menu = null; move.up!(); };
      m.append(up);
    }
    if (move?.down) {
      const down = button("btn", "Move down");
      down.onclick = () => { ui.menu = null; move.down!(); };
      m.append(down);
    }
    const kill = button("btn", "Kill");
    kill.onclick = onKill;
    m.append(kill);
    return m;
  }

  /**
   * The sidebar's order as drawn, by tmux name, collapsed groups included --
   * what every reorder is expressed against. Grouping moves a session away
   * from its stored position, so the stored order is not the one on screen.
   */
  function orderNames(): string[] {
    return visualOrder(lastSessions, sessionLabel).map((s) => s.name);
  }

  function moveSession(name: string, delta: -1 | 1) {
    const next = moveWithinBlocks(groupSessions(lastSessions, sessionLabel), (s) => s.name, name, delta);
    if (next) actions.reorderSessions(next);
  }

  function confirmFor(label: string, onYes: () => void): HTMLElement {
    const c = el("div", "confirm");
    const yes = button("btn danger", "Kill");
    yes.onclick = () => { ui.confirm = null; onYes(); };
    const no = button("btn", "Cancel");
    no.onclick = () => { ui.confirm = null; rerender(); };
    c.append(el("span", "label", label), yes, no);
    return c;
  }

  /** Swap a row's label for an input; commit on Enter or blur, cancel on Escape. */
  function inlineRename(row: HTMLElement, name: string, commit: (next: string) => void) {
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
    input.select();
  }

  function renderSession(row: Extract<Row, { kind: "session" }>, windows: number, move: { up: boolean; down: boolean }) {
    const group = el("div", `group${row.current ? " current" : ""}`);
    group.dataset.name = row.name;
    // Under its group's header the tag would only repeat the header; the rename
    // box still starts from the whole name, so renaming keeps the session in
    // its group unless the tag itself is edited.
    const shown = splitCategory(row.label)?.rest ?? row.label;
    const r = el("div", `row session${ui.menu === row.name ? " menu-open" : ""}${row.orphan ? " orphan" : ""}`);

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
    // Only for a session that is blocked: how long it has been waiting changes
    // what you do about it, where how long a turn has run does not.
    const elapsed = glyph === "input" ? formatElapsed(sessionAgent(row.windows)?.since, Date.now()) : "";
    if (elapsed) name.append(el("span", "elapsed", elapsed));
    // One dot per window, in tab order, so a session with several agents says
    // which of its tabs is the one shouting. windowDots says when that is
    // worth the space; a session with one agent gets nothing beyond its glyph.
    const dotGlyphs = windowDots(row.windows);
    if (dotGlyphs.length > 0) {
      const dots = el("span", "wdots");
      dotGlyphs.forEach((g, i) => {
        const w = row.windows[i]!;
        const d = el("span", `glyph ${g}`, GLYPH[g]);
        d.title = `${w.label ?? w.name}: ${GLYPH_TITLE[g]}`;
        dots.append(d);
      });
      name.append(dots);
    }
    if (row.orphan) name.title = `${row.name} — its cmux workspace is closed`;
    name.onclick = () => actions.attach(row.name);
    // Double-click renames in place. renameSession reaches cmux too, resolved by
    // the stamped workspace id, so a row showing a cmux title renames there.
    name.ondblclick = (e) => {
      e.preventDefault();
      inlineRename(r, row.label, (next) => actions.renameSession(row.name, next));
    };

    // The whole row drags: reorder.ts arms on the name after enough travel, so
    // a click still attaches and a double-click still renames.
    r.append(name, menuButton(row.name));
    group.append(r);

    if (ui.menu === row.name) {
      group.append(menuFor(
        () => inlineRename(r, row.label, (next) => actions.renameSession(row.name, next)),
        () => { ui.menu = null; ui.confirm = row.name; rerender(); },
        {
          up: move.up ? () => moveSession(row.name, -1) : undefined,
          down: move.down ? () => moveSession(row.name, 1) : undefined,
        },
      ));
    }
    if (ui.confirm === row.name) {
      group.append(confirmFor(`Kill ${windows} window${windows === 1 ? "" : "s"}?`, () => actions.killSession(row.name)));
    }
    return group;
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
    foot.replaceChildren(ui.editing === "new-session" ? newSessionPrompt() : newSessionButton());
    if (ui.editing === "new-session") (foot.firstElementChild as HTMLInputElement | null)?.focus();
  }

  function startNewSession() {
    ui.editing = "new-session";
    drawFoot();
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
    sharing = sharedCheckouts(sessions, windowPlace);
    // Windows live in the tab strip now; the sidebar is one row per session.
    const sessionRows = sidebarModel(sessions, current).filter(
      (r): r is Extract<Row, { kind: "session" }> => r.kind === "session",
    );
    const windowCount = (name: string) => sessions.find((s) => s.name === name)?.windows.length ?? 0;
    const blocks = groupSessions(sessionRows, (r) => r.label);
    blocks.forEach((block, bi) => {
      if (block.category === null) {
        const row = block.sessions[0]!;
        root.append(renderSession(row, windowCount(row.name), { up: bi > 0, down: bi < blocks.length - 1 }));
        return;
      }
      root.append(renderCategory(block, (row, i) =>
        renderSession(row, windowCount(row.name), { up: i > 0, down: i < block.sessions.length - 1 })));
    });
    drawFoot();
  }

  /**
   * A category's header and, unless folded, its sessions. Folded, the header
   * still carries the group's most urgent glyph -- a session needing you is
   * never hidden by a fold -- and the attached session's tint, so "where am I"
   * is answered with its group closed.
   */
  function renderCategory(
    block: Block<Extract<Row, { kind: "session" }>>,
    renderRow: (row: Extract<Row, { kind: "session" }>, i: number) => HTMLElement,
  ): HTMLElement {
    const category = block.category!;
    const key = categoryKey(category);
    const folded = collapsed.has(key);
    const holdsCurrent = block.sessions.some((r) => r.current);
    const section = el("section", `cat${folded ? " folded" : ""}${folded && holdsCurrent ? " current" : ""}`);

    const head = button("cat-head");
    head.setAttribute("aria-expanded", String(!folded));
    const chevron = el("span", "chevron");
    chevron.innerHTML = ICON.chevron;
    head.append(chevron, el("span", "cat-name", category));
    // The count only when folded: open, the rows below already are the count.
    if (folded) {
      const glyph = sessionGlyph(block.sessions.flatMap((r) => r.windows));
      const mark = el("span", `glyph ${glyph}`, GLYPH[glyph]);
      mark.title = GLYPH_TITLE[glyph];
      head.append(mark, el("span", "cat-count", String(block.sessions.length)));
    }
    head.onclick = () => {
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      saveCollapsed(collapsed);
      rerender();
    };
    section.append(head);
    if (!folded) block.sessions.forEach((row, i) => section.append(renderRow(row, i)));
    return section;
  }

  drawFoot();

  // Every drawn session row, in or out of a group, in the order shown. A folded
  // group's sessions are not drawn, so the drag sees only some of the order and
  // mergeOrder puts the rest back in their places.
  const drawnRows = () => [...root.querySelectorAll<HTMLElement>(".group")];
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
  };
}
