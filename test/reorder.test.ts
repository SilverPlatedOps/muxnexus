import { describe, expect, test } from "bun:test";
import { applyPendingOrder, dropIndex, moveItem, orderSatisfied } from "../src/client/reorder";

const rows = (n: number, h = 40) => Array.from({ length: n }, (_, i) => ({ top: i * h, height: h }));

describe("dropIndex", () => {
  test("above the first row's midpoint inserts at the top", () => {
    expect(dropIndex(rows(3), 0)).toBe(0);
    expect(dropIndex(rows(3), 19)).toBe(0);
  });

  test("past a row's midpoint inserts after it", () => {
    expect(dropIndex(rows(3), 21)).toBe(1);
    expect(dropIndex(rows(3), 61)).toBe(2);
  });

  test("below the last row inserts at the end", () => {
    expect(dropIndex(rows(3), 500)).toBe(3);
  });

  test("an empty list only has one place to drop", () => {
    expect(dropIndex([], 123)).toBe(0);
  });

  test("copes with rows of differing heights", () => {
    const uneven = [{ top: 0, height: 20 }, { top: 20, height: 100 }, { top: 120, height: 20 }];
    expect(dropIndex(uneven, 5)).toBe(0);
    expect(dropIndex(uneven, 50)).toBe(1); // still above the tall row's midpoint (70)
    expect(dropIndex(uneven, 80)).toBe(2);
  });
});

describe("moveItem", () => {
  test("moves an item down, accounting for its own removal", () => {
    // Dragging "a" to index 2 means "between b and c", not "after c".
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "a", "c"]);
  });

  test("moves an item up", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  test("dropping an item back where it started changes nothing", () => {
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 2)).toEqual(["a", "b", "c"]);
  });

  test("moves to the very end", () => {
    expect(moveItem(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
  });

  test("leaves the list alone for an out-of-range index", () => {
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });
});

describe("optimistic order", () => {
  const s = (name: string) => ({ name });

  test("applies the pending order to whatever the server just sent", () => {
    const got = applyPendingOrder([s("a"), s("b"), s("c")], ["c", "a", "b"]);
    expect(got.map((x) => x.name)).toEqual(["c", "a", "b"]);
  });

  test("a session that appeared meanwhile lands at the end rather than vanishing", () => {
    const got = applyPendingOrder([s("a"), s("b"), s("new")], ["b", "a"]);
    expect(got.map((x) => x.name)).toEqual(["b", "a", "new"]);
  });

  test("a session killed meanwhile is simply absent", () => {
    expect(applyPendingOrder([s("a")], ["b", "a"]).map((x) => x.name)).toEqual(["a"]);
  });

  test("no pending order leaves the server's order alone", () => {
    expect(applyPendingOrder([s("b"), s("a")], null).map((x) => x.name)).toEqual(["b", "a"]);
  });

  test("orderSatisfied is true once the server agrees, ignoring sessions that came or went", () => {
    expect(orderSatisfied([s("c"), s("a"), s("b")], ["c", "a", "b"])).toBe(true);
    expect(orderSatisfied([s("a"), s("b"), s("c")], ["c", "a", "b"])).toBe(false);
    // a killed session must not keep the pending order alive forever
    expect(orderSatisfied([s("c"), s("b")], ["c", "a", "b"])).toBe(true);
  });
});

describe("optimistic order, keyed by something other than name", () => {
  // Tabs are identified by window index, not by a name.
  const w = (index: number) => ({ index });
  const byIndex = (x: { index: number }) => String(x.index);

  test("reorders windows by index", () => {
    expect(applyPendingOrder([w(0), w(1), w(5)], ["5", "0", "1"], byIndex).map((x) => x.index)).toEqual([5, 0, 1]);
  });

  test("a window opened meanwhile goes to the end", () => {
    expect(applyPendingOrder([w(0), w(1), w(9)], ["1", "0"], byIndex).map((x) => x.index)).toEqual([1, 0, 9]);
  });

  test("orderSatisfied works on indices too", () => {
    expect(orderSatisfied([w(5), w(0)], ["5", "0"], byIndex)).toBe(true);
    expect(orderSatisfied([w(0), w(5)], ["5", "0"], byIndex)).toBe(false);
  });
});
