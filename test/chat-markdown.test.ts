import { describe, expect, test } from "bun:test";
import { chatLink, markdownNodes, type MarkdownNode } from "../src/client/chat/markdown";
const walk = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap((n) => [n, ...walk(n.children ?? [])]);
const text = (nodes: MarkdownNode[]): string => nodes.map((n) => (n.text ?? "") + text(n.children ?? [])).join("");

describe("chat Markdown", () => {
  test("renders semantic headings, nested lists, emphasis, tables and mentions", () => {
    const nodes = markdownNodes("## Evidence\n\n**Works** for @codex1\n\n1. first\n   - nested\n\n| file | result |\n| --- | --- |\n| a.ts | pass |");
    const all = walk(nodes);
    for (const tag of ["h2", "strong", "ol", "ul", "table", "thead", "th", "td"]) expect(all.some((n) => n.tag === tag)).toBe(true);
    expect(all.find((n) => n.attrs?.class === "chat-at")?.children?.[0]?.text).toBe("@codex1");
    expect(text(nodes)).toContain("Evidence");
  });
  test("code stays literal, and Copy contains the exact fenced content", () => {
    const all = walk(markdownNodes("```ts\nconst x = '<script>';\n**literal**\n```"));
    expect(all.find((n) => n.copy !== undefined)?.copy).toBe("const x = '<script>';\n**literal**");
    expect(all.some((n) => n.tag === "script" || n.tag === "strong")).toBe(false);
  });
  test("HTML and images stay inert text; unsafe link schemes cannot become anchors", () => {
    const nodes = markdownNodes('<script>alert(1)</script>\n\n![secret](https://tracker.test/pixel)\n\n[bad](javascript:alert) [good](https://example.com)');
    const all = walk(nodes);
    expect(all.filter((n) => n.tag === "a").map((n) => n.attrs?.href)).toEqual(["https://example.com"]);
    expect(all.some((n) => ["script", "img", "iframe"].includes(n.tag))).toBe(false);
    expect(text(nodes)).toContain("<script>");
  });
  test("a bare address becomes a link, without its trailing punctuation; other schemes stay text", () => {
    const all = walk(markdownNodes("Open https://github.com/a/b/compare/main...x?expand=1. Or javascript:alert(1) and ftp://x.test"));
    expect(all.filter((n) => n.tag === "a").map((n) => n.attrs?.href)).toEqual(["https://github.com/a/b/compare/main...x?expand=1"]);
    const link = all.find((n) => n.tag === "a")!;
    expect(link.attrs).toMatchObject({ target: "_blank", rel: "noopener noreferrer" });
  });
  test("code inside a link label never creates a nested link", () => {
    const all = walk(markdownNodes("[`src/a.ts`](https://example.com)", "@7"));
    expect(all.filter((n) => n.tag === "a")).toHaveLength(1);
    expect(all.find((n) => n.tag === "a")?.attrs?.href).toBe("https://example.com");
  });
  test("file links retain the author's window context; relative files need it", () => {
    expect(chatLink("src/a.ts:12")).toBeNull();
    expect(chatLink("src/a.ts:12", "@7")).toBe("/file?path=src%2Fa.ts&window=%407");
    const all = walk(markdownNodes("[source](src/a.ts:12) `src/b.ts:4`", "@7"));
    expect(all.filter((n) => n.tag === "a").map((n) => n.attrs?.href)).toEqual(["/file?path=src%2Fa.ts&window=%407", "/file?path=src%2Fb.ts&window=%407"]);
    for (const n of all.filter((n) => n.tag === "a")) expect(n.attrs?.rel).toBe("noopener noreferrer");
    for (const url of ["javascript:alert(1)", "data:text/html,test", "//evil.test", "https:\n//evil.test"]) expect(chatLink(url, "@7")).toBeNull();
  });
});
