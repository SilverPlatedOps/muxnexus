import type { SessionInfo } from "../shared/protocol";

export type Row =
  | { kind: "session"; name: string; label: string; orphan: boolean; attached: boolean; current: boolean }
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

  function menuFor(onRename: () => void, onKill: () => void): HTMLElement {
    const m = el("div", "menu");
    const rename = button("btn", "Rename");
    rename.onclick = () => { ui.menu = null; m.remove(); onRename(); };
    const kill = button("btn", "Kill");
    kill.onclick = onKill;
    m.append(rename, kill);
    return m;
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

  function renderSession(row: Extract<Row, { kind: "session" }>, windows: number) {
    const group = el("div", `group${row.current ? " current" : ""}`);
    const r = el("div", `row session${ui.menu === row.name ? " menu-open" : ""}${row.orphan ? " orphan" : ""}`);

    const name = button("name");
    const dot = el("span", `dot${row.attached ? " on" : ""}`);
    if (row.attached) dot.title = "another client is attached";
    const count = el("span", "count", String(windows));
    count.title = `${windows} window${windows === 1 ? "" : "s"}`;
    name.append(dot, el("span", "label", row.label), count);
    if (row.orphan) name.title = `${row.name} — its cmux workspace is closed`;
    name.onclick = () => actions.attach(row.name);

    r.append(name, menuButton(row.name));
    group.append(r);

    if (ui.menu === row.name) {
      group.append(menuFor(
        () => inlineRename(r, row.name, (next) => actions.renameSession(row.name, next)),
        () => { ui.menu = null; ui.confirm = row.name; rerender(); },
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
    for (const row of sidebarModel(sessions, current)) {
      if (row.kind !== "session") continue;
      const windows = sessions.find((s) => s.name === row.name)?.windows.length ?? 0;
      root.append(renderSession(row, windows));
    }
    drawFoot();
  }

  drawFoot();

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
