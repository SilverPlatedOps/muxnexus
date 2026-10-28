import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { SAFE_LINK } from "../live-markdown";
import { fileTarget } from "../file-links";
import { mentionParts } from "../../shared/chat";

/** A small semantic tree: no agent-supplied HTML or attributes reach the DOM. */
export interface MarkdownNode {
  tag: string;
  text?: string;
  attrs?: Record<string, string>;
  children?: MarkdownNode[];
  copy?: string;
}
const textNode = (text: string): MarkdownNode => ({ tag: "text", text });

export function chatLink(target: string, windowId?: string): string | null {
  if (/[\x00-\x20\x7f]/.test(target) && !target.startsWith("/")) return null;
  if (SAFE_LINK.test(target)) return target;
  return fileTarget(target, windowId);
}

/** Uses the same Markdown grammar as notes, rendered as ordinary selectable DOM. */
export function markdownNodes(source: string, windowId?: string): MarkdownNode[] {
  const raw = (n: SyntaxNode) => source.slice(n.from, n.to);
  const plain = (text: string) => mentionParts(text).map((p): MarkdownNode => p.mention
    ? { tag: "span", attrs: { class: "chat-at" }, children: [textNode(p.text)] }
    : textNode(p.text));
  const marks = /^(?:HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|LinkMark|ListMark|QuoteMark|TaskMarker|TableDelimiter)$/;
  function contents(n: SyntaxNode): MarkdownNode[] {
    const out: MarkdownNode[] = [];
    let at = n.from;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (at < c.from) out.push(...plain(source.slice(at, c.from)));
      if (!marks.test(c.name)) out.push(...render(c));
      at = c.to;
    }
    if (at < n.to) out.push(...plain(source.slice(at, n.to)));
    // Syntax whitespace after a list/heading mark isn't content.
    if (marks.test(n.firstChild?.name ?? "") && out[0]?.tag === "text") out[0].text = out[0].text?.replace(/^ /, "");
    return out;
  }
  function render(n: SyntaxNode): MarkdownNode[] {
    if (n.name === "Document") return children(n);
    if (n.name === "FencedCode" || n.name === "CodeBlock") {
      const code = n.getChild("CodeText");
      const value = code ? raw(code) : n.name === "CodeBlock" ? raw(n).replace(/^ {4}/gm, "") : "";
      return [{ tag: "section", attrs: { class: "chat-code" }, children: [
        { tag: "div", attrs: { class: "chat-code-head" }, children: [textNode(n.getChild("CodeInfo") ? raw(n.getChild("CodeInfo")!) : "Code"), { tag: "button", attrs: { type: "button", class: "chat-code-copy", "aria-label": "Copy code" }, text: "Copy", copy: value }] },
        { tag: "pre", children: [{ tag: "code", text: value }] },
      ] }];
    }
    if (n.name === "InlineCode") {
      const value = raw(n).replace(/^`+|`+$/g, "");
      let parent = n.parent;
      while (parent && parent.name !== "Link") parent = parent.parent;
      const target = parent ? null : fileTarget(value, windowId);
      const code: MarkdownNode = { tag: "code", text: value };
      return [target ? { tag: "a", attrs: { href: target, target: "_blank", rel: "noopener noreferrer" }, children: [code] } : code];
    }
    if (n.name === "Link" || n.name === "Autolink") {
      const url = n.getChild("URL");
      const href = url ? chatLink(raw(url).replace(/^<|>$/g, ""), windowId) : null;
      const label = n.name === "Autolink" ? [textNode(url ? raw(url) : raw(n))] : labelNodes(n);
      return href ? [{ tag: "a", attrs: { href, target: "_blank", rel: "noopener noreferrer" }, children: label }] : label;
    }
    // Images and HTML are text: remote images must never load as a side effect of a post.
    if (/^(?:Image|HTMLBlock|HTMLTag|Comment|ProcessingInstruction)$/.test(n.name)) return [textNode(raw(n))];
    if (n.name === "HorizontalRule") return [{ tag: "hr" }];
    if (n.name === "HardBreak") return [{ tag: "br" }];
    if (n.name === "Escape") return [textNode(raw(n).slice(1))];
    if (n.name === "Entity") return [textNode(raw(n))];
    const tags: Record<string, string> = { Paragraph: "p", StrongEmphasis: "strong", Emphasis: "em", Strikethrough: "del", BulletList: "ul", OrderedList: "ol", ListItem: "li", Blockquote: "blockquote", TableHeader: "tr", TableRow: "tr", TableCell: n.parent?.name === "TableHeader" ? "th" : "td", Task: "span" };
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(n.name);
    if (n.name === "Table") {
      const rows = children(n);
      return [{ tag: "div", attrs: { class: "chat-table-wrap" }, children: [{ tag: "table", children: [{ tag: "thead", children: rows.slice(0, 1) }, { tag: "tbody", children: rows.slice(1) }] }] }];
    }
    const tag = heading ? `h${heading[1]}` : tags[n.name];
    if (tag) {
      const parts = contents(n);
      if (n.name === "Task") parts.unshift(textNode(/^\[[xX]\]/.test(raw(n)) ? "☑ " : "☐ "));
      const attrs = n.name === "OrderedList" ? { start: /^\d+/.exec(raw(n))?.[0] ?? "1" } : undefined;
      return [{ tag, ...(attrs ? { attrs } : {}), children: parts }];
    }
    return n.firstChild ? contents(n) : plain(raw(n));
  }
  function children(n: SyntaxNode): MarkdownNode[] {
    const out: MarkdownNode[] = [];
    for (let c = n.firstChild; c; c = c.nextSibling) if (!marks.test(c.name)) out.push(...render(c));
    return out;
  }
  function labelNodes(n: SyntaxNode): MarkdownNode[] {
    // Link label ends at its closing ]. Keep emphasis/code inside the label.
    const out: MarkdownNode[] = [];
    let at = n.from + 1;
    for (let c = n.firstChild?.nextSibling; c; c = c.nextSibling) {
      if (c.name === "LinkMark") {
        if (at < c.from) out.push(...plain(source.slice(at, c.from)));
        break;
      }
      if (at < c.from) out.push(...plain(source.slice(at, c.from)));
      out.push(...render(c)); at = c.to;
    }
    return out;
  }
  return render(markdownLanguage.parser.parse(source).topNode);
}

export function renderMarkdown(text: string, windowId?: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "chat-markdown";
  function dom(n: MarkdownNode): Node {
    if (n.tag === "text") return document.createTextNode(n.text ?? "");
    const e = document.createElement(n.tag);
    for (const [key, value] of Object.entries(n.attrs ?? {})) e.setAttribute(key, value);
    if (n.text !== undefined) e.textContent = n.text;
    for (const c of n.children ?? []) e.append(dom(c));
    if (n.copy !== undefined) e.onclick = async () => {
      try { await navigator.clipboard.writeText(n.copy!); e.textContent = "Copied"; }
      catch { e.textContent = "Copy failed"; }
      setTimeout(() => { e.textContent = "Copy"; }, 1500);
    };
    return e;
  }
  for (const n of markdownNodes(text, windowId)) root.append(dom(n));
  return root;
}
