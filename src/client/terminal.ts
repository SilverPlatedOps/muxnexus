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

export interface TerminalView {
  write(bytes: Uint8Array): void;
  reset(): void;
  fit(): void;
  focus(): void;
  readonly cols: number;
  readonly rows: number;
}

const THEME = {
  background: "#0b0e14",
  foreground: "#d5d9e0",
  cursor: "#d5d9e0",
  selectionBackground: "#2d3b55",
  black: "#0b0e14", red: "#f07178", green: "#c3e88d", yellow: "#ffcb6b",
  blue: "#82aaff", magenta: "#c792ea", cyan: "#89ddff", white: "#d5d9e0",
  brightBlack: "#4b5263", brightRed: "#ff8b92", brightGreen: "#ddffa7", brightYellow: "#ffe585",
  brightBlue: "#9cc4ff", brightMagenta: "#e1acff", brightCyan: "#a3f7ff", brightWhite: "#ffffff",
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
    if (ev.key === "b") return false;
    return true;
  });

  const fitAndReport = () => {
    fit.fit();
    h.onResize(term.cols, term.rows);
  };
  new ResizeObserver(debounce(fitAndReport, 100)).observe(container);

  return {
    write: (bytes) => term.write(bytes),
    reset: () => term.reset(),
    fit: fitAndReport,
    focus: () => term.focus(),
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}
