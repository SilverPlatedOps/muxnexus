import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { linkAt, previewDecorations } from "../src/client/live-markdown";

const sorted = (a: string[]) => [...a].sort();
const state = (doc: string) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });

/** Each decoration as text, sorted: `hide 0-3`, `line 0 cm-md-h cm-md-h2`, `mark 0-5 cm-md-strong`, `widget 0-1 •`. */
function decos(doc: string, active: number[] = []): string[] {
  const out: string[] = [];
  previewDecorations(state(doc), new Set(active)).between(0, doc.length, (from, to, d) => {
    const spec = d.spec as { class?: string; widget?: { checked?: boolean } };
    if (spec.widget) out.push(`widget ${from}-${to} ${"checked" in spec.widget ? `task ${spec.widget.checked}` : "•"}`);
    else if (from === to) out.push(`line ${from} ${spec.class}`);
    else if (spec.class) out.push(`mark ${from}-${to} ${spec.class}`);
    else out.push(`hide ${from}-${to}`);
  });
  return out.sort();
}

describe("previewDecorations", () => {
  test("a heading keeps its size and folds its marks off the caret's line", () => {
    expect(decos("## Head\nbody")).toEqual(sorted(["line 0 cm-md-h cm-md-h2", "hide 0-3"]));
    expect(decos("## Head\nbody", [1])).toEqual(sorted(["line 0 cm-md-h cm-md-h2"]));
  });

  test("bold, italic and code show styled, their marks folded", () => {
    expect(decos("**b** *i* `c`")).toEqual(sorted([
      "mark 0-5 cm-md-strong", "hide 0-2", "hide 3-5",
      "mark 6-9 cm-md-em", "hide 6-7", "hide 8-9",
      "mark 10-13 cm-md-code", "hide 10-11", "hide 12-13",
    ]));
  });

  test("a link shows its text; its address folds away", () => {
    expect(decos("[t](https://x.y)")).toEqual(sorted([
      "mark 0-16 cm-md-link", "hide 0-1", "hide 2-3", "hide 3-4", "hide 4-15", "hide 15-16",
    ]));
  });

  test("a bullet reads as a dot until the caret is on its line", () => {
    expect(decos("- a")).toEqual(sorted(["widget 0-1 •"]));
    expect(decos("- a", [1])).toEqual([]);
  });

  test("a task is a box, a done one struck through, on any line", () => {
    expect(decos("- [x] done")).toEqual(sorted(["hide 0-2", "widget 2-5 task true", "mark 6-10 cm-md-done"]));
    expect(decos("- [ ] todo", [1])).toEqual(sorted(["widget 2-5 task false"]));
  });

  test("a quote is a ruled line, its mark folded", () => {
    expect(decos("> q")).toEqual(sorted(["line 0 cm-md-quote", "hide 0-2"]));
  });

  test("a fenced block keeps its fences, dimmed, every line on code ground", () => {
    expect(decos("```js\nx **y**\n```")).toEqual(sorted([
      "line 0 cm-md-codeblock", "line 6 cm-md-codeblock", "line 14 cm-md-codeblock",
      "mark 0-3 cm-md-fence", "mark 3-5 cm-md-fence", "mark 14-17 cm-md-fence",
    ]));
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
