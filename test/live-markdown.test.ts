import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { focusState, linkAt, previewDecorations, setFocus, tableDecorations } from "../src/client/live-markdown";

/** `doc`, with the caret at `caret` in a focused editor, or unfocused when it is left out. */
function state(doc: string, caret?: number): EditorState {
  const s = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), focusState] });
  return caret === undefined ? s : s.update({ selection: { anchor: caret }, effects: setFocus.of(true) }).state;
}

/** Each decoration as text, sorted: `hide 0-3`, `line 0 cm-md-h cm-md-h2`, `mark 0-5 cm-md-strong`, `widget 0-1 BulletWidget`. */
function list(set: DecorationSet, length: number): string[] {
  const out: string[] = [];
  set.between(0, length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: object; block?: boolean };
    if (spec.widget) out.push(`widget ${from}-${to} ${spec.widget.constructor.name}${spec.block ? " block" : ""}`);
    else if (from === to) out.push(`line ${from} ${spec.class}`);
    else if (spec.class) out.push(`mark ${from}-${to} ${spec.class}`);
    else out.push(`hide ${from}-${to}`);
  });
  return out.sort();
}
const decos = (doc: string, caret?: number) => list(previewDecorations(state(doc, caret)), doc.length);
const sorted = (a: string[]) => [...a].sort();

describe("previewDecorations", () => {
  test("a heading keeps its size and folds its marks until the caret is on its line", () => {
    expect(decos("## Head\nbody")).toEqual(sorted(["line 0 cm-md-h cm-md-h2", "hide 0-3"]));
    expect(decos("## Head\nbody", 5)).toEqual(["line 0 cm-md-h cm-md-h2"]);
  });

  test("bold, italic and code show styled, their marks folded", () => {
    expect(decos("**b** *i* `c`")).toEqual(sorted([
      "mark 0-5 cm-md-strong", "hide 0-2", "hide 3-5",
      "mark 6-9 cm-md-em", "hide 6-7", "hide 8-9",
      "mark 11-12 cm-md-code", "hide 10-11", "hide 12-13",
    ]));
  });

  test("only the element the caret is in shows its marks, not the whole line", () => {
    // In the code span: its backticks show, dimmed outside the chip; the bold's stay folded.
    expect(decos("**b** `code`", 8)).toEqual(sorted([
      "mark 0-5 cm-md-strong", "hide 0-2", "hide 3-5",
      "mark 7-11 cm-md-code", "mark 6-7 cm-md-fence", "mark 11-12 cm-md-fence",
    ]));
  });

  test("a link shows its text; its address folds away until the caret is in it", () => {
    expect(decos("[t](https://x.y)")).toEqual(sorted([
      "mark 0-16 cm-md-link", "hide 0-1", "hide 2-3", "hide 3-4", "hide 4-15", "hide 15-16",
    ]));
    expect(decos("[t](https://x.y) more", 1)).toEqual(["mark 0-16 cm-md-link"]);
  });

  test("an image is left as typed", () => {
    expect(decos("![a](https://x.y/a.png)")).toEqual([]);
  });

  test("a bullet reads as a dot until the caret is on its line", () => {
    expect(decos("- a")).toEqual(["widget 0-1 BulletWidget"]);
    expect(decos("- a", 3)).toEqual([]);
  });

  test("a task is a box, a done one struck through, on any line", () => {
    expect(decos("- [x] done")).toEqual(sorted(["hide 0-2", "widget 2-5 TaskWidget", "mark 6-10 cm-md-done"]));
    expect(decos("- [ ] todo", 8)).toEqual(["widget 2-5 TaskWidget"]);
  });

  test("a quote is a ruled line, its mark folded", () => {
    expect(decos("> q")).toEqual(sorted(["line 0 cm-md-quote", "hide 0-2"]));
  });

  const block = "```json\n{}\n```";
  test("a code block folds its fences, keeps its language as a label, and has a copy button", () => {
    expect(decos(block)).toEqual(sorted([
      "line 0 cm-md-codeblock cm-md-codeblock-first",
      "line 8 cm-md-codeblock",
      "line 11 cm-md-codeblock cm-md-codeblock-last cm-md-codeblock-close",
      "hide 0-3", "mark 3-7 cm-md-codelang", "hide 11-14",
      "widget 7-7 CopyWidget",
    ]));
  });

  test("with the caret in it, a code block shows its fences, dimmed", () => {
    expect(decos(block, 9)).toEqual(sorted([
      "line 0 cm-md-codeblock cm-md-codeblock-first",
      "line 8 cm-md-codeblock",
      "line 11 cm-md-codeblock cm-md-codeblock-last",
      "mark 0-3 cm-md-fence", "mark 3-7 cm-md-fence", "mark 11-14 cm-md-fence",
      "widget 7-7 CopyWidget",
    ]));
  });

  test("marks inside a fenced block are code, not markdown", () => {
    expect(decos("```\n**x**\n```").filter((d) => d.includes("strong"))).toEqual([]);
  });
});

describe("tableDecorations", () => {
  const table = "intro\n\n| a | b |\n| :- | -: |\n| 1 | `2` |\n\nafter";
  test("a table the caret is not in is a grid in place of its lines", () => {
    expect(list(tableDecorations(state(table)), table.length)).toEqual(["widget 7-40 TableWidget block"]);
    expect(list(tableDecorations(state(table, 0)), table.length)).toEqual(["widget 7-40 TableWidget block"]);
  });
  test("with the caret in it, the table is its text, to edit as typed", () => {
    expect(list(tableDecorations(state(table, 9)), table.length)).toEqual([]);
    expect(decos(table, 9).some((d) => d.includes("cm-md-code"))).toBe(true);
  });
  test("its cells are not decorated twice while it is a grid", () => {
    expect(decos(table)).toEqual([]);
  });
});

describe("linkAt", () => {
  test("opens only web and mail addresses", () => {
    expect(linkAt(state("[t](https://x.y)"), 1)).toBe("https://x.y");
    expect(linkAt(state("see https://x.y/z"), 6)).toBe("https://x.y/z");
    expect(linkAt(state("[m](mailto:a@x.y)"), 1)).toBe("mailto:a@x.y");
    expect(linkAt(state("[t](javascript:alert(1))"), 1)).toBeNull();
    expect(linkAt(state("plain text"), 2)).toBeNull();
  });
});
