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
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface UiState {
  menu: string | null;
  confirm: string | null;
  editing: string | null;
}

const sessionKey = (name: string) => `s:${name}`;
const windowKey = (session: string, index: number) => `w:${session}:${index}`;

export function createSidebar(root: HTMLElement, layout: HTMLElement, actions: SidebarActions): Sidebar {
  const ui: UiState = { menu: null, confirm: null, editing: null };
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;

  const rerender = () => draw(lastSessions, lastCurrent);

  function menuButton(key: string): HTMLElement {
    const b = el("button", "menu-btn", "⋯");
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
    const rename = el("button", "", "Rename");
    rename.onclick = () => { ui.menu = null; m.remove(); onRename(); };
    const kill = el("button", "", "Kill");
    kill.onclick = () => { ui.menu = null; ui.confirm = key; rerender(); };
    m.append(rename, kill);
    return m;
  }

  function confirmFor(label: string, onYes: () => void): HTMLElement {
    const c = el("div", "confirm");
    const yes = el("button", "yes", "Kill");
    yes.onclick = () => { ui.confirm = null; onYes(); };
    const no = el("button", "", "Cancel");
    no.onclick = () => { ui.confirm = null; rerender(); };
    c.append(el("span", "", label), yes, no);
    return c;
  }

  /** Swap a row's name span for an input; commit on Enter or blur, cancel on Escape. */
  function inlineRename(row: HTMLElement, key: string, initial: string, commit: (name: string) => void) {
    const nameEl = row.querySelector(".name");
    if (!nameEl) return; // menu already gone (e.g. a second Rename click); nothing to swap
    ui.editing = key;
    const input = el("input", "rename") as HTMLInputElement;
    input.value = initial;
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

  function addButton(cls: string, label: string, onClick: () => void): HTMLElement {
    const b = el("button", `add ${cls}`, label);
    b.onclick = onClick;
    return b;
  }

  function renderSession(row: Extract<Row, { kind: "session" }>): HTMLElement[] {
    const key = sessionKey(row.name);
    const r = el("div", `row session${row.current ? " current" : ""}${ui.menu === key ? " menu-open" : ""}`);
    r.append(el("span", `dot${row.attached ? " on" : ""}`), el("span", "name", row.name), menuButton(key));
    r.title = row.attached ? "another client is attached" : "";
    r.onclick = () => actions.attach(row.name);
    const out: HTMLElement[] = [r];
    if (ui.menu === key) {
      out.push(menuFor(key,
        () => inlineRename(r, key, row.name, (name) => actions.renameSession(row.name, name)),
        () => actions.killSession(row.name)));
    }
    if (ui.confirm === key) out.push(confirmFor(`Kill session "${row.name}"?`, () => actions.killSession(row.name)));
    return out;
  }

  function renderWindow(row: Extract<Row, { kind: "window" }>): HTMLElement[] {
    const key = windowKey(row.session, row.index);
    const r = el("div", `row window${row.active ? " active" : ""}${ui.menu === key ? " menu-open" : ""}`);
    r.append(
      el("span", "name", `${row.index}: ${row.name}${row.panes > 1 ? ` (${row.panes})` : ""}`),
      menuButton(key),
    );
    r.onclick = () => {
      actions.attach(row.session);
      actions.selectWindow(row.session, row.index);
    };
    const out: HTMLElement[] = [r];
    if (ui.menu === key) {
      out.push(menuFor(key,
        () => inlineRename(r, key, row.name, (name) => actions.renameWindow(row.session, row.index, name)),
        () => actions.killWindow(row.session, row.index)));
    }
    if (ui.confirm === key) out.push(confirmFor(`Kill window ${row.index}?`, () => actions.killWindow(row.session, row.index)));
    return out;
  }

  function newSessionPrompt(): HTMLElement {
    const wrap = el("div", "row");
    const input = el("input", "rename") as HTMLInputElement;
    input.placeholder = "new session name";
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && input.value.trim()) { ui.editing = null; actions.newSession(input.value.trim()); }
      else if (e.key === "Escape") { ui.editing = null; rerender(); }
    };
    input.onblur = () => { if (ui.editing === "new-session") { ui.editing = null; rerender(); } };
    wrap.append(input);
    queueMicrotask(() => input.focus());
    return wrap;
  }

  function draw(sessions: SessionInfo[], current: string | null) {
    lastSessions = sessions;
    lastCurrent = current;
    if (ui.editing) return; // keep the open editor (rename input or new-session prompt) alive
    root.replaceChildren();
    if (sessions.length === 0) root.append(el("div", "row", "No tmux server"));
    for (const row of sidebarModel(sessions, current)) {
      if (row.kind === "session") root.append(...renderSession(row));
      else root.append(...renderWindow(row));
      const isLastWindowOfSession =
        row.kind === "window" &&
        sessions.find((s) => s.name === row.session)!.windows.at(-1)!.index === row.index;
      if (isLastWindowOfSession) {
        root.append(addButton("", "+ window", () => actions.newWindow(row.session)));
      }
    }
    const btn = el("button", "add session", "+ session");
    btn.onclick = () => { ui.editing = "new-session"; btn.replaceWith(newSessionPrompt()); };
    root.append(btn);
  }

  return {
    render: draw,
    toast(message) {
      const t = el("div", "toast", message);
      document.body.append(t);
      setTimeout(() => t.remove(), 4000);
    },
    toggle() {
      layout.classList.toggle("collapsed");
    },
  };
}
