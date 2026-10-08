/**
 * Markdown styled as it is typed, the way Obsidian's live preview reads: a
 * heading is large, bold is bold, code sits on its own ground, and the marks
 * that make them (`##`, `**`, backticks, a link's address) fold away on every
 * line but the one the caret is on. The text itself is never rewritten.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

/** Any device can write a note, and there is no login: a link may open the web or mail, nothing else. */
export const SAFE_LINK = /^(https?:|mailto:)/i;

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

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const line = (cls: string) => Decoration.line({ class: cls });
const fence = mark("cm-md-fence");
const STYLE: Record<string, Decoration> = {
  StrongEmphasis: mark("cm-md-strong"),
  Emphasis: mark("cm-md-em"),
  Strikethrough: mark("cm-md-strike"),
  InlineCode: mark("cm-md-code"),
  Link: mark("cm-md-link", { title: "⌘-click to open" }),
};
/** Marks that fold away off the caret's line, with the space after them for those that take one. */
const FOLD = new Set(["EmphasisMark", "StrikethroughMark", "LinkMark", "URL"]);
const FOLD_SPACED = new Set(["HeaderMark", "QuoteMark"]);

/**
 * The decorations for `state` across `ranges`. `active` holds the lines the
 * caret is on, where every mark shows so it can be edited.
 */
export function previewDecorations(
  state: EditorState,
  active: ReadonlySet<number>,
  ranges: readonly { from: number; to: number }[] = [{ from: 0, to: state.doc.length }],
): DecorationSet {
  const out: Range<Decoration>[] = [];
  const doc = state.doc;
  const lineOf = (pos: number) => doc.lineAt(pos).number;
  const eachLine = (from: number, to: number, cls: string) => {
    for (let n = lineOf(from); n <= lineOf(to); n++) out.push(line(cls).range(doc.line(n).from));
  };
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        const shown = active.has(lineOf(node.from));
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          out.push(line(`cm-md-h cm-md-h${heading[1]}`).range(doc.lineAt(node.from).from));
        } else if (name === "Blockquote") {
          eachLine(node.from, node.to, "cm-md-quote");
        } else if (name === "FencedCode") {
          eachLine(node.from, node.to, "cm-md-codeblock");
          // Its marks are fences and a language: kept, and dimmed.
          for (const c of node.node.getChildren("CodeMark").concat(node.node.getChildren("CodeInfo"))) {
            out.push(fence.range(c.from, c.to));
          }
          return false;
        } else if (name === "CodeMark") {
          // An inline code's backticks: the fences returned above.
          if (!shown) out.push(hide.range(node.from, node.to));
        } else if (STYLE[name]) {
          if (node.to > node.from) out.push(STYLE[name].range(node.from, node.to));
        } else if (name === "URL" && node.node.parent?.name !== "Link") {
          out.push(STYLE.Link.range(node.from, node.to)); // a bare address
          return;
        } else if (name === "ListMark") {
          const list = node.node.parent?.parent?.name;
          const task = node.node.nextSibling?.name === "Task";
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
        if (shown) return;
        if (FOLD.has(name)) {
          out.push(hide.range(node.from, node.to));
        } else if (FOLD_SPACED.has(name)) {
          const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
          out.push(hide.range(node.from, end));
        }
      },
    });
  }
  return Decoration.set(out, true);
}

/** The lines any selection touches, while the editor has the keys; none without them. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    for (let n = view.state.doc.lineAt(r.from).number; n <= view.state.doc.lineAt(r.to).number; n++) lines.add(n);
  }
  return lines;
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

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = previewDecorations(view.state, activeLines(view), view.visibleRanges);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = previewDecorations(u.state, activeLines(u.view), u.view.visibleRanges);
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
