import type { SessionInfo } from "../shared/protocol";

export type Row =
  | { kind: "session"; name: string; attached: boolean; current: boolean }
  | { kind: "window"; session: string; index: number; name: string; active: boolean; panes: number };

export function sidebarModel(sessions: SessionInfo[], current: string | null): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    rows.push({ kind: "session", name: s.name, attached: s.attached > (s.name === current ? 1 : 0), current: s.name === current });
    for (const w of s.windows) {
      rows.push({ kind: "window", session: s.name, index: w.index, name: w.name, active: w.active, panes: w.panes });
    }
  }
  return rows;
}

export interface SidebarActions {
  attach(session: string): void;
  selectWindow(session: string, index: number): void;
  newSession(name: string): void;
  newWindow(session: string): void;
  killSession(session: string): void;
  killWindow(session: string, index: number): void;
  renameSession(session: string, name: string): void;
  renameWindow(session: string, index: number, name: string): void;
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

/** A <button> whose only content is a static icon (never user data). */
function iconButton(cls: string, icon: keyof typeof ICON, label: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.innerHTML = ICON[icon];
  return b as HTMLButtonElement;
}

interface UiState {
  menu: string | null;
  confirm: string | null;
  editing: string | null;
}

const sessionKey = (name: string) => `s:${name}`;
const windowKey = (session: string, index: number) => `w:${session}:${index}`;

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

  function menuButton(key: string, label: string): HTMLElement {
    const b = iconButton("menu-btn", "dots", label);
    b.title = "Rename or kill";
    b.onclick = (e) => {
      e.stopPropagation();
      ui.menu = ui.menu === key ? null : key;
      ui.confirm = null;
      rerender();
    };
    return b;
  }

  function menuFor(key: string, onRename: () => void, onKill: () => void): HTMLElement {
    const m = el("div", "menu");
    const rename = el("button", "btn", "Rename");
    rename.type = "button";
    rename.onclick = () => { ui.menu = null; m.remove(); onRename(); };
    const kill = el("button", "btn", "Kill");
    kill.type = "button";
    kill.onclick = () => { ui.menu = null; ui.confirm = key; rerender(); };
    m.append(rename, kill);
    return m;
  }

  function confirmFor(label: string, onYes: () => void): HTMLElement {
    const c = el("div", "confirm");
    const yes = el("button", "btn danger", "Kill");
    yes.type = "button";
    yes.onclick = () => { ui.confirm = null; onYes(); };
    const no = el("button", "btn", "Cancel");
    no.type = "button";
    no.onclick = () => { ui.confirm = null; rerender(); };
    c.append(el("span", "label", label), yes, no);
    return c;
  }

  /** Swap a row's name for an input; commit on Enter or blur, cancel on Escape. */
  function inlineRename(row: HTMLElement, key: string, initial: string, commit: (name: string) => void) {
    const nameEl = row.querySelector(".name");
    if (!nameEl) return; // menu already gone (e.g. a second Rename click); nothing to swap
    ui.editing = key;
    const input = el("input", "rename") as HTMLInputElement;
    input.type = "text";
    input.value = initial;
    input.setAttribute("aria-label", "Name");
    nameEl.replaceWith(input);
    row.onclick = (e) => e.stopPropagation();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      ui.editing = null;
      const name = input.value.trim();
      if (save && name && name !== initial) commit(name);
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

  function renderSession(row: Extract<Row, { kind: "session" }>, group: HTMLElement) {
    const key = sessionKey(row.name);
    const r = el("div", `row session${ui.menu === key ? " menu-open" : ""}`);
    const dot = el("span", `dot${row.attached ? " on" : ""}`);
    dot.title = row.attached ? "another client is attached" : "";
    const name = el("button", "name", row.name);
    name.type = "button";
    name.onclick = () => actions.attach(row.name);
    r.append(dot, name, menuButton(key, `${row.name} menu`));
    group.append(r);
    if (ui.menu === key) {
      group.append(menuFor(key,
        () => inlineRename(r, key, row.name, (name) => actions.renameSession(row.name, name)),
        () => actions.killSession(row.name)));
    }
    if (ui.confirm === key) {
      const windows = lastSessions.find((s) => s.name === row.name)?.windows.length ?? 0;
      group.append(confirmFor(`Kill ${windows} window${windows === 1 ? "" : "s"}?`, () => actions.killSession(row.name)));
    }
  }

  function renderWindow(row: Extract<Row, { kind: "window" }>, group: HTMLElement) {
    const key = windowKey(row.session, row.index);
    const r = el("button", `row window${row.active ? " active" : ""}${ui.menu === key ? " menu-open" : ""}`);
    r.type = "button";
    r.append(el("span", "idx", String(row.index)), el("span", "name", row.name));
    if (row.panes > 1) {
      const panes = el("span", "panes", String(row.panes));
      panes.title = `${row.panes} panes`;
      r.append(panes);
    }
    r.append(menuButton(key, `window ${row.index} menu`));
    r.onclick = () => {
      actions.attach(row.session);
      actions.selectWindow(row.session, row.index);
    };
    group.append(r);
    if (ui.menu === key) {
      group.append(menuFor(key,
        () => inlineRename(r, key, row.name, (name) => actions.renameWindow(row.session, row.index, name)),
        () => actions.killWindow(row.session, row.index)));
    }
    if (ui.confirm === key) group.append(confirmFor(`Kill window ${row.index}?`, () => actions.killWindow(row.session, row.index)));
  }

  function addWindowRow(session: string): HTMLElement {
    const b = el("button", "row add");
    b.type = "button";
    b.setAttribute("aria-label", `New window in ${session}`);
    b.innerHTML = ICON.plus;
    b.append(el("span", "", "window"));
    b.onclick = () => actions.newWindow(session);
    return b;
  }

  function newSessionButton(): HTMLElement {
    const b = el("button", "btn block");
    b.type = "button";
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
      if (ui.editing !== "new-session") drawFoot();
      return;
    }

    let group: HTMLElement | null = null;
    let groupSession = "";
    const closeGroup = () => { if (group) group.append(addWindowRow(groupSession)); };

    for (const row of sidebarModel(sessions, current)) {
      if (row.kind === "session") {
        closeGroup();
        group = el("div", `group${row.current ? " current" : ""}`);
        groupSession = row.name;
        root.append(group);
        renderSession(row, group);
      } else if (group) {
        renderWindow(row, group);
      }
    }
    closeGroup();
    if (ui.editing !== "new-session") drawFoot(); // never rebuild the footer while its prompt is open
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
