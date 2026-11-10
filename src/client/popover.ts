// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type { Menu, MenuAction, MenuItem } from "./menus";

/**
 * The one floating menu: whatever menus.ts built, at a button or at the
 * pointer for a right-click. It hangs off <body>, so the sidebar and tab strip
 * redrawing on every state push leave it alone. Anything that can't be undone
 * asks first, in place: the item turns into its question and a red button.
 */

export type Anchor = HTMLElement | { x: number; y: number };

interface Box { x: number; y: number; w: number; h: number }
const MARGIN = 8;

/** Below the anchor's left edge; above it when there's no room below; always on screen. */
export function placeMenu(anchor: Box, size: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number } {
  let x = anchor.x;
  if (x + size.w > view.w - MARGIN) x = view.w - MARGIN - size.w;
  let y = anchor.y + anchor.h;
  if (y + size.h > view.h - MARGIN) y = anchor.y - size.h;
  return { x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let closeOpen: (() => void) | null = null;

/** Close whatever menu is open (another opening, a view change). */
export function closeMenus(): void {
  closeOpen?.();
}

export function openMenu(at: Anchor, menu: Menu, pick: (action: MenuAction, opts?: { option: boolean }) => void): () => void {
  closeOpen?.();
  const opener = at instanceof HTMLElement ? at : (document.activeElement as HTMLElement | null);
  const box = el("div", "pop-menu");
  box.setAttribute("role", "menu");
  box.setAttribute("aria-label", menu.title);

  const head = el("div", "pop-head");
  head.append(el("div", "pop-title", menu.title));
  if (menu.sub) head.append(el("div", "pop-sub", menu.sub));
  box.append(head);

  const items = (): HTMLButtonElement[] => [...box.querySelectorAll<HTMLButtonElement>("button.pop-item:not([aria-disabled='true'])")];

  function confirmIn(row: HTMLButtonElement, item: MenuItem) {
    const c = el("div", "pop-confirm");
    c.append(el("div", "pop-confirm-text", item.confirm));
    let option: HTMLInputElement | null = null;
    if (item.option) {
      const label = el("label", "pop-confirm-option");
      option = el("input");
      option.type = "checkbox";
      label.append(option, item.option);
      c.append(label);
    }
    const yes = el("button", "pop-btn danger", item.confirmLabel ?? item.label.replace(/…$/, ""));
    yes.type = "button";
    const no = el("button", "pop-btn", "Cancel");
    no.type = "button";
    const buttons = el("div", "pop-confirm-buttons");
    buttons.append(yes, no);
    c.append(buttons);
    yes.onclick = () => { const o = option?.checked ?? false; close(); pick(item.action, { option: o }); };
    no.onclick = () => { c.replaceWith(row); row.focus(); };
    row.replaceWith(c);
    no.focus();
  }

  function button(item: MenuItem, depth: number): HTMLButtonElement {
    const b = el("button", `pop-item${item.danger ? " danger" : ""}${depth ? " child" : ""}`);
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.append(el("span", "pop-label", item.label));
    if (item.children) b.append(el("span", "pop-hint", "›"));
    else if (item.hint) b.append(el("span", "pop-hint", item.hint));
    if (item.disabled) {
      b.setAttribute("aria-disabled", "true");
      b.title = item.disabled;
    }
    b.onclick = (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.children) { toggleChildren(b, item); return; }
      if (item.confirm) { confirmIn(b, item); return; }
      close();
      pick(item.action);
    };
    return b;
  }

  /** A submenu opens in place, indented under its item: no flyout to chase with the pointer. */
  function toggleChildren(b: HTMLButtonElement, item: MenuItem, open?: boolean) {
    const shown = b.nextElementSibling?.classList.contains("pop-children") ?? false;
    const want = open ?? !shown;
    if (shown && !want) { b.nextElementSibling!.remove(); b.setAttribute("aria-expanded", "false"); return; }
    if (!shown && want) {
      const kids = el("div", "pop-children");
      for (const c of item.children!) kids.append(button(c, 1));
      b.after(kids);
      b.setAttribute("aria-expanded", "true");
      (kids.querySelector("button") as HTMLButtonElement | null)?.focus();
    }
  }

  menu.sections.forEach((section, i) => {
    if (i > 0) box.append(el("div", "pop-sep"));
    for (const item of section) box.append(button(item, 0));
  });

  document.body.append(box);
  const r = at instanceof HTMLElement ? at.getBoundingClientRect() : { x: at.x, y: at.y, width: 0, height: 0 };
  const p = placeMenu({ x: r.x, y: r.y, w: r.width, h: r.height }, { w: box.offsetWidth, h: box.offsetHeight }, { w: innerWidth, h: innerHeight });
  box.style.left = `${p.x}px`;
  box.style.top = `${p.y}px`;
  // The button it hangs from looks pressed; a right-click has no button.
  if (at instanceof HTMLElement) at.classList.add("menu-open");

  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); close(); opener?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const cur = list[at];
      if (!cur) return;
      const parent = cur.classList.contains("child") ? (cur.parentElement!.previousElementSibling as HTMLButtonElement) : cur;
      if (parent.getAttribute("aria-expanded") === null) return;
      e.preventDefault();
      if (e.key === "ArrowRight") parent.click();
      else if (parent.getAttribute("aria-expanded") === "true") { parent.click(); parent.focus(); }
    } else return;
    e.stopPropagation();
  };
  const onDown = (e: PointerEvent) => { if (!box.contains(e.target as Node)) close(); };
  const onGone = () => close();
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  addEventListener("blur", onGone);
  addEventListener("resize", onGone);

  function close() {
    if (closeOpen !== close) return;
    closeOpen = null;
    box.remove();
    if (at instanceof HTMLElement) at.classList.remove("menu-open");
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onDown, true);
    removeEventListener("blur", onGone);
    removeEventListener("resize", onGone);
  }
  closeOpen = close;
  items()[0]?.focus();
  return close;
}

/** Right-click on `target` opens `open(pointer)` instead of the browser's menu. */
export function onContextMenu(target: HTMLElement, open: (at: { x: number; y: number }) => void): void {
  target.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    open({ x: e.clientX, y: e.clientY });
  });
}
