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
