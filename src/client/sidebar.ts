import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { makeReorderable, moveItem } from "./reorder";
import { formatElapsed, GLYPH, GLYPH_TITLE, sessionAgent, sessionGlyph, windowGlyph } from "./agent";

export type Row =
  | { kind: "session"; name: string; label: string; orphan: boolean; attached: boolean; current: boolean; windows: WindowInfo[] }
  | { kind: "window"; session: string; index: number; name: string; active: boolean; panes: number };

export function sidebarModel(sessions: SessionInfo[], current: string | null): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    rows.push({
      kind: "session",
      name: s.name,
      // `name` stays tmux's, which every action targets; only the display differs.
      label: s.label ?? s.name,
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
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;

  const rerender = () => draw(lastSessions, lastCurrent);

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

  /** Current sidebar order, by tmux name -- what every reorder is expressed against. */
  function orderNames(): string[] {
    return lastSessions.map((s) => s.name);
  }

  function moveSession(name: string, delta: number) {
    const names = orderNames();
    const from = names.indexOf(name);
    if (from < 0) return;
    const to = from + delta + (delta > 0 ? 1 : 0); // insertion point, not position
    if (to < 0 || to > names.length) return;
    actions.reorderSessions(moveItem(names, from, to));
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

  function renderSession(row: Extract<Row, { kind: "session" }>, windows: number, at: number, total: number) {
    const group = el("div", `group${row.current ? " current" : ""}`);
    const r = el("div", `row session${ui.menu === row.name ? " menu-open" : ""}${row.orphan ? " orphan" : ""}`);

    const name = button("name");
    // The glyph replaces the old attached dot and window count: from a phone
    // with cmux closed the dot was always off, and the count was never
    // something you could act on. What an agent wants is.
    const glyph = sessionGlyph(row.windows);
    const mark = el("span", `glyph ${glyph}`, GLYPH[glyph]);
    mark.title = GLYPH_TITLE[glyph];
    name.append(mark, el("span", "label", row.label));
    // Only for a session that is blocked: how long it has been waiting changes
    // what you do about it, where how long a turn has run does not.
    const elapsed = glyph === "input" ? formatElapsed(sessionAgent(row.windows)?.since, Date.now()) : "";
    if (elapsed) name.append(el("span", "elapsed", elapsed));
    // One dot per window, in tab order, so a multi-window session says which
    // of its tabs is the one shouting.
    if (row.windows.length > 1) {
      const dots = el("span", "wdots");
      for (const w of row.windows) {
        const g = windowGlyph(w);
        const d = el("span", `glyph ${g}`, GLYPH[g]);
        d.title = `${w.label ?? w.name}: ${GLYPH_TITLE[g]}`;
        dots.append(d);
      }
      name.append(dots);
    }
    if (row.orphan) name.title = `${row.name} — its cmux workspace is closed`;
    name.onclick = () => actions.attach(row.name);
    // Double-click renames in place. renameSession reaches cmux too, resolved by
    // the stamped workspace id, so a row showing a cmux title renames there.
    name.ondblclick = (e) => {
      e.preventDefault();
      inlineRename(r, row.name, (next) => actions.renameSession(row.name, next));
    };

    r.append(name, menuButton(row.name));
    group.append(r);

    if (ui.menu === row.name) {
      group.append(menuFor(
        () => inlineRename(r, row.name, (next) => actions.renameSession(row.name, next)),
        () => { ui.menu = null; ui.confirm = row.name; rerender(); },
        {
          up: at > 0 ? () => moveSession(row.name, -1) : undefined,
          down: at < total - 1 ? () => moveSession(row.name, 1) : undefined,
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
    root.replaceChildren();
    if (sessions.length === 0) {
      root.append(el("div", "row note", "No tmux server"));
      drawFoot();
      return;
    }
    // Windows live in the tab strip now; the sidebar is one row per session.
    const sessionRows = sidebarModel(sessions, current).filter((r) => r.kind === "session");
    sessionRows.forEach((row, i) => {
      if (row.kind !== "session") return;
      const windows = sessions.find((s) => s.name === row.name)?.windows.length ?? 0;
      root.append(renderSession(row, windows, i, sessionRows.length));
    });
    drawFoot();
  }

  drawFoot();

  makeReorderable(root, {
    rows: () => [...root.querySelectorAll<HTMLElement>(":scope > .group")],
    commit: (order) => {
      const names = orderNames();
      actions.reorderSessions(order.map((i) => names[i]).filter((n) => n !== undefined));
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
