import { expect, test } from "bun:test";
import { tabLabel, tabsModel } from "../src/client/tabs";

const SESSIONS = [
  { name: "work", attached: 2, windows: [
    { id: "@0", index: 0, name: "claude", active: true, panes: 2 },
    { id: "@1", index: 1, name: "zsh", active: false, panes: 1 },
  ] },
  { name: "scratch", attached: 0, windows: [{ id: "@0", index: 0, name: "zsh", active: true, panes: 1 }] },
];

test("returns the attached session's windows in tmux order", () => {
  expect(tabsModel(SESSIONS, "work")).toEqual(SESSIONS[0]!.windows);
});

test("nothing attached, or a session that is gone, yields no tabs", () => {
  expect(tabsModel(SESSIONS, null)).toEqual([]);
  expect(tabsModel(SESSIONS, "killed")).toEqual([]);
  expect(tabsModel([], "work")).toEqual([]);
});

test("a tab shows its cmux title when the window carries one", () => {
  const sessions = [{ name: "work", attached: 1, windows: [
    { id: "@0", index: 0, name: "2.1.278", label: "✳ Banner editor migration", active: true, panes: 1 },
    { id: "@1", index: 1, name: "zsh", active: false, panes: 1 },
  ] }];
  expect(tabsModel(sessions, "work").map(tabLabel)).toEqual(["✳ Banner editor migration", "zsh"]);
});

test("a rename overrides the cmux title and the window name", () => {
  const sessions = [{ name: "work", attached: 1, windows: [
    { id: "@0", index: 0, name: "2.1.278", label: "✳ Banner editor migration", customName: "Banner", active: true, panes: 1 },
  ] }];
  expect(tabsModel(sessions, "work").map(tabLabel)).toEqual(["Banner"]);
});
