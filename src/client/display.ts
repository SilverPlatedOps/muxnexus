/**
 * What the tabs and rows wear besides their name, and the one modal that
 * switches it: the profile badge and the shared-checkout mark. Remembered per
 * browser like the folded groups -- a viewer's convenience, not shared state.
 * On unless switched off, so a browser that has never chosen sees them; a
 * browser whose storage is blocked sees them too, and its choice lasts the page.
 */

const BADGES_KEY = "muxnexus.badges";
const MARKS_KEY = "muxnexus.checkout-marks";

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The display modal: one switch per mark, each saying what it is for, so a
 * mark that has become noise can go without hunting for where it lives.
 * `onChange` is told after every switch, to redraw whatever wears the marks.
 */
export function openDisplay(host: HTMLElement, onChange: () => void): void {
  const back = el("div", "modal-back");
  const box = el("div", "move display");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Display");
  const head = el("div", "move-head");
  head.append(el("span", "move-title", "Display"));
  box.append(head);

  const rows: [string, string, () => boolean, (on: boolean) => void][] = [
    ["Profile badges", "The account each tab's agent spends, as a letter on the tab", badgesShown, setBadgesShown],
    ["Shared checkout", "Two live agents working in one git checkout, marked on both", marksShown, setMarksShown],
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
