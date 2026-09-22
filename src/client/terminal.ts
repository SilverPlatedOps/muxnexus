import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

export function createTerminal(container: HTMLElement, h: TerminalHandlers): TerminalView {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.1,
    cursorBlink: true,
    macOptionIsMeta: true,
    scrollback: 1000,
    theme: THEME,
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
  // Search over the scrollback buffer: xterm gives us the lines, selection does
  // the highlighting. A match that wraps across two rows is not found.
  interface Match { row: number; col: number }
  let matches: Match[] = [];
  let at = -1;
  let query = "";

  const state = (): SearchState => ({ total: matches.length, index: at < 0 ? 0 : at + 1 });

  function show(i: number): SearchState {
    const m = matches[i];
    if (!m) {
      term.clearSelection();
      return state();
    }
    at = i;
    term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    term.select(m.col, m.row, query.length);
    return state();
  }

  function scan(next: string): SearchState {
    query = next;
    matches = [];
    at = -1;
    term.clearSelection();
    if (!next) return state();
    const buf = term.buffer.active;
    const needle = next.toLowerCase();
    for (let row = 0; row < buf.length; row++) {
      const text = buf.getLine(row)?.translateToString(true).toLowerCase();
      if (!text) continue;
      for (let col = text.indexOf(needle); col !== -1; col = text.indexOf(needle, col + needle.length)) {
        matches.push({ row, col });
      }
    }
    return matches.length ? show(matches.length - 1) : state(); // newest match first
  }

  function step(delta: number): SearchState {
    if (!matches.length) return state();
    return show((at + delta + matches.length) % matches.length);
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
    search: (q) => (q === query ? state() : scan(q)),
    findNext: () => step(1),
    findPrev: () => step(-1),
    clearSearch: () => { scan(""); },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}
