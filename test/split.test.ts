import { describe, expect, test } from "bun:test";
import { dropPlan, dropSide, splitAfter } from "../src/client/split";
import type { SessionInfo, WindowInfo } from "../src/shared/protocol";

const win = (id: string, active = false): WindowInfo => ({ id, index: Number(id.slice(1)), name: id, active, panes: 1 });
const session = (name: string, windows: WindowInfo[]): SessionInfo => ({ name, id: `$${name}`, attached: 1, windows });

describe("dropSide", () => {
  const rect = { left: 100, width: 800 };

  test("is the half under the pointer", () => {
    expect(dropSide(rect, 120)).toBe("left");
    expect(dropSide(rect, 880)).toBe("right");
  });

  test("follows the divider once split, not the middle", () => {
    // Divider at 30%: x = 400 is right of it.
    expect(dropSide(rect, 400, 0.3)).toBe("right");
    expect(dropSide(rect, 300, 0.3)).toBe("left");
  });
});

describe("dropPlan", () => {
  test("a tab dropped on an unsplit terminal opens beside, on the side it landed", () => {
    expect(dropPlan(null, "@1", "@2", "right")).toEqual({ kind: "beside", windowId: "@2", side: "right" });
    expect(dropPlan(null, "@1", "@2", "left")).toEqual({ kind: "beside", windowId: "@2", side: "left" });
  });

  test("the tab already on screen has nothing to split with", () => {
    expect(dropPlan(null, "@1", "@1", "right")).toEqual({ kind: "none" });
  });

  describe("once split", () => {
    const split = { windowId: "@2", side: "right" as const };

    test("a third tab on the beside pane replaces what it shows", () => {
      expect(dropPlan(split, "@1", "@3", "right")).toEqual({ kind: "beside", windowId: "@3", side: "right" });
    });

    test("a third tab on the main pane is shown there", () => {
      expect(dropPlan(split, "@1", "@3", "left")).toEqual({ kind: "main", windowId: "@3" });
    });

    test("either shown tab dropped on the other side swaps the panes", () => {
      expect(dropPlan(split, "@1", "@2", "left")).toEqual({ kind: "swap" });
      expect(dropPlan(split, "@1", "@1", "right")).toEqual({ kind: "swap" });
    });

    test("a shown tab dropped where it already is does nothing", () => {
      expect(dropPlan(split, "@1", "@2", "right")).toEqual({ kind: "none" });
      expect(dropPlan(split, "@1", "@1", "left")).toEqual({ kind: "none" });
    });
  });
});

describe("splitAfter", () => {
  const split = { session: "s", windowId: "@2", side: "right" as const };

  test("survives a state that still has both windows apart", () => {
    const sessions = [session("s", [win("@1", true), win("@2")])];
    expect(splitAfter(split, sessions, "s")).toEqual(split);
  });

  test("closes when the main pane moves to another session", () => {
    const sessions = [session("s", [win("@1", true), win("@2")]), session("t", [win("@9", true)])];
    expect(splitAfter(split, sessions, "t")).toBeNull();
  });

  test("closes when the beside window is gone", () => {
    expect(splitAfter(split, [session("s", [win("@1", true)])], "s")).toBeNull();
  });

  test("closes when the main pane ends up on the beside window", () => {
    // tmux keys in the main pane (C-b n) can walk it onto the other pane's window.
    expect(splitAfter(split, [session("s", [win("@1"), win("@2", true)])], "s")).toBeNull();
  });

  test("closes when the session is gone", () => {
    expect(splitAfter(split, [], "s")).toBeNull();
  });
});
