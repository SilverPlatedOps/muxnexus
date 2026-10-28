import { expect, test } from "bun:test";
import type { NoteSummary, SessionInfo } from "../src/shared/protocol";
import { globalHits } from "../src/client/global-search";

const sessions: SessionInfo[] = [
  { id: "$1", name: "raw-work", customName: "[Work] Banner", attached: 0, windows: [
    { id: "@1", name: "claude", customName: "Implementation", index: 0, active: true, panes: 1, agent: { state: "done", since: "", checkout: "/repos/cms-backend" } },
    { id: "@2", name: "codex", index: 1, active: false, panes: 1 },
  ] },
  { id: "$2", name: "Personal", attached: 0, windows: [] },
];
const notes: NoteSummary[] = [
  { noteId: "live", session: "[Work] Banner", window: "Implementation", text: "Investigate expired vouchers", updated: "", live: { session: "raw-work", windowId: "@1" } },
  { noteId: "old", session: "Archived", window: "Planning", text: "Old deployment decisions", updated: "" },
];

test("global search groups workspaces, tabs and notes without losing closed-window notes", () => {
  expect(globalHits(sessions, notes, "").map((h) => h.kind)).toEqual(["workspace", "workspace", "tab", "tab", "note", "note"]);
  expect(globalHits(sessions, notes, "decisions")).toEqual([
    expect.objectContaining({ kind: "note", noteId: "old", title: "Archived › Planning" }),
  ]);
});

test("each query word can match a different part of a tab's task context", () => {
  expect(globalHits(sessions, notes, "BANNER CMS-BACKEND implementation")).toEqual([
    expect.objectContaining({ kind: "tab", session: "raw-work", windowId: "@1" }),
  ]);
  expect(globalHits(sessions, notes, "banner vouchers").map((h) => h.key)).toEqual(["note:live"]);
  expect(globalHits(sessions, notes, "banner nonexistent")).toEqual([]);
});

test("search uses display names but preserves actual navigation targets", () => {
  const hit = globalHits(sessions, notes, "banner").find((h) => h.kind === "workspace");
  expect(hit).toMatchObject({ title: "[Work] Banner", session: "raw-work" });
  expect(globalHits(sessions, notes, "raw-work").some((h) => h.kind === "workspace")).toBe(true);
});

test("search treats punctuation as literal text and tolerates whitespace", () => {
  expect(globalHits(sessions, notes, "  [WORK]   Banner ").length).toBe(4);
  expect(globalHits(sessions, notes, "<script>")).toEqual([]);
});
