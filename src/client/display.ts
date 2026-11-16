// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ClientMessage, ServerSettings } from "../shared/protocol";
import { setThemeChoice, themeChoice, type ThemeChoice } from "./theme";

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
const DEVICE_VIEW_KEY = "muxnexus.device-view";
const WORKSPACE_VIEW_KEY = "muxnexus.workspace-view";

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

/**
 * What this browser shows of a workspace: each agent as a conversation, or the
 * desk's terminal. A touch device defaults to the conversation, because
 * attaching a terminal from a phone resizes the agent's screen at the desk.
 * Read once when the page loads; a change takes effect on reload.
 */
export type DeviceView = "conversation" | "terminal";

export function deviceView(store?: Store, touch: number = navigator.maxTouchPoints): DeviceView {
  try {
    const v = (store ?? localStorage).getItem(DEVICE_VIEW_KEY);
    if (v === "conversation" || v === "terminal") return v;
  } catch {
    /* unreadable: the default */
  }
  return touch > 0 ? "conversation" : "terminal";
}

export function setDeviceView(v: DeviceView, store?: Store): void {
  try {
    (store ?? localStorage).setItem(DEVICE_VIEW_KEY, v);
  } catch {
    /* not remembered; the page keeps what it loaded with */
  }
}

/**
 * The workspaces this device shows in the other view than its own, by name:
 * `{"api":{"view":"terminal","id":"$3","server":"812-1794800000"}}`, the id
 * tmux's, to follow a rename by, and the tmux server it is that server's
 * (`state`'s `tmuxServer`): a restarted one hands ids out again. A bare
 * `"terminal"` is how the first version kept one.
 */
function switched(store?: Store): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse((store ?? localStorage).getItem(WORKSPACE_VIEW_KEY) ?? "{}");
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function keep(next: Record<string, unknown>, store?: Store): boolean {
  try {
    (store ?? localStorage).setItem(WORKSPACE_VIEW_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

const viewIn = (v: unknown): DeviceView | undefined => {
  const view = v !== null && typeof v === "object" ? (v as { view?: unknown }).view : v;
  return view === "conversation" || view === "terminal" ? view : undefined;
};
const field = (v: unknown, key: "id" | "server"): string | undefined => {
  const x = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
  return typeof x === "string" ? x : undefined;
};

/** What this browser shows of `session`: the view it was switched to here, else the device's. */
export function workspaceView(session: string | null, store?: Store, touch: number = navigator.maxTouchPoints): DeviceView {
  const own = session === null ? {} : switched(store);
  return (session !== null && Object.hasOwn(own, session) ? viewIn(own[session]) : undefined) ?? deviceView(store, touch);
}

/**
 * Shows `session` as `view` on this device from now on. Switched back to the
 * device's own view it follows that again, a later change included. False:
 * not remembered.
 */
export function setWorkspaceView(session: string, view: DeviceView, store?: Store, touch: number = navigator.maxTouchPoints): boolean {
  const { [session]: before, ...rest } = switched(store);
  const id = field(before, "id");
  const server = field(before, "server");
  return keep(view === deviceView(store, touch) ? rest : { ...rest, [session]: { view, ...(id ? { id } : {}), ...(server ? { server } : {}) } }, store);
}

/**
 * Keeps each switched workspace's view under its name as `sessions` (the
 * server's list, from tmux server `server`) has it. Its id on this same tmux
 * server finds it first, whatever it is called now: renamed, the view moves
 * with it, and a workspace made since under its old name gets none. Else its
 * name does (an id from a tmux server since restarted may be any workspace's),
 * and it learns that workspace's id. One found by neither (killed, or not
 * restored yet) is kept, unless its name is now a workspace found by id.
 * Written only when something changed.
 */
export function followWorkspaces(sessions: readonly { name: string; id: string }[], server: string | null, store?: Store): void {
  const entries = Object.entries(switched(store)).map(([name, v]) => {
    const view = viewIn(v);
    const id = field(v, "id");
    const found = view && id !== undefined && server !== null && field(v, "server") === server ? sessions.find((s) => s.id === id) : undefined;
    return { name, v, view, found };
  });
  const next: Record<string, unknown> = {};
  const put = (name: string, value: unknown) => Object.defineProperty(next, name, { value, enumerable: true, writable: true, configurable: true });
  const stamp = (view: DeviceView, id: string) => ({ view, id, ...(server !== null ? { server } : {}) });
  for (const e of entries) if (e.found) put(e.found.name, stamp(e.view!, e.found.id));
  for (const e of entries) {
    if (e.found || Object.hasOwn(next, e.name)) continue;
    const here = e.view ? sessions.find((s) => s.name === e.name) : undefined;
    put(e.name, here ? stamp(e.view!, here.id) : e.v);
  }
  // In any order: those found by id are put first.
  const same = (pairs: [string, unknown][]) => JSON.stringify(pairs.map(([k, v]) => [k, JSON.stringify(v)]).sort());
  if (same(Object.entries(next)) !== same(entries.map((e) => [e.name, e.v]))) keep(next, store);
}

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

/** What the settings modal hears from the server while it is open. */
export interface DisplayHandle {
  settings(s: ServerSettings, error?: string): void;
}

/**
 * The folders the New agent form looks in for repos: a list with a remove on
 * each, and a field to add one. Saved on the server as soon as it changes, as
 * the switches above apply at once; until the server answers, it says so.
 */
function scanFoldersSection(send: (m: ClientMessage) => void): { el: HTMLElement; receive: DisplayHandle["settings"] } {
  const wrap = el("div", "display-folders");
  const text = el("span", "display-text");
  text.append(
    el("span", "move-opt-name", "Repo folders"),
    el("span", "move-opt-note", "Where New agent looks for git repos to pick from, one level down"),
  );
  const list = el("ul", "display-folder-list");
  const addRow = el("div", "display-folder-add");
  const input = el("input", "na-input");
  input.placeholder = "~/github";
  input.spellcheck = false;
  input.setAttribute("aria-label", "Folder to add");
  const add = el("button", "chat-btn", "Add");
  add.type = "button";
  addRow.append(input, add);
  const error = el("span", "display-folder-error");
  error.setAttribute("role", "alert");
  wrap.append(text, list, addRow, error);

  let folders: string[] | null = null;
  /** A folder sent to be added: its answer clears the field, or keeps it to fix. */
  let adding = false;
  const save = (next: string[]) => {
    error.textContent = "";
    send({ t: "settings-save", settings: { scanFolders: next } });
  };
  const paint = () => {
    list.replaceChildren();
    if (!folders) {
      list.append(el("li", "display-folder-none", "Loading…"));
      return;
    }
    if (!folders.length) list.append(el("li", "display-folder-none", "None: New agent offers only recent folders"));
    for (const f of folders) {
      const li = el("li", "display-folder");
      const x = el("button", "icon-btn", "✕");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${f}`);
      x.onclick = () => save(folders!.filter((g) => g !== f));
      li.append(el("span", "display-folder-path", f), x);
      list.append(li);
    }
  };
  const submit = () => {
    const f = input.value.trim();
    if (!f || !folders) return;
    adding = true;
    save([...folders, f]);
  };
  add.onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  paint();
  send({ t: "settings-get" });
  return {
    el: wrap,
    receive(s, err) {
      if (!wrap.isConnected) return;
      if (adding && !err) input.value = "";
      adding = false;
      folders = s.scanFolders;
      error.textContent = err ?? "";
      paint();
    },
  };
}

/**
 * The settings modal. "This device" is what this browser remembers for
 * itself: one switch per mark, each saying what it is for, so a mark that has
 * become noise can go without hunting for where it lives. "This server" is
 * saved beside the server, so every device sees the same. `onChange` is told
 * after every switch, to redraw whatever wears the marks.
 */
export function openDisplay(host: HTMLElement, onChange: () => void, send: (m: ClientMessage) => void): DisplayHandle {
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
  box.append(el("div", "move-cap display-cap", "THIS DEVICE"));

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

  {
    // The page and its terminals, light or dark together; switched in place, no reload.
    const row = el("label", "display-row");
    const select = el("select", "display-select");
    for (const [value, title] of [["dark", "Dark"], ["light", "Light"], ["system", "Match system"]] as const) {
      const o = el("option", undefined, title);
      o.value = value;
      o.selected = value === themeChoice();
      select.append(o);
    }
    select.onchange = () => setThemeChoice(select.value as ThemeChoice);
    const text = el("span", "display-text");
    text.append(el("span", "move-opt-name", "Appearance"), el("span", "move-opt-note", "The page and its terminals; Match system follows this device's light or dark setting"));
    row.append(text, select);
    box.append(row);
  }

  {
    // Read once at load: the page is built for one or the other, so this takes a reload.
    const row = el("label", "display-row");
    const select = el("select", "display-select");
    for (const [value, title] of [["conversation", "Conversation"], ["terminal", "Terminal"]] as const) {
      const o = el("option", undefined, title);
      o.value = value;
      o.selected = value === deviceView();
      select.append(o);
    }
    select.onchange = () => setDeviceView(select.value as DeviceView);
    const text = el("span", "display-text");
    text.append(el("span", "move-opt-name", "On this device"), el("span", "move-opt-note", "Conversation shows each agent as a chat; Terminal is the desk's view. Takes effect when the page reloads. A workspace switched from its ⋯ menu keeps its own."));
    row.append(text, select);
    box.append(row);
  }
  box.append(el("div", "move-cap display-cap", "THIS SERVER · SAME ON EVERY DEVICE"));
  const folders = scanFoldersSection(send);
  box.append(folders.el);

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
  return { settings: folders.receive };
}
