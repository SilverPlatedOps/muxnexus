// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ClientMessage, NewWindowAgent, SessionInfo, WindowInfo } from "../shared/protocol";
import { editableName, retag, splitCategory } from "../shared/category";
import { groupNames, isArchived, unarchivedName } from "./groups";
import { sessionLabel, tabLabel } from "./labels";
import { agentMenu, groupMenu, workspaceMenu, type AgentKind, type AgentTarget, type MenuAction } from "./menus";
import { openMenu, type Anchor } from "./popover";

/**
 * What a picked menu item does. The sidebar, the tab strip and the title bar
 * only say "this thing's menu, here"; this file builds the menu for the thing
 * and turns the pick into the sends and calls that already existed.
 */

export interface MenuHost {
  sessions(): SessionInfo[];
  current(): string | null;
  send(m: ClientMessage): void;
  attach(session: string): void;
  /** Show this tab in the beside pane (tabs of the workspace on screen only). */
  openBeside(windowId: string): void;
  openNote(session: string, windowId: string): void;
  startChat(windowId: string): void;
  changeAccount(session: string, windowId: string): void;
  renameWorkspace(session: string, seed?: { text: string; caret: number }): void;
  renameTab(windowId: string): void;
  renameGroup(category: string, commit: (name: string) => void): void;
  newInGroup(category: string): void;
  isFolded(category: string): boolean;
  toggleFold(category: string): void;
}

export function kindOf(w: WindowInfo): AgentKind {
  if (w.agent?.profile?.startsWith("codex")) return "codex";
  return w.agent || w.conversation ? "claude" : "shell";
}

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

export function createMenuActions(host: MenuHost) {
  const find = (session: string) => host.sessions().find((s) => s.name === session);

  function target(s: SessionInfo, w: WindowInfo, isWorkspace: boolean): AgentTarget {
    const current = host.current() === s.name && (isWorkspace || w.active);
    const kind = kindOf(w);
    const label = sessionLabel(s);
    const beside: true | string = host.current() === s.name && w.active ? "It's the tab on screen" : !host.current() ? "Open a workspace first" : true;
    return {
      name: isWorkspace ? editableName(label) : tabLabel(w),
      kind,
      ...(kind === "claude" && w.agent?.profile ? { account: w.agent.profile } : {}),
      ...(w.agent?.checkout ? { folder: tilde(w.agent.checkout) } : {}),
      isWorkspace,
      current,
      archived: isArchived(s, label),
      beside,
    };
  }

  function newTab(session: string, agent?: NewWindowAgent) {
    host.send({ t: "new-window", session, ...(agent ? { agent } : {}) });
  }

  function archive(s: SessionInfo, on: boolean) {
    host.send({ t: "archive-session", session: s.name, archived: on });
    // The old habit, a `[Archived]` tag, is undone by taking the tag off.
    const plain = on ? null : unarchivedName(sessionLabel(s));
    if (plain !== null) host.send({ t: "rename-session", session: s.name, name: plain });
  }

  function moveToGroup(s: SessionInfo, at: Anchor) {
    const label = sessionLabel(s);
    const here = splitCategory(label)?.category ?? null;
    const groups = groupNames(host.sessions().map(sessionLabel)).filter((g) => g !== here);
    const items = [
      ...groups.map((g) => ({ action: "move-group" as const, label: g })),
      ...(here ? [{ action: "move-group" as const, label: "No group" }] : []),
    ];
    // One action for every row: the picked item's label says which group.
    openMenu(at, {
      title: `Move ${editableName(label)} to`,
      sub: here ? `Now in ${here}` : "In no group",
      sections: [items, [{ action: "rename", label: "New group…" }]],
    }, (action, { item }) => {
      if (action === "rename") host.renameWorkspace(s.name, { text: `[] ${editableName(label)}`, caret: 1 });
      else host.send({ t: "rename-session", session: s.name, name: retag(label, item.label === "No group" ? null : item.label) });
    });
  }

  function agentPick(s: SessionInfo, w: WindowInfo, isWorkspace: boolean, at: Anchor) {
    return (action: MenuAction): void => {
      switch (action) {
        case "open":
          host.attach(s.name);
          if (!isWorkspace) host.send({ t: "select-window", session: s.name, id: w.id });
          return;
        case "open-beside": return host.openBeside(w.id);
        case "note": return host.openNote(s.name, w.id);
        case "new-tab-claude": return newTab(s.name, "claude");
        case "new-tab-codex": return newTab(s.name, "codex");
        case "new-tab-shell": return newTab(s.name);
        case "start-chat": return host.startChat(w.id);
        case "change-account": return host.changeAccount(s.name, w.id);
        case "rename": return isWorkspace ? host.renameWorkspace(s.name) : host.renameTab(w.id);
        case "move-group": return moveToGroup(s, at);
        case "archive": return archive(s, true);
        case "unarchive": return archive(s, false);
        case "kill":
          // The last tab going takes its workspace with it; say so to tmux directly.
          return host.send(isWorkspace ? { t: "kill-session", session: s.name } : { t: "kill-window", session: s.name, id: w.id });
        default: return;
      }
    };
  }

  return {
    /** A sidebar row or the title bar: the agent when there's one tab, else the workspace. */
    session(name: string, at: Anchor) {
      const s = find(name);
      if (!s || s.windows.length === 0) return;
      if (s.windows.length === 1) {
        const w = s.windows[0]!;
        openMenu(at, agentMenu(target(s, w, true)), agentPick(s, w, true, at));
        return;
      }
      const label = sessionLabel(s);
      openMenu(at, workspaceMenu({ name: editableName(label), tabs: s.windows.length, archived: isArchived(s, label) }), (action) => {
        switch (action) {
          case "new-tab-claude": return newTab(s.name, "claude");
          case "new-tab-codex": return newTab(s.name, "codex");
          case "new-tab-shell": return newTab(s.name);
          case "rename": return host.renameWorkspace(s.name);
          case "move-group": return moveToGroup(s, at);
          case "archive": return archive(s, true);
          case "unarchive": return archive(s, false);
          case "kill-workspace": return host.send({ t: "kill-session", session: s.name });
          default: return;
        }
      });
    },
    /** A chat member's tab, for the agent half of its menu: null when the tab is gone. */
    forWindow(windowId: string): { target: AgentTarget; pick: (action: MenuAction) => void } | null {
      const s = host.sessions().find((x) => x.windows.some((w) => w.id === windowId));
      const w = s?.windows.find((x) => x.id === windowId);
      if (!s || !w) return null;
      const one = s.windows.length === 1;
      // A follow-up menu (Move to group) opens near the top of the page: the member's own menu is gone by then.
      const pick = agentPick(s, w, one, { x: Math.round(innerWidth / 2) - 120, y: 96 });
      return { target: target(s, w, one), pick: (action) => pick(action) };
    },
    /** A tab of a workspace with several: always the agent. */
    tab(session: string, windowId: string, at: Anchor) {
      const s = find(session);
      const w = s?.windows.find((x) => x.id === windowId);
      if (!s || !w) return;
      const one = s.windows.length === 1;
      openMenu(at, agentMenu(target(s, w, one)), agentPick(s, w, one, at));
    },
    group(category: string, at: Anchor) {
      const folded = host.isFolded(category);
      openMenu(at, groupMenu({ name: category, folded }), (action) => {
        switch (action) {
          case "new-agent-in-group": return host.newInGroup(category);
          case "rename-group":
            return host.renameGroup(category, (next) => {
              for (const s of host.sessions()) {
                const label = sessionLabel(s);
                if (splitCategory(label)?.category.toLowerCase() === category.toLowerCase()) {
                  host.send({ t: "rename-session", session: s.name, name: retag(label, next) });
                }
              }
            });
          case "fold":
          case "unfold": return host.toggleFold(category);
          default: return;
        }
      });
    },
  };
}
