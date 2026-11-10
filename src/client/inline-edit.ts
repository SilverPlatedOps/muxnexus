// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * The one way to edit a short value in place: a name, a role. The label turns
 * into a field; Enter or clicking away saves, Esc puts it back. Every rename in
 * the app goes through here, so they all behave alike.
 */

/** What to save: the trimmed text, or null when there is nothing to save. */
export function editResult(initial: string, typed: string, allowEmpty: boolean): string | null {
  const next = typed.trim();
  if (next === initial.trim()) return null;
  if (next === "" && !allowEmpty) return null;
  return next;
}

export interface InlineEditOpts {
  value: string;
  label: string;
  allowEmpty?: boolean;
  save(v: string): void;
  /** After saving or cancelling: put the label back (usually a re-render). */
  done?(): void;
}

export function inlineEdit(host: HTMLElement, o: InlineEditOpts): HTMLInputElement {
  const input = document.createElement("input");
  input.className = "rename inline-edit";
  input.value = o.value;
  input.setAttribute("aria-label", o.label);
  input.spellcheck = false;
  let finished = false;
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    const v = keep ? editResult(o.value, input.value, o.allowEmpty ?? false) : null;
    if (v !== null) o.save(v);
    o.done?.();
  };
  input.addEventListener("keydown", (e) => {
    // Typing here is not for the terminal, the sidebar's keys or the app's chords.
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  for (const ev of ["click", "mousedown", "dblclick", "pointerdown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  host.replaceChildren(input);
  input.focus();
  input.select();
  return input;
}
