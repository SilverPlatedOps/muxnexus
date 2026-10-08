/**
 * Markdown styled as it is typed, the way Obsidian's live preview reads: a
 * heading is large, bold is bold, code sits on its own ground, a table is a
 * grid, and the marks that make them (`##`, `**`, backticks, a link's address,
 * a code block's fences) fold away until the caret is in the element they
 * belong to. The text itself is never rewritten: a table is edited as the
 * text it is, the grid stepping aside while the caret is in it.
 */
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { type EditorState, Prec, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** Any device can write a note, and there is no login: a link may open the web or mail, nothing else. */
export const SAFE_LINK = /^(https?:|mailto:)/i;

/** Whether the editor has the keys, kept in its state so a state field can read it. */
export const setFocus = StateEffect.define<boolean>();
export const focusState = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) v = e.value;
    return v;
  },
});
const trackFocus = EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing));

type Span = { from: number; to: number };
/** Where the caret is, while the editor has the keys: nowhere without them, so everything folds. */
const editing = (state: EditorState): readonly Span[] => (state.field(focusState, false) ? state.selection.ranges : []);
const touches = (sel: readonly Span[], from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-md-bullet";
    s.textContent = "•";
    return s;
  }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(other: TaskWidget) { return other.checked === this.checked; }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-md-task";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Done" : "To do");
    return box;
  }
  /** Clicks reach the editor, which flips the box in the text. */
  ignoreEvent() { return false; }
}

class CopyWidget extends WidgetType {
  constructor(readonly code: string) { super(); }
  eq(other: CopyWidget) { return other.code === this.code; }
  toDOM() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-md-copy";
    b.textContent = "Copy";
    b.setAttribute("aria-label", "Copy code");
    b.addEventListener("mousedown", (e) => e.preventDefault()); // the caret stays put
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(this.code).then(
        () => { b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); },
        () => { b.textContent = "Failed"; },
      );
    });
    return b;
  }
  ignoreEvent() { return true; }
}

/** Code, bold, italic and a link's text inside a table cell, the rest as typed. */
function inlineSpans(text: string): DocumentFragment {
  const f = document.createDocumentFragment();
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\([^)]*\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) f.append(text.slice(at, m.index));
    const s = document.createElement("span");
    s.className = m[1] !== undefined ? "cm-md-code" : m[2] !== undefined ? "cm-md-strong" : m[3] !== undefined ? "cm-md-em" : "cm-md-link";
    s.textContent = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    f.append(s);
    at = m.index + m[0].length;
  }
  f.append(text.slice(at));
  return f;
}

interface Cell { text: string; from: number }
type Align = "left" | "center" | "right" | "";

/** A table drawn as a grid. A click puts the caret in the cell's text, and the grid gives way to it. */
class TableWidget extends WidgetType {
  constructor(readonly rows: Cell[][], readonly align: Align[], readonly from: number) { super(); }
  eq(other: TableWidget) {
    return other.from === this.from && JSON.stringify(other.rows) === JSON.stringify(this.rows) && other.align.join() === this.align.join();
  }
  get estimatedHeight() { return this.rows.length * 27; }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";
    const width = Math.max(...this.rows.map((r) => r.length));
    this.rows.forEach((row, i) => {
      const tr = document.createElement("tr");
      for (let c = 0; c < width; c++) {
        const td = document.createElement(i === 0 ? "th" : "td");
        const cell = row[c];
        if (cell) {
          td.dataset.from = String(cell.from);
          td.append(inlineSpans(cell.text));
        }
        if (this.align[c]) td.style.textAlign = this.align[c];
        tr.append(td);
      }
      (i === 0 ? (table.createTHead()) : (table.tBodies[0] ?? table.createTBody())).append(tr);
    });
    wrap.append(table);
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const cell = (e.target as Element).closest<HTMLElement>("[data-from]");
      view.focus();
      view.dispatch({ selection: { anchor: cell ? Number(cell.dataset.from) : this.from } });
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

function tableWidget(state: EditorState, table: SyntaxNode): TableWidget {
  const doc = state.doc;
  const rows: Cell[][] = [];
  let align: Align[] = [];
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableHeader" || c.name === "TableRow") {
      rows.push(c.getChildren("TableCell").map((cell) => ({ text: doc.sliceString(cell.from, cell.to).trim(), from: cell.from })));
    } else if (c.name === "TableDelimiter") {
      align = doc.sliceString(c.from, c.to).split("|").map((s) => s.trim()).filter(Boolean).map((s) =>
        s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : s.startsWith(":") ? "left" : "");
    }
  }
  return new TableWidget(rows, align, table.from);
}

/** Every table the caret is not in, as a grid in place of its lines. */
export function tableDecorations(state: EditorState): DecorationSet {
  const sel = editing(state);
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (n.name !== "Table") return;
      if (!touches(sel, n.from, n.to)) {
        const widget = tableWidget(state, n.node);
        out.push(Decoration.replace({ widget, block: true }).range(state.doc.lineAt(n.from).from, state.doc.lineAt(n.to).to));
      }
      return false;
    },
  });
  return Decoration.set(out);
}

const tables = StateField.define<DecorationSet>({
  create: tableDecorations,
  update(deco, tr) {
    const changed = tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setFocus)) || syntaxTree(tr.startState) !== syntaxTree(tr.state);
    return changed ? tableDecorations(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const line = (cls: string) => Decoration.line({ class: cls });
const fence = mark("cm-md-fence");
const lang = mark("cm-md-codelang");
const code = mark("cm-md-code");
const STYLE: Record<string, Decoration> = {
  StrongEmphasis: mark("cm-md-strong"),
  Emphasis: mark("cm-md-em"),
  Strikethrough: mark("cm-md-strike"),
  Link: mark("cm-md-link", { title: "⌘-click to open" }),
};
/** Marks that fold away until the caret is in the element they belong to. */
const FOLD = new Set(["EmphasisMark", "StrikethroughMark", "LinkMark", "URL", "CodeMark"]);
/** Marks that open a line, folded with the space after them until the caret is on it. */
const FOLD_SPACED = new Set(["HeaderMark", "QuoteMark"]);

/** The decorations for `state` across `ranges`, given where the caret is. */
export function previewDecorations(
  state: EditorState,
  ranges: readonly Span[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const sel = editing(state);
  const onLine = (pos: number) => { const l = doc.lineAt(pos); return touches(sel, l.from, l.to); };
  const eachLine = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) out.push(line(cls).range(doc.line(n).from));
  };
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(line(`cm-md-h cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from));
        } else if (name === "Blockquote") {
          eachLine(node.from, node.to, "cm-md-quote");
        } else if (name === "Table") {
          return touches(sel, node.from, node.to); // otherwise a grid (tableDecorations)
        } else if (name === "FencedCode") {
          codeBlock(node.node);
          return false;
        } else if (name === "InlineCode") {
          // The chip holds the code alone: the backticks, when they show, sit dimmed outside it.
          const ticks = node.node.getChildren("CodeMark");
          const from = ticks[0]?.to ?? node.from;
          const to = ticks.length > 1 ? ticks[ticks.length - 1]!.from : node.to;
          if (to > from) out.push(code.range(from, to));
          if (touches(sel, node.from, node.to)) for (const t of ticks) out.push(fence.range(t.from, t.to));
        } else if (STYLE[name]) {
          if (node.to > node.from) out.push(STYLE[name].range(node.from, node.to));
        } else if (name === "URL" && node.node.parent?.name !== "Link") {
          if (node.node.parent?.name !== "Image") out.push(STYLE.Link.range(node.from, node.to)); // a bare address
          return;
        } else if (name === "ListMark") {
          const list = node.node.parent?.parent?.name;
          const task = node.node.nextSibling?.name === "Task";
          const shown = onLine(node.from);
          if (list === "BulletList" && !task && !shown) out.push(bullet.range(node.from, node.to));
          if (list === "BulletList" && task && !shown) out.push(hide.range(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to)));
        } else if (name === "TaskMarker") {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          out.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(node.from, node.to));
          if (checked) {
            const start = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            const end = node.node.parent!.to;
            if (end > start) out.push(mark("cm-md-done").range(start, end));
          }
        }
        if (FOLD.has(name)) {
          const owner = node.node.parent;
          // An image is left as typed: there is no picture to show in its place.
          if (owner && owner.name !== "Image" && !touches(sel, owner.from, owner.to)) out.push(hide.range(node.from, node.to));
        } else if (FOLD_SPACED.has(name) && !onLine(node.from)) {
          const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          out.push(hide.range(node.from, end));
        }
      },
    });
  }

  /**
   * A fenced block on its own ground. With the caret elsewhere its fences fold
   * away, the opening one leaving the language as a label, the closing one a
   * thin bottom edge. A copy button sits on its first line either way.
   */
  function codeBlock(block: SyntaxNode) {
    const first = doc.lineAt(block.from);
    const last = doc.lineAt(block.to);
    const marks = block.getChildren("CodeMark");
    const info = block.getChild("CodeInfo");
    const closed = marks.length > 1 && last.number > first.number;
    const inside = touches(sel, block.from, block.to);
    for (let n = first.number; n <= last.number; n++) {
      let cls = "cm-md-codeblock";
      if (n === first.number) cls += " cm-md-codeblock-first";
      if (n === last.number) cls += " cm-md-codeblock-last";
      if (n === last.number && closed && !inside) cls += " cm-md-codeblock-close";
      out.push(line(cls).range(doc.line(n).from));
    }
    const text = block.getChild("CodeText");
    out.push(Decoration.widget({ widget: new CopyWidget(text ? doc.sliceString(text.from, text.to) : ""), side: 1 }).range(first.to));
    if (inside) {
      for (const c of info ? [...marks, info] : marks) out.push(fence.range(c.from, c.to));
      return;
    }
    out.push(hide.range(marks[0]!.from, marks[0]!.to));
    if (info) out.push(lang.range(info.from, info.to));
    if (closed) out.push(hide.range(marks[marks.length - 1]!.from, marks[marks.length - 1]!.to));
  }

  return Decoration.set(out, true);
}

/** `[ ]` to `[x]` and back, for the task box at `pos`. */
export function toggleTask(view: EditorView, pos: number): boolean {
  const text = view.state.doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return false;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " } });
  return true;
}

/** The address of the link at `pos`, if it is one a note may open. */
export function linkAt(state: EditorState, pos: number): string | null {
  const at = syntaxTree(state).resolveInner(pos, 1);
  for (let n: typeof at | null = at; n; n = n.parent) {
    const url = n.name === "URL" ? n : n.name === "Link" ? n.getChild("URL") : null;
    if (n.name === "URL" || n.name === "Link") {
      const href = url ? state.doc.sliceString(url.from, url.to) : "";
      return SAFE_LINK.test(href) ? href : null;
    }
  }
  return null;
}

const inline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = previewDecorations(view.state, view.visibleRanges);
    }
    update(u: ViewUpdate) {
      const focus = u.transactions.some((t) => t.effects.some((e) => e.is(setFocus)));
      if (u.docChanged || u.selectionSet || u.viewportChanged || focus || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = previewDecorations(u.state, u.view.visibleRanges);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(e, view) {
        const t = e.target as HTMLElement;
        if (t instanceof HTMLInputElement && t.classList.contains("cm-md-task")) {
          e.preventDefault(); // the box flips; the caret stays where it was
          return toggleTask(view, view.posAtDOM(t));
        }
        if (!(e.metaKey || e.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const href = pos === null ? null : linkAt(view.state, pos);
        if (!href) return false;
        e.preventDefault();
        window.open(href, "_blank", "noopener");
        return true;
      },
    },
  },
);

/**
 * Up or Down onto a table's line puts the caret at that line's start, where
 * the grid gives way to the text: on its own, the caret skips a grid whole.
 */
const intoTable = (dir: 1 | -1) => (view: EditorView): boolean => {
  const { state } = view;
  const at = state.selection.main;
  if (!at.empty) return false;
  const n = state.doc.lineAt(at.head).number + dir;
  if (n < 1 || n > state.doc.lines) return false;
  const target = state.doc.line(n);
  let table = false;
  syntaxTree(state).iterate({ from: target.from, to: target.to, enter: (t) => { if (t.name === "Table") table = true; return !table; } });
  if (!table) return false;
  view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  return true;
};

/** Everything above, as one extension. */
export const livePreview = [
  focusState,
  trackFocus,
  tables,
  inline,
  Prec.high(keymap.of([{ key: "ArrowDown", run: intoTable(1) }, { key: "ArrowUp", run: intoTable(-1) }])),
];
