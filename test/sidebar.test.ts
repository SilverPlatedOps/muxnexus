import { expect, test } from "bun:test";
import { sessionLabel, sidebarModel } from "../src/client/sidebar";

test("flattens sessions and windows into rows, marking current and attached", () => {
  const rows = sidebarModel(
    [
      { name: "work", id: "$1", attached: 2, windows: [
        { id: "@0", index: 0, name: "claude", active: true, panes: 2 },
        { id: "@1", index: 1, name: "zsh", active: false, panes: 1 },
      ] },
      { name: "scratch", id: "$2", attached: 0, windows: [{ id: "@0", index: 0, name: "zsh", active: true, panes: 1 }] },
    ],
    "work",
  );
  expect(rows).toEqual([
    { kind: "session", name: "work", label: "work", orphan: false, attached: true, current: true, windows: [
      { id: "@0", index: 0, name: "claude", active: true, panes: 2 },
      { id: "@1", index: 1, name: "zsh", active: false, panes: 1 },
    ] },
    { kind: "window", session: "work", index: 0, name: "claude", active: true, panes: 2 },
    { kind: "window", session: "work", index: 1, name: "zsh", active: false, panes: 1 },
    { kind: "session", name: "scratch", label: "scratch", orphan: false, attached: false, current: false, windows: [
      { id: "@0", index: 0, name: "zsh", active: true, panes: 1 },
    ] },
    { kind: "window", session: "scratch", index: 0, name: "zsh", active: true, panes: 1 },
  ]);
});

test("attached: 1 on the current session is only our own client, not another", () => {
  const rows = sidebarModel([{ name: "solo", id: "$3", attached: 1, windows: [] }], "solo");
  expect(rows[0]).toEqual({ kind: "session", name: "solo", label: "solo", orphan: false, attached: false, current: true, windows: [] });
});

test("attached: 1 on a non-current session is another client", () => {
  const rows = sidebarModel([{ name: "other", id: "$4", attached: 1, windows: [] }], "work");
  expect(rows[0]).toEqual({ kind: "session", name: "other", label: "other", orphan: false, attached: true, current: false, windows: [] });
});

test("empty input yields no rows", () => {
  expect(sidebarModel([], null)).toEqual([]);
});

test("shows the cmux workspace title but keeps tmux's name as the identity", () => {
  // The guard named this session after the directory; the workspace was renamed later.
  const rows = sidebarModel(
    [{ name: "me", id: "$5", label: "Personal - Cmux", attached: 0, windows: [] }],
    null,
  );
  expect(rows[0]).toEqual({
    kind: "session", name: "me", label: "Personal - Cmux",
    orphan: false, attached: false, current: false, windows: [],
  });
});

test("marks a session whose cmux workspace has been closed", () => {
  const rows = sidebarModel([{ name: "ghost", id: "$6", orphan: true, attached: 0, windows: [] }], null);
  expect(rows[0]).toMatchObject({ name: "ghost", label: "ghost", orphan: true });
});

test("a rename overrides both the cmux title and the tmux name", () => {
  const rows = sidebarModel(
    [{ name: "me", id: "$8", label: "Personal - Cmux", customName: "My Projects", attached: 0, windows: [] }],
    null,
  );
  expect(rows[0]).toMatchObject({ name: "me", label: "My Projects" });
});

test("sessionLabel is what the row and the top bar both show", () => {
  const base = { name: "tmux-name", id: "$1", attached: 0, windows: [] };
  expect(sessionLabel(base)).toBe("tmux-name");
  expect(sessionLabel({ ...base, label: "cmux title" })).toBe("cmux title");
  expect(sessionLabel({ ...base, label: "cmux title", customName: "mine" })).toBe("mine");
});
