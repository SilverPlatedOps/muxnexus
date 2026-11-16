import { expect, test } from "bun:test";
import { isImagePath, linkedPath, sentFiles } from "../src/client/conversation/attach";

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
