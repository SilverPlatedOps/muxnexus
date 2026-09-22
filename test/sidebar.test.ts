import { expect, test } from "bun:test";
import { sidebarModel } from "../src/client/sidebar";

test("flattens sessions and windows into rows, marking current and attached", () => {
  const rows = sidebarModel(
    [
      { name: "work", attached: 2, windows: [
        { id: "@0", index: 0, name: "claude", active: true, panes: 2 },
        { id: "@1", index: 1, name: "zsh", active: false, panes: 1 },
      ] },
      { name: "scratch", attached: 0, windows: [{ id: "@0", index: 0, name: "zsh", active: true, panes: 1 }] },
    ],
    "work",
  );
  expect(rows).toEqual([
    { kind: "session", name: "work", label: "work", orphan: false, attached: true, current: true },
    { kind: "window", session: "work", index: 0, name: "claude", active: true, panes: 2 },
    { kind: "window", session: "work", index: 1, name: "zsh", active: false, panes: 1 },
    { kind: "session", name: "scratch", label: "scratch", orphan: false, attached: false, current: false },
    { kind: "window", session: "scratch", index: 0, name: "zsh", active: true, panes: 1 },
  ]);
});

test("attached: 1 on the current session is only our own client, not another", () => {
  const rows = sidebarModel([{ name: "solo", attached: 1, windows: [] }], "solo");
  expect(rows[0]).toEqual({ kind: "session", name: "solo", label: "solo", orphan: false, attached: false, current: true });
});

test("attached: 1 on a non-current session is another client", () => {
  const rows = sidebarModel([{ name: "other", attached: 1, windows: [] }], "work");
  expect(rows[0]).toEqual({ kind: "session", name: "other", label: "other", orphan: false, attached: true, current: false });
});

test("empty input yields no rows", () => {
  expect(sidebarModel([], null)).toEqual([]);
});

test("shows the cmux workspace title but keeps tmux's name as the identity", () => {
  // The guard named this session after the directory; the workspace was renamed later.
  const rows = sidebarModel(
    [{ name: "me", label: "Personal - Cmux", attached: 0, windows: [] }],
    null,
  );
  expect(rows[0]).toEqual({
    kind: "session", name: "me", label: "Personal - Cmux",
    orphan: false, attached: false, current: false,
  });
});

test("marks a session whose cmux workspace has been closed", () => {
  const rows = sidebarModel([{ name: "ghost", orphan: true, attached: 0, windows: [] }], null);
  expect(rows[0]).toMatchObject({ name: "ghost", label: "ghost", orphan: true });
});
