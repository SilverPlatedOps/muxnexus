// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * What each thing's menu holds, as data. One builder per kind of thing, so the
 * menu on a sidebar row, the title bar, a tab and a chat member is the same list
 * in the same order wherever it opens -- the renderer (popover.ts) only draws it.
 *
 * Order, every menu: open · look · do · name & place · put away · destroy.
 * Something that can't apply to an agent's kind is disabled with its reason,
 * not hidden, so the list keeps its shape.
 */

export type MenuAction =
  | "open" | "open-beside" | "note" | "new-tab-claude" | "new-tab-codex" | "new-tab-shell"
  | "start-chat" | "change-account" | "rename" | "move-group" | "archive" | "unarchive" | "kill"
  | "kill-workspace" | "new-agent-in-group" | "rename-group" | "fold" | "unfold"
  | "chat-open" | "chat-notes" | "chat-settings" | "chat-rename" | "chat-archive" | "chat-reopen" | "chat-delete"
  | "member-note" | "member-terminal" | "change-role" | "replace" | "remove" | "reconnect";

export interface MenuItem {
  action: MenuAction;
  label: string;
  hint?: string;
  danger?: boolean;
  /** Why it can't be used here: shown as its tooltip. */
  disabled?: string;
  /** A submenu (New tab ›). */
  children?: MenuItem[];
  /** Present on anything that can't be undone: the item asks this, in place, first. */
  confirm?: string;
  /** The red button's word (Kill, Delete, Remove). */
  confirmLabel?: string;
  /** A checkbox inside the confirm, such as Delete chat's "Also shut down …". */
  option?: string;
}

export interface Menu {
  title: string;
  sub: string;
  sections: MenuItem[][];
}

export type AgentKind = "claude" | "codex" | "shell";

export interface AgentTarget {
  name: string;
  kind: AgentKind;
  account?: string;
  folder?: string;
  /** A one-tab workspace: the agent is the workspace, so it carries the workspace's items. */
  isWorkspace: boolean;
  current: boolean;
  archived: boolean;
  /** True, or why Open beside can't apply. */
  beside: true | string;
}

const KIND: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", shell: "Shell" };
const STOPS: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", shell: "The shell" };

const sections = (...s: (MenuItem | false | undefined)[][]): MenuItem[][] =>
  s.map((x) => x.filter((i): i is MenuItem => !!i)).filter((x) => x.length > 0);

function newTab(): MenuItem {
  return {
    action: "new-tab-claude",
    label: "New tab",
    children: [
      { action: "new-tab-claude", label: "Claude" },
      { action: "new-tab-codex", label: "Codex" },
      { action: "new-tab-shell", label: "Shell" },
    ],
  };
}

function kill(a: AgentTarget, extra = ""): MenuItem {
  return { action: "kill", label: "Kill…", danger: true, confirm: `Kill ${a.name}? ${STOPS[a.kind]} stops and its tab closes.${extra}`, confirmLabel: "Kill" };
}

/** The agent's items, section by section, without the header. */
function agentSections(a: AgentTarget, opts: { note: boolean; killExtra?: string }): MenuItem[][] {
  const account =
    a.kind === "codex" ? "Codex uses its own login" : a.kind === "shell" ? "A shell spends nothing" : undefined;
  return sections(
    [
      !a.current && { action: "open", label: "Open" },
      { action: "open-beside", label: "Open beside", ...(a.beside === true ? {} : { disabled: a.beside }) },
    ],
    [opts.note && { action: "note", label: "Note", hint: "⌘⇧E" }],
    [
      a.isWorkspace && newTab(),
      { action: "start-chat", label: "Start chat with…", ...(a.kind === "shell" ? { disabled: "A shell can't join a chat" } : {}) },
      { action: "change-account", label: "Change account…", ...(account ? { disabled: account } : {}) },
    ],
    [{ action: "rename", label: "Rename…", hint: "dbl-click" }, a.isWorkspace && { action: "move-group", label: "Move to group…" }],
    [a.isWorkspace && (a.archived ? { action: "unarchive", label: "Unarchive" } : { action: "archive", label: "Archive" })],
    [kill(a, opts.killExtra)],
  );
}

export function agentMenu(a: AgentTarget): Menu {
  return {
    title: a.name,
    sub: [KIND[a.kind], a.account, a.folder].filter(Boolean).join(" · "),
    sections: agentSections(a, { note: true }),
  };
}

export function workspaceMenu(w: { name: string; tabs: number; archived: boolean; folder?: string }): Menu {
  return {
    title: w.name,
    sub: ["Workspace", `${w.tabs} tabs`, w.folder].filter(Boolean).join(" · "),
    sections: sections(
      [newTab()],
      [{ action: "rename", label: "Rename…", hint: "dbl-click" }, { action: "move-group", label: "Move to group…" }],
      [w.archived ? { action: "unarchive", label: "Unarchive" } : { action: "archive", label: "Archive" }],
      [{ action: "kill-workspace", label: "Kill workspace…", hint: `${w.tabs} tabs`, danger: true, confirm: `Kill ${w.name}? Its ${w.tabs} tabs close.`, confirmLabel: "Kill" }],
    ),
  };
}

export function groupMenu(g: { name: string; folded: boolean }): Menu {
  return {
    title: g.name,
    sub: "Group",
    sections: sections(
      [{ action: "new-agent-in-group", label: "New agent in this group…" }],
      [{ action: "rename-group", label: "Rename group…" }],
      [g.folded ? { action: "unfold", label: "Unfold" } : { action: "fold", label: "Fold" }],
    ),
  };
}

export function chatMenu(c: { name: string; archived: boolean; current: boolean; members: number; shutdown?: string }): Menu {
  return {
    title: c.name,
    sub: `Chat · ${c.members} ${c.members === 1 ? "agent" : "agents"}`,
    sections: sections(
      [!c.current && { action: "chat-open", label: "Open" }],
      [{ action: "chat-notes", label: "Chat notes" }, { action: "chat-settings", label: "Settings" }],
      [{ action: "chat-rename", label: "Rename…", hint: "dbl-click" }],
      [c.archived ? { action: "chat-reopen", label: "Reopen" } : { action: "chat-archive", label: "Archive" }],
      [{
        action: "chat-delete", label: "Delete…", danger: true, confirmLabel: "Delete",
        confirm: `Delete "${c.name}" for good? Its messages go. Its agents keep running.`,
        ...(c.shutdown ? { option: c.shutdown } : {}),
      }],
    ),
  };
}

export function memberMenu(m: { handle: string; role?: string; present: boolean; agent: AgentTarget | null }): Menu {
  const remove: MenuItem = { action: "remove", label: "Remove from chat…", danger: true, confirm: `Remove ${m.handle} from this chat?`, confirmLabel: "Remove" };
  const replace: MenuItem = { action: "replace", label: "Replace…" };
  if (!m.present || !m.agent) {
    return { title: m.handle, sub: "Its tab is gone", sections: [[{ action: "reconnect", label: "Reconnect" }, replace, remove]] };
  }
  const a = m.agent;
  return {
    title: m.handle,
    sub: [KIND[a.kind], a.name, m.role].filter(Boolean).join(" · "),
    sections: [
      [
        { action: "member-note", label: "Note" },
        { action: "member-terminal", label: "Terminal" },
        { action: "change-role", label: "Change role…", ...(m.role ? { hint: m.role } : {}) },
        replace,
        remove,
      ],
      ...agentSections(a, { note: false, killExtra: " It also leaves the chat." }),
    ],
  };
}
