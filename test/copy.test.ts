import { afterEach, expect, test } from "bun:test";
import { copyText } from "../src/client/copy";

// Just enough of a page for copyText: a body, text boxes, the copy command and focus.
function fakePage(opts: { clipboard?: { writeText(t: string): Promise<void> }; copies?: boolean }) {
  const log: string[] = [];
  const focused = { focus: () => log.push("refocused") };
  const doc = {
    activeElement: focused as unknown,
    body: { append: () => log.push("box added") },
    createElement: () => {
      const box = {
        value: "", readOnly: false, style: { cssText: "" },
        setAttribute() {}, select() { doc.activeElement = box; }, setSelectionRange() {},
        remove: () => log.push("box removed"),
      };
      return box;
    },
    execCommand: (cmd: string) => { log.push(`execCommand ${cmd}: ${(doc.activeElement as { value?: string }).value}`); return opts.copies ?? true; },
  };
  Object.assign(globalThis, { document: doc, navigator: { clipboard: opts.clipboard } });
  return log;
}

const saved = { document: globalThis.document, navigator: globalThis.navigator };
afterEach(() => { Object.assign(globalThis, saved); });

test("the clipboard API is used where the page has it", async () => {
  const written: string[] = [];
  const log = fakePage({ clipboard: { writeText: async (t) => { written.push(t); } } });
  expect(await copyText("hello")).toBe(true);
  expect(written).toEqual(["hello"]);
  expect(log).toEqual([]);
});

test("over plain http, with no clipboard API, the browser's own copy takes it from a text box", async () => {
  const log = fakePage({});
  expect(await copyText("from warrior")).toBe(true);
  expect(log).toEqual(["box added", "execCommand copy: from warrior", "box removed", "refocused"]);
});

test("a refused clipboard API falls back to the text box", async () => {
  const log = fakePage({ clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } } });
  expect(await copyText("x")).toBe(true);
  expect(log).toContain("execCommand copy: x");
});

test("a copy command the browser turns down reports failure", async () => {
  fakePage({ copies: false });
  expect(await copyText("x")).toBe(false);
});
