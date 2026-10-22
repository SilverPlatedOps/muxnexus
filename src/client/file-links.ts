import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/** A plain file reference, including the path Codex shows after a Markdown label. */
export function fileTarget(reference: string, windowId?: string | null): string | null {
  const path = reference.replace(/(?:#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/, "");
  if (!path || /[\x00-\x1f\x7f:?#]/.test(path) || path.startsWith("//")) return null;
  // Require a filename with an extension; prose and directory names stay selectable text.
  if (!/(?:^|\/)[^/]+\.[a-zA-Z0-9]{1,12}$/.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/") && !windowId) return null;
  const query = new URLSearchParams({ path });
  if (windowId) query.set("window", windowId);
  return `/file?${query}`;
}

/** Finds references in existing buffer cells, so attaching to an old session works too. */
export class FileLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Pick<Terminal, "buffer">,
    private readonly windowId: () => string | null | undefined,
    private readonly open: (target: string) => void,
  ) {}

  provideLinks(y: number, callback: (links: ILink[]) => void): void {
    const buffer = this.terminal.buffer.active;
    let first = y - 1;
    let last = first;
    // xterm coordinates are cells, while RegExp indices are UTF-16 offsets.
    // Keep a mapping so emoji, wide glyphs and wrapped paths click in the right place.
    while (first > 0 && y - first < 32 && buffer.getLine(first)?.isWrapped) first--;
    while (last - first < 32 && buffer.getLine(last + 1)?.isWrapped) last++;
    let text = "";
    const cells: { x: number; y: number; end: number }[] = [];
    const cell = buffer.getNullCell();
    for (let row = first; row <= last; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const content = line.translateToString(true);
      let offset = 0;
      for (let x = 0; x < line.length && offset < content.length; x++) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1, end: x + cell.getWidth() });
        offset += chars.length;
      }
      text += content;
    }
    const links: ILink[] = [];
    // Delimited references may contain spaces; bare paths stop at punctuation.
    const tokens = /\(([^()\r\n]+)\)|"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s<>()[\]{}"'`,;!?]+)/g;
    for (const match of text.matchAll(tokens)) {
      const delimited = match[1] ?? match[2] ?? match[3] ?? match[4];
      const reference = (delimited ?? match[5]!).replace(/[.,;!?]+$/, "");
      const target = fileTarget(reference, this.windowId());
      if (!target) continue;
      const from = match.index + (delimited === undefined ? 0 : 1);
      const start = cells[from];
      const end = cells[from + reference.length - 1];
      if (!start || !end || start.y > y || end.y < y) continue;
      links.push({
        text: reference,
        range: { start: { x: start.x, y: start.y }, end: { x: end.end, y: end.y } },
        activate: () => this.open(target),
      });
    }
    callback(links);
  }
}
