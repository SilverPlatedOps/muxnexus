import { expect, test } from "bun:test";
import { sidebarModel } from "../src/client/sidebar";

test("flattens sessions and windows into rows, marking current and attached", () => {
  const rows = sidebarModel(
    [
      { name: "work", attached: 2, windows: [
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

test("attached: 1 on the current session is only our own client, not another", () => {
  const rows = sidebarModel([{ name: "solo", attached: 1, windows: [] }], "solo");
  expect(rows[0]).toEqual({ kind: "session", name: "solo", attached: false, current: true });
});

test("attached: 1 on a non-current session is another client", () => {
  const rows = sidebarModel([{ name: "other", attached: 1, windows: [] }], "work");
  expect(rows[0]).toEqual({ kind: "session", name: "other", attached: true, current: false });
});

test("empty input yields no rows", () => {
  expect(sidebarModel([], null)).toEqual([]);
});
