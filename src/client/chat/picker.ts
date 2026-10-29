// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { ChatMember } from "../../shared/chat";
import type { ChatJoin, ChatSpawn, SessionInfo } from "../../shared/protocol";
import { knownFolders, pickerGroups, stagedFolder, stagedProfile, type Near, type PickerAgent, type StagedAgent } from "./model";

/**
 * New chat, and Add an agent: pick agents from any workspace, or stage new
 * ones that start when you press the button. Opens on the search, since that
 * is what you do first; the name and roles fold away.
 */

export interface PickerOpts {
  mode: "create" | "add";
  sessions: SessionInfo[];
  profiles: string[];
  inChat: ReadonlySet<string>;
  /** Members already in the chat, so handles go on numbering from them. */
  existing: ChatMember[];
  preselect?: string;
  currentSession: string | null;
  /** Adding to a chat: where new agents start when no agent is picked. */
  near?: Near | null;
  /** New agents staged on opening: Retry's. */
  stage?: StagedAgent[];
  submit(r: { name?: string; members: ChatJoin[]; spawn: ChatSpawn[] }): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(cls: string, text: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

/** A home folder as ~, the way a terminal shows it. */
const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

interface Staged extends StagedAgent {
  /** The folder was typed: a change of workspace leaves it alone. */
  typed?: boolean;
  /** The profile was chosen: a change of workspace leaves it alone. */
  chosen?: boolean;
}

export function openPicker(o: PickerOpts) {
  const groups = pickerGroups(o.sessions, o.inChat);
  const picked = new Map<string, { agent: PickerAgent; role: string }>();
  const staged: Staged[] = (o.stage ?? []).map((s) => {
    const profile = s.profile ?? (s.kind === "claude" ? stagedProfile(s.session, o.profiles, o.near ?? undefined) : undefined);
    return { ...s, folder: tilde(s.folder), ...(profile ? { profile } : {}), chosen: s.profile !== undefined };
  });
  let query = "";
  let folded = true;
  let name = "";

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const back = el("dialog", "chat-modal-back chat-picker-dialog");
  const modal = el("div", "chat-modal");
  back.setAttribute("aria-label", o.mode === "create" ? "New chat" : "Add agents");
  back.append(modal);
  const close = () => { previewAbort.abort(); back.close(); back.remove(); previous?.focus({ preventScroll: true }); };
  back.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  back.onclick = (e) => { if (e.target === back) close(); };
  modal.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });

  for (const g of groups) for (const a of g.agents) if (a.windowId === o.preselect) picked.set(a.windowId, { agent: a, role: "" });

  const firstPicked = () => [...picked.values()][0]?.agent;
  /** What a new agent starts beside: the first agent picked, else the chat's. */
  const beside = () => firstPicked() ?? o.near ?? undefined;

  /** The handle a new member of `kind` would get, given what's picked before it. */
  function handleFor(kind: string, index: number): string {
    const before = o.existing.filter((m) => m.kind === kind).length;
    return `@${kind}${before + index + 1}`;
  }

  let previewAbort = new AbortController();
  function paint() {
    previewAbort.abort();
    previewAbort = new AbortController();
    const headEl = el("header", "chat-modal-head", o.mode === "create" ? "New chat" : "Add agents");
    const x = btn("icon-btn", "✕");
    x.setAttribute("aria-label", "Close agent picker");
    x.onclick = close;
    headEl.append(el("span", "sp"), x);

    const search = el("input", "chat-modal-search");
    search.placeholder = "Find agents";
    search.value = query;
    search.setAttribute("aria-label", "Find agents");
    search.oninput = () => { query = search.value; paintList(); };

    const list = el("div", "chat-modal-list");
    const paintList = () => {
      const q = query.trim().toLowerCase();
      const nodes: HTMLElement[] = [];
      const order = new Map<string, number>();
      for (const kind of ["claude", "codex"]) [...picked.values()].filter((p) => p.agent.kind === kind).forEach((p, i) => order.set(p.agent.windowId, i));
      for (const g of groups) {
        const agents = g.agents.filter((a) => !q || `${g.session} ${a.name} ${a.kind} ${a.folder ?? ""}`.toLowerCase().includes(q));
        if (!agents.length) continue;
        nodes.push(el("div", "grp", g.session));
        for (const a of agents) {
          const on = picked.has(a.windowId);
          const r = btn(`chat-agent${on ? " on" : ""}`, "");
          const ck = el("span", "ck", on ? "✓" : "");
          const title = el("span", "t", a.name);
          if (on) title.append(el("span", "hd", handleFor(a.kind, order.get(a.windowId) ?? 0)));
          const sub = el("span", "s");
          if (a.profile) sub.append(el("span", `pbadge`, a.profile[0]!.toUpperCase()), " ");
          const where = el("span", "where", a.waiting ? "Codex · joins once it has started a conversation" : `${a.kind === "codex" ? "Codex" : "Claude"} · ${tilde(a.folder ?? "")}`);
          where.title = a.folder ?? "";
          sub.append(where);
          r.append(ck, title, sub);
          r.onclick = () => {
            if (on) picked.delete(a.windowId);
            else picked.set(a.windowId, { agent: a, role: "" });
            paint();
          };
          nodes.push(r);
        }
      }
      for (const [i, s] of staged.entries()) {
        const r = el("div", "chat-agent staged on");
        const kindIdx = staged.slice(0, i).filter((x) => x.kind === s.kind).length + [...picked.values()].filter((p) => p.agent.kind === s.kind).length;
        r.append(el("span", "ck", "+"), el("span", "t", `new ${s.kind === "codex" ? "Codex" : "Claude"}`));
        r.lastElementChild!.append(el("span", "hd", handleFor(s.kind, kindIdx)));
        const sub = el("span", "s");
        const ws = el("select", "chat-staged-ws");
        ws.setAttribute("aria-label", "Workspace it opens in");
        for (const x of o.sessions) {
          const opt = el("option", "", x.customName ?? x.label ?? x.name);
          opt.value = x.name;
          if (x.name === s.session) opt.selected = true;
          ws.append(opt);
        }
        const folder = el("input", "chat-staged-folder");
        folder.value = s.folder;
        folder.placeholder = "the workspace's folder";
        folder.setAttribute("list", "chat-folders");
        folder.setAttribute("aria-label", "Folder it starts in");
        folder.oninput = () => { s.folder = folder.value; s.typed = true; };
        sub.append(`opens on ${o.mode === "create" ? "Create" : "Add"} in `, ws, " ", folder);
        let prof: HTMLSelectElement | null = null;
        if (s.kind === "claude" && o.profiles.length > 1) {
          prof = el("select", "chat-staged-profile");
          prof.setAttribute("aria-label", "Claude account");
          for (const p of o.profiles) {
            const opt = el("option", "", p);
            opt.value = p;
            if (p === s.profile) opt.selected = true;
            prof.append(opt);
          }
          prof.onchange = () => { s.profile = prof!.value; s.chosen = true; };
          sub.append(" ", prof);
        }
        ws.onchange = () => {
          s.session = ws.value;
          if (!s.typed) folder.value = s.folder = tilde(stagedFolder(s.session, beside()));
          if (s.kind === "claude" && !s.chosen) {
            const p = stagedProfile(s.session, o.profiles, beside());
            if (p) s.profile = p;
            else delete s.profile;
            if (prof && s.profile) prof.value = s.profile;
          }
        };
        const rm = btn("chat-chip-x", "✕");
        rm.onclick = () => { staged.splice(i, 1); paint(); };
        sub.append(" ", rm);
        r.append(sub);
        nodes.push(r);
      }
      if (!nodes.length) nodes.push(el("div", "chats-empty", groups.length ? "No agent matches." : "No agent tabs are running."));
      list.replaceChildren(...nodes);
    };
    paintList();

    const spawn = el("div", "chat-modal-spawn");
    const first = beside();
    const add = (kind: "claude" | "codex") => {
      const session = first?.session ?? o.currentSession ?? o.sessions[0]?.name ?? "";
      const profile = kind === "claude" ? stagedProfile(session, o.profiles, first) : undefined;
      staged.push({ kind, folder: tilde(stagedFolder(session, first)), session, ...(profile ? { profile } : {}), role: "" });
      paint();
    };
    const ac = btn("chat-btn", "+ Claude");
    ac.onclick = () => add("claude");
    const ax = btn("chat-btn", "+ Codex");
    ax.onclick = () => add("codex");
    spawn.append("New agent:", ac, ax);

    const fold = btn("chat-modal-fold", `${folded ? "▸" : "▾"} Name and roles (optional)`);
    fold.onclick = () => { folded = !folded; paint(); };
    const extra = el("div", "chat-modal-extra");
    extra.hidden = folded;
    if (o.mode === "create") {
      const n = el("input", "chat-modal-name");
      n.placeholder = "Name: taken from the members if empty";
      n.setAttribute("aria-label", "Chat name");
      n.value = name;
      n.oninput = () => { name = n.value; };
      extra.append(n);
    }
    for (const p of picked.values()) {
      const r = el("label", "chat-role-row", `${p.agent.name} `);
      const i = el("input", "chat-role");
      i.placeholder = "role, e.g. driver";
      i.value = p.role;
      i.oninput = () => { p.role = i.value; };
      r.append(i);
      extra.append(r);
    }
    for (const s of staged) {
      const r = el("label", "chat-role-row", `new ${s.kind} `);
      const i = el("input", "chat-role");
      i.placeholder = "role";
      i.value = s.role;
      i.oninput = () => { s.role = i.value; };
      r.append(i);
      extra.append(r);
    }

    const foot = el("footer", "chat-modal-foot");
    const go = btn("chat-btn pri", o.mode === "create" ? "Create" : "Add");
    go.disabled = picked.size + staged.length === 0;
    go.onclick = () => {
      o.submit({
        ...(name.trim() ? { name: name.trim() } : {}),
        members: [...picked.values()].map((p) => ({ windowId: p.agent.windowId, ...(p.role.trim() ? { role: p.role.trim() } : {}) })),
        spawn: staged.filter((s) => s.session).map((s) => ({ kind: s.kind, folder: s.folder.trim(), session: s.session, ...(s.profile ? { profile: s.profile } : {}), ...(s.role.trim() ? { role: s.role.trim() } : {}) })),
      });
      close();
    };
    foot.append(el("span", "note", "Selected agents join; staged agents launch when you submit."), el("span", "sp"), go);

    const preflight = el("details", "chat-preflight");
    preflight.open = true;
    preflight.append(el("summary", "", `Ready to ${o.mode === "create" ? "create" : "add"} · ${picked.size + staged.length} agent${picked.size + staged.length === 1 ? "" : "s"}`));
    const preview = el("dl");
    for (const p of picked.values()) {
      const value = () => [p.agent.kind === "codex" ? "Codex" : "Claude", `account: ${p.agent.profile ?? "current"}`, p.agent.session, p.agent.folder ?? "folder not reported", p.role.trim() ? `role: ${p.role.trim()}` : ""].filter(Boolean).join(" · ");
      const detail = el("dd", "", value());
      preview.append(el("dt", "", p.agent.name), detail);
      modal.addEventListener("input", () => { detail.textContent = value(); }, { signal: previewAbort.signal });
    }
    for (const s of staged) {
      const value = () => [s.kind === "codex" ? "Codex" : "Claude", `account: ${s.profile ?? "current"}`, s.session, s.folder.trim() || "workspace folder", s.role.trim() ? `role: ${s.role.trim()}` : ""].filter(Boolean).join(" · ");
      const detail = el("dd", "", value());
      preview.append(el("dt", "", `New ${s.kind}`), detail);
      // Inputs update the same staging object; keep the preflight exact as they change.
      modal.addEventListener("input", () => { detail.textContent = value(); }, { signal: previewAbort.signal });
      modal.addEventListener("change", () => { detail.textContent = value(); }, { signal: previewAbort.signal });
    }
    preflight.append(preview);

    const folders = el("datalist");
    folders.id = "chat-folders";
    for (const f of knownFolders(o.sessions)) {
      const opt = el("option");
      opt.value = tilde(f);
      folders.append(opt);
    }
    modal.replaceChildren(headEl, search, list, spawn, fold, extra, preflight, foot, folders);
    if (document.activeElement === document.body || !modal.contains(document.activeElement)) search.focus();
  }

  // On the page first, so the search can take focus.
  document.body.append(back);
  back.showModal();
  paint();
}
