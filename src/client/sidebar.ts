import type { SessionInfo } from "../shared/protocol";

export type Row =
  | { kind: "session"; name: string; attached: boolean; current: boolean }
  | { kind: "window"; session: string; index: number; name: string; active: boolean; panes: number };

export function sidebarModel(sessions: SessionInfo[], current: string | null): Row[] {
  const rows: Row[] = [];
  for (const s of sessions) {
    rows.push({ kind: "session", name: s.name, attached: s.attached > 0, current: s.name === current });
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

export function createSidebar(root: HTMLElement, layout: HTMLElement, actions: SidebarActions): Sidebar {
  function renderRow(row: Row): HTMLElement {
    if (row.kind === "session") {
      const r = el("div", `row session${row.current ? " current" : ""}`);
      r.append(el("span", `dot${row.attached ? " on" : ""}`), el("span", "name", row.name));
      r.title = row.attached ? "another client is attached" : "";
      r.onclick = () => actions.attach(row.name);
      return r;
    }
    const r = el("div", `row window${row.active ? " active" : ""}`);
    r.append(el("span", "name", `${row.index}: ${row.name}${row.panes > 1 ? ` (${row.panes})` : ""}`));
    r.onclick = () => {
      actions.attach(row.session);
      actions.selectWindow(row.session, row.index);
    };
    return r;
  }

  return {
    render(sessions, current) {
      root.replaceChildren();
      if (sessions.length === 0) root.append(el("div", "row", "No tmux server"));
      for (const row of sidebarModel(sessions, current)) root.append(renderRow(row));
    },
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
