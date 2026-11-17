import { expect, test } from "bun:test";
import { isImagePath, keepAttachments, keptAttachments, linkedPath, sentFiles, type Attachment } from "../src/client/conversation/attach";

test("the files a step sent the user are Claude Code's SendUserFile paths; no other step sends any", () => {
  const input = JSON.stringify({ files: ["/tmp/shot.png", "report.md", 7], caption: "x", status: "normal" }, null, 2);
  expect(sentFiles({ tool: "SendUserFile", input })).toEqual(["/tmp/shot.png", "report.md"]);
  expect(sentFiles({ tool: "Read", input: JSON.stringify({ file_path: "/tmp/shot.png" }) })).toEqual([]);
  expect(sentFiles({ tool: "SendUserFile", input: "not json" })).toEqual([]);
  expect(sentFiles({ tool: "SendUserFile", input: JSON.stringify({ files: "/tmp/a.png" }) })).toEqual([]);
});

test("an image is a png, jpeg, gif or webp by its name; a /file address names its path", () => {
  expect(["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp"].every(isImagePath)).toBe(true);
  expect(["a.heic", "b.svg", "c.pdf", "png", "a.png.txt"].some(isImagePath)).toBe(false);
  expect(linkedPath("/file?path=%2Ftmp%2Fa+b.png&window=%401")).toBe("/tmp/a b.png");
  expect(linkedPath("https://example.com/a.png")).toBeNull();
});

test("a reload keeps each tab's uploaded files, never one still uploading", () => {
  const byTab = new Map<string, Attachment[]>([
    ["@1", [
      { id: 1, label: "shot.png", image: true, name: "paste-1.png", path: "/tmp/pastes/paste-1.png" },
      { id: 2, label: "notes.txt", image: false },
    ]],
    ["@2", [{ id: 3, label: "big.mov", image: false }]],
  ]);
  const kept = keepAttachments(byTab);
  expect(kept).toEqual([["@1", [{ label: "shot.png", image: true, name: "paste-1.png", path: "/tmp/pastes/paste-1.png" }]]]);
  // Through storage and back, as the page does it.
  expect(keptAttachments(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
});

test("what was kept is read back only when well formed", () => {
  const good = { label: "a.png", image: true, name: "paste-2.png", path: "/tmp/pastes/paste-2.png" };
  expect(keptAttachments(null)).toEqual([]);
  expect(keptAttachments({})).toEqual([]);
  expect(keptAttachments([["@1", [good, { label: "b", image: true, name: "", path: "/x" }, { label: "c" }, null]], [7, [good]], ["@2", "x"], ["@3", []]]))
    .toEqual([["@1", [good]]]);
  // No more than a message takes.
  expect(keptAttachments([["@1", Array.from({ length: 12 }, () => good)]])[0]![1]).toHaveLength(10);
});
