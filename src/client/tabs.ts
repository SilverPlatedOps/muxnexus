import type { SessionInfo, WindowInfo } from "../shared/protocol";

/** The windows of the attached session, in tmux order. Empty when nothing is attached. */
export function tabsModel(sessions: SessionInfo[], current: string | null): WindowInfo[] {
  if (!current) return [];
  return sessions.find((s) => s.name === current)?.windows ?? [];
}

/** What a tab is called: cmux's own title for it, else tmux's window name. */
export function tabLabel(w: WindowInfo): string {
  return w.label ?? w.name;
}

export interface TabActions {
  selectWindow(index: number): void;
  newWindow(): void;
  renameWindow(index: number, name: string): void;
  killWindow(index: number): void;
}

export interface Tabs {
  render(sessions: SessionInfo[], current: string | null): void;
}

const ICON = {
  dots: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="4" cy="8" r="1.1"></circle><circle cx="8" cy="8" r="1.1"></circle><circle cx="12" cy="8" r="1.1"></circle></svg>',
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

export function createTabs(root: HTMLElement, actions: TabActions): Tabs {
  const ui = { menu: -1, confirm: -1, editing: -1 };
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;

  const rerender = () => draw(lastSessions, lastCurrent);

  /** Rename in place: the tab's label becomes an input. */
  function inlineRename(tab: HTMLElement, index: number, initial: string) {
    const labelEl = tab.querySelector(".label");
    if (!labelEl) return;
    ui.editing = index;
    const input = el("input", "tab-rename") as HTMLInputElement;
    input.type = "text";
    input.value = initial;
    input.setAttribute("aria-label", "Window name");
    labelEl.replaceWith(input);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      ui.editing = -1;
      const name = input.value.trim();
      if (save && name && name !== initial) actions.renameWindow(index, name);
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

  function menuFor(tab: HTMLElement, w: WindowInfo): HTMLElement {
    const m = el("div", "tab-menu");
    const rename = button("btn", "Rename");
    rename.onclick = (e) => {
      e.stopPropagation();
      ui.menu = -1;
      m.remove();
      inlineRename(tab, w.index, w.name); // rename targets tmux's name, not the cmux title
    };
    const kill = button("btn", "Kill");
    kill.onclick = (e) => {
      e.stopPropagation();
      ui.menu = -1;
      ui.confirm = w.index;
      rerender();
    };
    m.append(rename, kill);
    return m;
  }

  function confirmFor(w: WindowInfo): HTMLElement {
    const c = el("div", "tab-menu confirm");
    c.append(el("span", "label", `Kill ${w.index}?`));
    const yes = button("btn danger", "Kill");
    yes.onclick = (e) => {
      e.stopPropagation();
      ui.confirm = -1;
      actions.killWindow(w.index);
    };
    const no = button("btn", "Cancel");
    no.onclick = (e) => {
      e.stopPropagation();
      ui.confirm = -1;
      rerender();
    };
    c.append(yes, no);
    return c;
  }

  function renderTab(w: WindowInfo): HTMLElement {
    const tab = el("div", `tab${w.active ? " active" : ""}${ui.menu === w.index || ui.confirm === w.index ? " menu-open" : ""}`);

    const name = button("name");
    name.append(el("span", "idx", String(w.index)), el("span", "label", tabLabel(w)));
    if (w.panes > 1) {
      const panes = el("span", "panes", String(w.panes));
      panes.title = `${w.panes} panes`;
      name.append(panes);
    }
    name.onclick = () => actions.selectWindow(w.index);

    const menuBtn = button("row-btn tab-dots");
    menuBtn.setAttribute("aria-label", `Window ${w.index} menu`);
    menuBtn.innerHTML = ICON.dots;
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      ui.menu = ui.menu === w.index ? -1 : w.index;
      ui.confirm = -1;
      rerender();
    };

    tab.append(name, menuBtn);
    if (ui.menu === w.index) tab.append(menuFor(tab, w));
    if (ui.confirm === w.index) tab.append(confirmFor(w));
    return tab;
  }

  function draw(sessions: SessionInfo[], current: string | null) {
    lastSessions = sessions;
    lastCurrent = current;
    if (ui.editing !== -1) return; // keep an open rename input alive
    const windows = tabsModel(sessions, current);
    root.replaceChildren();
    root.hidden = windows.length === 0;
    if (windows.length === 0) return;

    for (const w of windows) root.append(renderTab(w));

    const add = button("row-btn tab-new");
    add.setAttribute("aria-label", "New window");
    add.title = "New window";
    add.innerHTML = ICON.plus;
    add.onclick = () => actions.newWindow();
    root.append(add);
  }

  return { render: draw };
}
