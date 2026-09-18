import { expect, test } from "bun:test";
import { sidebarModel } from "../src/client/sidebar";

test("flattens sessions and windows into rows, marking current and attached", () => {
  const rows = sidebarModel(
    [
      { name: "work", attached: 1, windows: [
        { index: 0, name: "claude", active: true, panes: 2 },
        { index: 1, name: "zsh", active: false, panes: 1 },
      ] },
      { name: "scratch", attached: 0, windows: [{ index: 0, name: "zsh", active: true, panes: 1 }] },
    ],
    "work",
  );
  expect(rows).toEqual([
    { kind: "session", name: "work", attached: true, current: true },
    { kind: "window", session: "work", index: 0, name: "claude", active: true, panes: 2 },
    { kind: "window", session: "work", index: 1, name: "zsh", active: false, panes: 1 },
    { kind: "session", name: "scratch", attached: false, current: false },
    { kind: "window", session: "scratch", index: 0, name: "zsh", active: true, panes: 1 },
  ]);
});

test("empty input yields no rows", () => {
  expect(sidebarModel([], null)).toEqual([]);
});
