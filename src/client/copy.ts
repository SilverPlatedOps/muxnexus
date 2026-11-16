/**
 * Copies `text`: the clipboard API where the page may use it, else a hidden
 * text box and the browser's own copy command. A page over plain http from
 * another machine (warrior at http://warrior-server:7681) is not a secure
 * context, so it has no `navigator.clipboard` at all. Call it straight from a
 * click: the copy command needs the click's user activation, and the fallback
 * runs before anything is awaited. Focus goes back where it was, so an editor's
 * caret stays put.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: try the text box.
  }
  const before = document.activeElement as HTMLElement | null;
  const box = document.createElement("textarea");
  box.value = text;
  box.readOnly = true;
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.append(box);
  box.select();
  box.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  box.remove();
  before?.focus?.({ preventScroll: true });
  return ok;
}
