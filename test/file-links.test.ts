import { expect, test } from "bun:test";
import { Terminal, type ILink } from "@xterm/xterm";
import { FileLinkProvider, fileTarget, markdownPath } from "../src/client/file-links";

test("file references use the terminal window, while URLs and unsafe schemes stay out", () => {
  expect(fileTarget("docs/design-explorations/moving-crews/garden.png", "@26")).toBe("/file?path=docs%2Fdesign-explorations%2Fmoving-crews%2Fgarden.png&window=%4026");
  expect(fileTarget("src/main.ts:12:3", "@4")).toBe("/file?path=src%2Fmain.ts&window=%404");
  expect(fileTarget("./a.md#L12-L20", "@4")).toBe("/file?path=.%2Fa.md&window=%404");
  expect(fileTarget("/tmp/my image.png")).toBe("/file?path=%2Ftmp%2Fmy+image.png");
  expect(fileTarget("~/shot.png")).toBe("/file?path=%7E%2Fshot.png");
  for (const value of ["https://example.com/a.png", "javascript:alert(1).png", "//remote/a.png", "docs/", "plain text", "x\x00.png"]) {
    expect(fileTarget(value, "@4")).toBeNull();
  }
  expect(fileTarget("docs/garden.png")).toBeNull();
});

async function fixture(text: string, cols = 160) {
  const terminal = new Terminal({ cols, rows: 16, allowProposedApi: true });
  await new Promise<void>((done) => terminal.write(text, done));
  const opened: string[] = [];
  let window = "@26";
  const provider = new FileLinkProvider(terminal, () => window, (target) => { opened.push(target); });
  const links = (row: number) => {
    let found: ILink[] = [];
    provider.provideLinks(row, (result) => { found = result; });
    return found;
  };
  return { terminal, links, opened, changeWindow: (id: string) => { window = id; } };
}

test("the screenshot's already-rendered green paths become links without reprinting output", async () => {
  const references = ["garden.png", "railway.png", "radio.png", "aquarium.png", "directions.md"].map((name) => `docs/design-explorations/moving-crews/${name}`);
  const f = await fixture(references.map((path) => `• A label (\x1b[32m${path}\x1b[0m)`).join("\r\n"));
  try {
    for (const [row, reference] of references.entries()) {
      const [link] = f.links(row + 1);
      expect(link?.text).toBe(reference);
      link!.activate({} as MouseEvent, link!.text);
      expect(new URL(f.opened[row]!, "http://localhost").searchParams.get("path")).toBe(reference);
    }
    f.changeWindow("@27");
    const link = f.links(1)[0]!;
    link.activate({} as MouseEvent, link.text);
    expect(f.opened.at(-1)).toContain("window=%4027");
  } finally { f.terminal.dispose(); }
});

test("wrapped paths have complete destinations and correct cell ranges after wide text", async () => {
  const reference = "docs/design-explorations/moving-crews/garden.png";
  const f = await fixture(`漢 😀 (${reference})`, 24);
  try {
    const link = f.links(2)[0]!;
    expect(link.text).toBe(reference);
    expect(link.range.start).toEqual({ x: 7, y: 1 }); // xterm's default Unicode table renders this emoji in one cell
    expect(link.range.end.y).toBe(3);
    link.activate({} as MouseEvent, link.text);
    expect(new URL(f.opened[0]!, "http://localhost").searchParams.get("path")).toBe(reference);
  } finally { f.terminal.dispose(); }
});

test("quoted paths with spaces work, and web links are left to the web provider", async () => {
  const f = await fixture('See (docs/my image.png), src/main.ts:12, and https://example.com/a.png.');
  try {
    expect(f.links(1).map((link) => link.text)).toEqual(["docs/my image.png", "src/main.ts:12"]);
  } finally { f.terminal.dispose(); }
});

test("a Markdown file's address gives its path, from a bare reference or a file:// link alike", () => {
  expect(markdownPath(fileTarget("docs/plan.md", "@26")!)).toBe("docs/plan.md");
  expect(markdownPath("/file?path=%2FUsers%2Fme%2Fhandoffs%2Fplan.md")).toBe("/Users/me/handoffs/plan.md");
  expect(markdownPath(fileTarget("~/notes/PLAN.MD", "@4")!)).toBe("~/notes/PLAN.MD");
  expect(markdownPath(fileTarget("/tmp/a.markdown")!)).toBe("/tmp/a.markdown");
});

test("anything that is not a Markdown file through /file has no Markdown path", () => {
  for (const target of [fileTarget("src/main.ts", "@4")!, fileTarget("/tmp/plan.md.bak")!, "https://example.com/plan.md", "/elsewhere?path=plan.md"]) {
    expect(markdownPath(target)).toBeNull();
  }
});
