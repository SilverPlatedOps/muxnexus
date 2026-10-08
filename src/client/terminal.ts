import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}

export interface TerminalHandlers {
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  /** The wheel, over a program that did not ask for the mouse: rows of history to scroll, negative up. */
  onScroll(lines: number): void;
  /** An open search's matches changed as the screen redrew. */
  onSearch?(s: SearchState): void;
}

/**
 * A wheel event as whole rows, carrying the fraction over to the next one: a
 * trackpad sends many small deltas, and rounding each alone would lose them
 * all. `deltaMode` 1 is already rows; 2 is pages, a screenful of rows.
 */
export function wheelLines(
  rest: number,
  ev: { deltaY: number; deltaMode: number },
  rowPx: number,
  pageRows = 1,
): { lines: number; rest: number } {
  const rows = ev.deltaMode === 1 ? ev.deltaY : ev.deltaMode === 2 ? ev.deltaY * pageRows : ev.deltaY / rowPx;
  const total = rest + rows;
  const lines = Math.trunc(total);
  return { lines, rest: total - lines };
}

/** Where the viewer is in the current search: 1-based index of `total` matches. */
export interface SearchState {
  total: number;
  index: number;
}

export interface TerminalView {
  write(bytes: Uint8Array): void;
  reset(): void;
  fit(): void;
  focus(): void;
  /** Scan the scrollback for `query` and jump to the first match. */
  search(query: string): SearchState;
  findNext(): SearchState;
  findPrev(): SearchState;
  clearSearch(): void;
  readonly cols: number;
  readonly rows: number;
}

const THEME = {
  // One Dark
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  selectionBackground: "#3e4451",
  black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#d19a66",
  brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

/**
 * Search marks in amber, the colour terminals search in; decorations take
 * #RRGGBB only. The addon tracks the match you are on by selecting it, and the
 * selection paints over its mark, so while a search is open the selection
 * itself takes the active colour, in white, so a dimmed line still reads.
 */
const MATCH = "#5a4a26";
const ACTIVE = "#9a7a32";
const FIND: ISearchOptions = {
  decorations: {
    matchBackground: MATCH,
    matchOverviewRuler: MATCH,
    activeMatchBackground: ACTIVE,
    activeMatchColorOverviewRuler: ACTIVE,
  },
};
const FINDING = { ...THEME, selectionBackground: ACTIVE, selectionInactiveBackground: ACTIVE, selectionForeground: "#ffffff" };

export function createTerminal(container: HTMLElement, h: TerminalHandlers): TerminalView {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 1000,
    theme: THEME,
    allowProposedApi: true, // the search addon's match marks are decorations, still a proposed API
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(container);

  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    /* WebGL unavailable: xterm falls back to the DOM renderer. */
  }

  term.onData(h.onInput);

  // tmux keeps this terminal on its alternate screen, where xterm turns the
  // wheel into arrow keys unless the program in the pane asked for the mouse.
  // Claude Code asks; a shell or Codex does not, and reads the arrows as
  // "recall the last command". So for those the wheel scrolls tmux's history.
  let wheelRest = 0;
  term.attachCustomWheelEventHandler((ev) => {
    if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type !== "alternate") return true;
    ev.preventDefault();
    const rowPx = container.clientHeight / term.rows || 15;
    const { lines, rest } = wheelLines(wheelRest, ev, rowPx, term.rows);
    wheelRest = rest;
    if (lines !== 0) h.onScroll(lines);
    return false;
  });

  // Cmd+C copies when there is a selection. Cmd+B is left for the page (sidebar toggle).
  // Everything else, including Cmd+V (native paste event -> bracketed paste), passes through.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown" || !ev.metaKey) return true;
    if (ev.key === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (ev.key === "b" || ev.key === "f") return false;
    return true;
  });

  let reported = "";
  // Search the buffer with xterm's addon: it marks every match and finds them
  // again as tmux redraws the screen, where a mark placed once would sit on
  // whatever text moved under it. A new query lands on the newest match.
  const search = new SearchAddon();
  term.loadAddon(search);
  let query = "";
  let found: SearchState = { total: 0, index: 0 };
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    found = { total: resultCount, index: resultIndex + 1 }; // -1, past the highlight limit, becomes 0
    h.onSearch?.(found);
  });
  const step = (find: (q: string, o: ISearchOptions) => boolean): SearchState => {
    if (query) find(query, FIND);
    return found;
  };
  function scan(next: string): SearchState {
    query = next;
    found = { total: 0, index: 0 };
    search.clearDecorations();
    term.clearSelection();
    term.options.theme = next ? FINDING : THEME;
    return step((q, o) => search.findPrevious(q, o));
  }

  const fitAndReport = () => {
    fit.fit();
    const key = `${term.cols}x${term.rows}`;
    if (key === reported) return; // nothing changed: do not spam tmux with resizes
    reported = key;
    h.onResize(term.cols, term.rows);
  };
  new ResizeObserver(debounce(fitAndReport, 100)).observe(container);

  return {
    write: (bytes) => term.write(bytes),
    reset: () => term.reset(),
    fit: fitAndReport,
    focus: () => term.focus(),
    search: (q) => (q === query ? found : scan(q)),
    findNext: () => step((q, o) => search.findNext(q, o)),
    findPrev: () => step((q, o) => search.findPrevious(q, o)),
    clearSearch: () => { scan(""); },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}
