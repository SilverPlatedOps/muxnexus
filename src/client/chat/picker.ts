import type { ChatMember } from "../../shared/chat";
import type { ChatJoin, ChatSpawn, SessionInfo } from "../../shared/protocol";
import { knownFolders, pickerGroups, stagedFolder, type PickerAgent } from "./model";

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

interface Staged {
  kind: "claude" | "codex";
  /** Empty for the workspace's own folder. */
  folder: string;
  session: string;
  profile?: string;
  role: string;
  /** The folder was typed: a change of workspace leaves it alone. */
  typed?: boolean;
}

export function openPicker(o: PickerOpts) {
  const groups = pickerGroups(o.sessions, o.inChat);
  const picked = new Map<string, { agent: PickerAgent; role: string }>();
  const staged: Staged[] = [];
  let query = "";
  let folded = true;
  let name = "";

  const back = el("div", "chat-modal-back");
  const modal = el("div", "chat-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", o.mode === "create" ? "New chat" : "Add agents");
  back.append(modal);
  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };
  modal.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") close(); });

  for (const g of groups) for (const a of g.agents) if (a.windowId === o.preselect) picked.set(a.windowId, { agent: a, role: "" });

  const firstPicked = () => [...picked.values()][0]?.agent;

  /** The handle a new member of `kind` would get, given what's picked before it. */
  function handleFor(kind: string, index: number): string {
    const before = o.existing.filter((m) => m.kind === kind).length;
    return `@${kind}${before + index + 1}`;
  }

  function paint() {
    const headEl = el("header", "chat-modal-head", o.mode === "create" ? "New chat" : "Add agents");
    const x = btn("icon-btn", "✕");
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
        ws.onchange = () => {
          s.session = ws.value;
          if (!s.typed) folder.value = s.folder = tilde(stagedFolder(o.sessions, s.session, firstPicked()));
        };
        sub.append("opens on Create in ", ws, " ", folder);
        if (s.kind === "claude" && o.profiles.length > 1) {
          const prof = el("select", "chat-staged-profile");
          for (const p of o.profiles) {
            const opt = el("option", "", p);
            opt.value = p;
            if (p === s.profile) opt.selected = true;
            prof.append(opt);
          }
          prof.onchange = () => { s.profile = prof.value; };
          sub.append(" ", prof);
        }
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
    const first = firstPicked();
    const add = (kind: "claude" | "codex") => {
      const session = first?.session ?? o.currentSession ?? o.sessions[0]?.name ?? "";
      staged.push({
        kind,
        folder: tilde(stagedFolder(o.sessions, session, first)),
        session,
        ...(kind === "claude" && first?.profile && first.profile !== "codex" ? { profile: first.profile } : {}),
        role: "",
      });
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
    foot.append(el("span", "note", "Members can read the whole chat."), el("span", "sp"), go);

    const folders = el("datalist");
    folders.id = "chat-folders";
    for (const f of knownFolders(o.sessions)) {
      const opt = el("option");
      opt.value = tilde(f);
      folders.append(opt);
    }
    modal.replaceChildren(headEl, search, list, spawn, fold, extra, foot, folders);
    if (document.activeElement === document.body || !modal.contains(document.activeElement)) search.focus();
  }

  paint();
  document.body.append(back);
}
