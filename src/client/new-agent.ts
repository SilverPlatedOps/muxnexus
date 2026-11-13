// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { NewWindowAgent } from "../shared/protocol";

/**
 * New agent: the one form for starting something new, wherever it is asked
 * for (the ＋ at the top of the list, a group's ＋, its menu). It asks what the
 * chat picker always asked and the old "New session" box never did: which
 * agent, in which folder, on which account.
 */

export type AgentChoice = "claude" | "codex" | "shell";

export interface NewAgentRequest {
  name: string;
  folder?: string;
  agent?: NewWindowAgent;
  profile?: string;
}

/** The workspace name a request makes: its group as the tag, else just the name. */
export function workspaceName(name: string, group: string | null): string {
  // tmux takes neither . nor : in a session name (it would quietly rename it).
  const n = name.trim().replace(/[.:]/g, "-");
  return group ? `[${group}] ${n}` : n;
}

/** What the name field suggests: the folder's last part (`~/github/shop-api` → `shop-api`). */
export function nameFromFolder(folder: string): string {
  return folder.trim().replace(/\/+$/, "").split("/").pop() ?? "";
}

/** A home folder as ~, the way a terminal shows it. */
export const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

/** The account a group spends by default: a Claude profile named like it, else none (the default). */
export function groupAccount(group: string | null, profiles: readonly string[]): string | null {
  const want = group?.toLowerCase();
  return profiles.find((p) => p.toLowerCase() === want) ?? null;
}

export function buildRequest(f: { name: string; folder: string; group: string | null; agent: AgentChoice; profile: string | null }): NewAgentRequest | null {
  const bare = (f.name || nameFromFolder(f.folder)).trim();
  if (!bare) return null;
  const name = workspaceName(bare, f.group);
  return {
    name,
    ...(f.folder.trim() ? { folder: f.folder.trim() } : {}),
    ...(f.agent === "shell" ? {} : { agent: f.agent }),
    ...(f.agent === "claude" && f.profile ? { profile: f.profile } : {}),
  };
}

const RECENT_KEY = "muxnexus.recentFolders";
export function recentFolders(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]; } catch { return []; }
}
function rememberFolder(folder: string) {
  const f = folder.trim();
  if (!f) return;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([f, ...recentFolders().filter((x) => x !== f)].slice(0, 8))); } catch { /* private window */ }
}

export interface NewAgentOpts {
  group: string | null;
  groups: string[];
  /** Folders the open workspaces' agents work in, newest first. */
  folders: string[];
  /** Claude accounts, as the quota panel names them. */
  profiles: string[];
  submit(r: NewAgentRequest): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The folders the picker lists for what is typed: every word somewhere in the
 * path, in any case. The ones whose name is the query come first, then those
 * whose name starts with it, then those whose name holds it, then the rest;
 * within each, recent folders before repos, each list in its own order.
 * Nothing typed lists them all, recent first.
 */
export function matchFolders(query: string, recents: readonly string[], repos: readonly string[], limit = 50): string[] {
  const all = [...new Set([...recents, ...repos])];
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const words = q.split(/\s+/);
  const rank = (p: string) => {
    const n = nameFromFolder(p).toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
  };
  return all
    .filter((p) => words.every((w) => p.toLowerCase().includes(w)))
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.p);
}

/**
 * The folder field with a list under it: the server's repos and the recent
 * folders, narrowed as you type. ↑↓ move, Enter or a click picks, Escape
 * closes the list (a second one the form). Any path can still be typed. It
 * opens on focus showing everything, so a prefilled folder does not hide the
 * rest; it narrows from the first keystroke.
 */
function folderPicker(input: HTMLInputElement, recents: readonly string[], pick: (f: string) => void) {
  const wrap = el("div", "na-combo");
  const list = el("ul", "na-list");
  list.id = `na-list-${Math.random().toString(36).slice(2)}`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  input.autocomplete = "off";
  wrap.append(input, list);

  let repos: string[] = [];
  let shown: string[] = [];
  let hi = 0;
  let narrowed = false;

  const highlight = (i: number) => {
    hi = i;
    [...list.children].forEach((li, j) => li.setAttribute("aria-selected", String(j === hi)));
    list.children[hi]?.scrollIntoView({ block: "nearest" });
  };
  const paint = () => {
    shown = matchFolders(narrowed ? input.value : "", recents, repos);
    list.replaceChildren(...shown.map((f) => {
      const li = el("li", "na-opt");
      li.setAttribute("role", "option");
      const slash = f.lastIndexOf("/");
      li.append(el("span", "na-opt-name", nameFromFolder(f) || f), el("span", "na-opt-path", slash > 0 ? f.slice(0, slash) : ""));
      li.title = f;
      // Picked on mousedown, kept from blurring the field, so the list does not close first.
      li.onmousedown = (e) => { e.preventDefault(); choose(f); };
      return li;
    }));
    const open = document.activeElement === input && shown.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    highlight(0);
  };
  const shut = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const choose = (f: string) => { pick(f); narrowed = false; shut(); };

  input.addEventListener("focus", () => { narrowed = false; input.select(); paint(); });
  input.addEventListener("blur", shut);
  input.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (list.hidden) {
      if (e.key === "ArrowDown") { e.preventDefault(); paint(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      highlight((hi + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (shown[hi]) choose(shown[hi]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      shut();
    }
  });

  return {
    el: wrap,
    typed() { narrowed = true; paint(); },
    repos(r: string[]) {
      if (!wrap.isConnected) return;
      repos = r;
      if (document.activeElement === input) paint();
    },
  };
}

export interface NewAgentHandle {
  /** The server's answer to `repos`: the git checkouts to offer. */
  repos(list: string[]): void;
}

export function openNewAgent(host: HTMLElement, o: NewAgentOpts): NewAgentHandle {
  const back = el("div", "modal-back");
  const box = el("div", "move new-agent");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "New agent");
  const head = el("div", "move-head");
  head.append(el("span", "move-title", "New agent"));
  const x = el("button", "icon-btn move-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  x.onclick = () => close();
  head.append(x);

  const state = { agent: "claude" as AgentChoice, group: o.group, profile: groupAccount(o.group, o.profiles), profileChosen: false };
  const known = [...new Set([...recentFolders(), ...o.folders.map(tilde)])];
  const recents = known.slice(0, 6);

  const field = (label: string, control: HTMLElement, note?: HTMLElement) => {
    const f = el("label", "na-field");
    f.append(el("span", "na-label", label), control);
    if (note) f.append(note);
    return f;
  };
  const name = el("input", "na-input");
  name.setAttribute("aria-label", "Name");
  name.spellcheck = false;
  const folder = el("input", "na-input");
  folder.setAttribute("aria-label", "Folder");
  folder.placeholder = "~ (or a full path)";
  folder.spellcheck = false;
  folder.value = recents[0] ?? "";
  const chips = el("div", "na-chips");
  const paintName = () => { name.placeholder = nameFromFolder(folder.value) || "name"; };
  for (const f of recents) {
    const c = el("button", "na-chip", nameFromFolder(f) || f);
    c.type = "button";
    c.title = f;
    c.onclick = () => pick(f);
    chips.append(c);
  }
  const paintChips = () => { for (const c of chips.children) c.classList.toggle("on", (c as HTMLElement).title === folder.value); };
  const pick = (f: string) => { folder.value = f; paintName(); paintChips(); };
  const picker = folderPicker(folder, known, pick);
  folder.oninput = () => { paintName(); paintChips(); picker.typed(); };

  const seg = (values: readonly [string, string][], get: () => string, set: (v: string) => void) => {
    const s = el("div", "na-seg");
    const paint = () => { for (const b of s.children) b.classList.toggle("on", (b as HTMLElement).dataset.v === get()); };
    for (const [v, label] of values) {
      const b = el("button", "na-seg-btn", label);
      b.type = "button";
      b.dataset.v = v;
      b.onclick = () => { set(v); paint(); paintAccount(); };
      s.append(b);
    }
    paint();
    return s;
  };
  const kinds = seg([["claude", "Claude"], ["codex", "Codex"], ["shell", "Shell"]], () => state.agent, (v) => { state.agent = v as AgentChoice; });
  const groups = seg([...o.groups.map((g) => [g, g] as [string, string]), ["", "No group"]], () => state.group ?? "", (v) => {
    state.group = v || null;
    if (!state.profileChosen) state.profile = groupAccount(state.group, o.profiles);
  });

  const account = el("select", "na-input");
  account.setAttribute("aria-label", "Account");
  const accountNote = el("span", "na-note");
  account.onchange = () => { state.profile = account.value || null; state.profileChosen = true; };
  function paintAccount() {
    account.replaceChildren();
    account.disabled = state.agent !== "claude";
    if (state.agent === "codex") account.append(el("option", undefined, "codex (its own login)"));
    else if (state.agent === "shell") account.append(el("option", undefined, "none: a shell spends nothing"));
    else {
      const def = el("option", undefined, "the group's (default)");
      def.value = "";
      account.append(def);
      for (const p of o.profiles) {
        const opt = el("option", undefined, p);
        opt.value = p;
        opt.selected = p === state.profile;
        account.append(opt);
      }
    }
    accountNote.textContent = state.agent === "claude" && state.profile && !state.profileChosen ? `From the group: ${state.group} spends ${state.profile}` : "";
    where.textContent = `Opens as a new workspace${state.group ? ` in ${state.group}` : ""}`;
  }

  const foot = el("div", "na-foot");
  const where = el("span", "na-note");
  const cancel = el("button", "chat-btn", "Cancel");
  cancel.type = "button";
  cancel.onclick = () => close();
  const start = el("button", "chat-btn pri", "Start ⌘↵");
  start.type = "button";
  const go = () => {
    const r = buildRequest({ name: name.value, folder: folder.value, group: state.group, agent: state.agent, profile: state.profile });
    if (!r) { name.focus(); return; }
    rememberFolder(folder.value);
    close();
    o.submit(r);
  };
  start.onclick = go;
  foot.append(where, cancel, start);

  box.append(
    head,
    field("Name", name),
    field("Agent", kinds),
    field("Folder", picker.el, chips),
    field("Group", groups),
    field("Account", account, accountNote),
    foot,
  );
  back.append(box);
  paintName();
  paintChips();
  paintAccount();

  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && (e.metaKey || e.target === name)) { e.preventDefault(); go(); }
  }
  box.addEventListener("keydown", (e) => { e.stopPropagation(); keys(e); });
  function close() { back.remove(); }
  back.onclick = (e) => { if (e.target === back) close(); };
  host.append(back);
  name.focus();
  return { repos: picker.repos };
}
