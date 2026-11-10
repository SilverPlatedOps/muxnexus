// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { VIEW_CHOICES, type ViewName } from "./view-host";
import { setTermTheme, termTheme } from "./theme";

/**
 * What the tabs and rows wear besides their name, and the one modal that
 * switches it: the profile badge and the shared-checkout mark. Remembered per
 * browser like the folded groups -- a viewer's convenience, not shared state.
 * On unless switched off, so a browser that has never chosen sees them; a
 * browser whose storage is blocked sees them too, and its choice lasts the page.
 * Memory on tabs is the exception, off until chosen.
 */

const BADGES_KEY = "muxnexus.badges";
const MARKS_KEY = "muxnexus.checkout-marks";
const SYSTEM_KEY = "muxnexus.system";
const MEMORY_KEY = "muxnexus.tab-memory";

/** What the preference is kept in: `localStorage`, or a stand-in under test. */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function shown(key: string, store?: Store): boolean {
  try {
    return (store ?? localStorage).getItem(key) !== "0";
  } catch {
    return true;
  }
}

/** The opposite default: off unless this browser switched it on. For a mark that adds a figure to every tab. */
function shownIfChosen(key: string, store?: Store): boolean {
  try {
    return (store ?? localStorage).getItem(key) === "1";
  } catch {
    return false;
  }
}

function setShown(key: string, on: boolean, store?: Store): void {
  try {
    (store ?? localStorage).setItem(key, on ? "1" : "0");
  } catch {
    /* not remembered; the page still switches */
  }
}

/** Whether the tabs wear their agent's profile badge, and the quota panel its legend. */
export const badgesShown = (store?: Store) => shown(BADGES_KEY, store);
export const setBadgesShown = (on: boolean, store?: Store) => setShown(BADGES_KEY, on, store);

/** Whether an agent sharing its checkout with another live one says so. */
export const marksShown = (store?: Store) => shown(MARKS_KEY, store);
export const setMarksShown = (on: boolean, store?: Store) => setShown(MARKS_KEY, on, store);

/** Whether the notes panel ends in the system overview; its own ✕ switches this off too. */
export const systemShown = (store?: Store) => shown(SYSTEM_KEY, store);
export const setSystemShown = (on: boolean, store?: Store) => setShown(SYSTEM_KEY, on, store);

/** Whether each tab shows its memory, and each session row its total. Off by default: the ranked list is the everyday view. */
export const memoryShown = (store?: Store) => shownIfChosen(MEMORY_KEY, store);
export const setMemoryShown = (on: boolean, store?: Store) => setShown(MEMORY_KEY, on, store);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The licence's on-screen notice, its "Appropriate Legal Notices": the credit
 * and copyright, that it may be shared and changed under the AGPL, that there
 * is no warranty, and where to read the licence. At the foot of the display
 * modal rather than on every screen; NOTICE asks modified versions to keep the
 * credit in theirs, wherever they put them.
 */
export const ABOUT = {
  title: "About muxnexus",
  text: "muxnexus by Aditya Wirya Darma, © 2026. You can share and change it under the GNU AGPL, version 3 or later. It comes with no warranty.",
  links: [
    { label: "Licence", href: "/licence" },
    { label: "github.com/SilverPlatedOps/muxnexus", href: "https://github.com/SilverPlatedOps/muxnexus" },
  ],
};

/**
 * The display modal: one switch per mark, each saying what it is for, so a
 * mark that has become noise can go without hunting for where it lives; and,
 * when `view` is given, which view the main area can show besides the terminal.
 * `onChange` is told after every switch, to redraw whatever wears the marks.
 */
export function openDisplay(
  host: HTMLElement,
  onChange: () => void,
  view?: { chosen: ViewName; choose(name: ViewName): void },
): void {
  const back = el("div", "modal-back");
  const box = el("div", "move display");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Settings");
  const head = el("div", "move-head");
  head.append(el("span", "move-title", "Settings"));
  const x = el("button", "icon-btn move-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.onclick = () => close();
  head.append(x);
  box.append(head);

  const rows: [string, string, () => boolean, (on: boolean) => void][] = [
    ["Account badges", "The account each tab's agent spends, as a letter on the tab", badgesShown, setBadgesShown],
    ["Shared checkout", "Two live agents working in one git checkout, marked on both", marksShown, setMarksShown],
    ["Memory on tabs", "Each tab's memory, and each workspace's total in the sidebar; the ranked list stays in System", memoryShown, setMemoryShown],
  ];
  for (const [name, note, get, set] of rows) {
    const row = el("label", "display-row");
    const input = el("input");
    input.type = "checkbox";
    input.checked = get();
    input.onchange = () => { set(input.checked); onChange(); };
    const text = el("span", "display-text");
    text.append(el("span", "move-opt-name", name), el("span", "move-opt-note", note));
    row.append(text, input);
    box.append(row);
  }

  if (view) {
    const row = el("label", "display-row");
    const select = el("select", "display-select");
    for (const c of VIEW_CHOICES) {
      const o = el("option", undefined, c.title);
      o.value = c.name;
      o.selected = c.name === view.chosen;
      select.append(o);
    }
    select.onchange = () => view.choose(select.value as ViewName);
    const text = el("span", "display-text");
    text.append(
      el("span", "move-opt-name", "Main area can also show"),
      el("span", "move-opt-note", "What the main area can show besides the terminal; the top bar switches between them"),
    );
    row.append(text, select);
    box.append(row);
  }

  {
    // The terminal palette, which only ?theme=light could pick before: saved, and taken on reload.
    const row = el("label", "display-row");
    const select = el("select", "display-select");
    for (const [value, title] of [["dark", "Dark"], ["light", "Light"]] as const) {
      const o = el("option", undefined, title);
      o.value = value;
      o.selected = value === termTheme();
      select.append(o);
    }
    select.onchange = () => {
      setTermTheme(select.value === "light" ? "light" : "dark");
      // A `?theme=` in the address would win over the choice on reload: drop it.
      const url = new URL(location.href);
      url.searchParams.delete("theme");
      location.replace(url);
    };
    const text = el("span", "display-text");
    text.append(el("span", "move-opt-name", "Terminal colours"), el("span", "move-opt-note", "Reloads the page to repaint the terminals"));
    row.append(text, select);
    box.append(row);
  }

  const about = el("section", "display-about");
  about.setAttribute("aria-label", ABOUT.title);
  const links = el("span", "display-about-links");
  ABOUT.links.forEach((l, i) => {
    const a = el("a", undefined, l.label);
    a.href = l.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (i > 0) links.append(" · ");
    links.append(a);
  });
  about.append(el("span", "move-opt-name", ABOUT.title), el("span", "move-opt-note", ABOUT.text), links);
  box.append(about);

  back.append(box);
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", esc);
  };
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener("keydown", esc);
  host.append(back);
  (box.querySelector("input") as HTMLInputElement | null)?.focus();
}
