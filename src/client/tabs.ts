import type { SessionInfo, WindowInfo } from "../shared/protocol";
import { makeReorderable, moveItem } from "./reorder";
import { agentTitle, GLYPH, profileBadge, sharedCheckouts, sharingTitle, windowGlyph, type Sharing } from "./agent";
import { ICONS } from "./icons";
import { tabLabel, windowPlace } from "./labels";
import { badgesShown } from "./usage";

/** The windows of the attached session, in tmux order. Empty when nothing is attached. */
export function tabsModel(sessions: SessionInfo[], current: string | null): WindowInfo[] {
  if (!current) return [];
  return sessions.find((s) => s.name === current)?.windows ?? [];
}

export { tabLabel };

/** Every window is addressed by tmux's id (`@3`): an index is a slot windows move through. */
export interface TabActions {
  selectWindow(id: string): void;
  newWindow(): void;
  renameWindow(id: string, name: string): void;
  killWindow(id: string): void;
  /** The whole wanted tab order, as window ids. */
  reorderWindows(ids: string[]): void;
}

export interface Tabs {
  render(sessions: SessionInfo[], current: string | null): void;
  /** The Claude profiles on this machine, in the quota panel's order, which picks each badge's colour. */
  setProfiles(labels: string[]): void;
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

export function createTabs(root: HTMLElement, actions: TabActions): Tabs {
  // Keyed by window id, so an open menu or kill confirm stays on its own tab
  // when a poll arrives with the windows in new slots.
  const ui: { menu: string | null; confirm: string | null; editing: string | null } = { menu: null, confirm: null, editing: null };
  let lastSessions: SessionInfo[] = [];
  let lastCurrent: string | null = null;
  let sharing = new Map<string, Sharing>();
  let profiles: string[] = [];

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

  function menuFor(tab: HTMLElement, w: WindowInfo): HTMLElement {
    const m = el("div", "tab-menu");
    const rename = button("btn", "Rename");
    rename.onclick = (e) => {
      e.stopPropagation();
      ui.menu = null;
      m.remove();
      inlineRename(tab, w.id, tabLabel(w));
    };
    m.append(rename);
    // Dragging is the other half of this; on a phone the menu is the only half.
    const order = tabsModel(lastSessions, lastCurrent).map((x) => x.id);
    const at = order.indexOf(w.id);
    const move = (delta: number) => {
      const to = at + delta + (delta > 0 ? 1 : 0); // insertion point, not position
      ui.menu = null;
      actions.reorderWindows(moveItem(order, at, to));
    };
    if (at > 0) {
      const left = button("btn", "Move left");
      left.onclick = (e) => { e.stopPropagation(); move(-1); };
      m.append(left);
    }
    if (at >= 0 && at < order.length - 1) {
      const right = button("btn", "Move right");
      right.onclick = (e) => { e.stopPropagation(); move(1); };
      m.append(right);
    }
    const kill = button("btn", "Kill");
    kill.onclick = (e) => {
      e.stopPropagation();
      ui.menu = null;
      ui.confirm = w.id;
      rerender();
    };
    m.append(kill);
    return m;
  }

  function confirmFor(w: WindowInfo): HTMLElement {
    const c = el("div", "tab-menu confirm");
    // Named by what the tab shows: its index is not on screen any more.
    c.append(el("span", "label", `Kill ${tabLabel(w)}?`));
    const yes = button("btn danger", "Kill");
    yes.onclick = (e) => {
      e.stopPropagation();
      ui.confirm = null;
      actions.killWindow(w.id);
    };
    const no = button("btn", "Cancel");
    no.onclick = (e) => {
      e.stopPropagation();
      ui.confirm = null;
      rerender();
    };
    c.append(yes, no);
    return c;
  }

  function renderTab(w: WindowInfo): HTMLElement {
    const tab = el("div", `tab${w.active ? " active" : ""}${ui.menu === w.id || ui.confirm === w.id ? " menu-open" : ""}`);

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
    const shared = sharing.get(w.id);
    if (shared) name.append(checkoutMark(shared));
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
    menuBtn.setAttribute("aria-label", `Window ${w.index} menu`);
    menuBtn.innerHTML = ICON.dots;
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      ui.menu = ui.menu === w.id ? null : w.id;
      ui.confirm = null;
      rerender();
    };

    // The whole tab drags: reorder.ts arms on the name after enough travel, so
    // a click still selects and a double-click still renames.
    tab.append(name, menuBtn);
    if (ui.menu === w.id) tab.append(menuFor(tab, w));
    if (ui.confirm === w.id) tab.append(confirmFor(w));
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
    root.hidden = windows.length === 0;
    if (windows.length === 0) return;

    sharing = sharedCheckouts(sessions, windowPlace);
    for (const w of windows) root.append(renderTab(w));

    const add = button("row-btn tab-new");
    add.setAttribute("aria-label", "New window");
    add.title = "New window";
    add.innerHTML = ICON.plus;
    add.onclick = () => actions.newWindow();
    root.append(add);
  }

  makeReorderable(root, {
    axis: "x",
    rows: () => [...root.querySelectorAll<HTMLElement>(":scope > .tab")],
    commit: (order) => {
      const ids = tabsModel(lastSessions, lastCurrent).map((w) => w.id);
      actions.reorderWindows(order.map((i) => ids[i]).filter((id) => id !== undefined));
    },
  });

  return {
    render: draw,
    setProfiles(labels) {
      if (labels.join("\n") === profiles.join("\n")) return;
      profiles = labels;
      if (lastCurrent) rerender();
    },
  };
}
