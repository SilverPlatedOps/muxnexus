import { describe, expect, test } from "bun:test";
import { splitCategory } from "../src/shared/category";
import { groupSessions, mergeOrder, moveWithinBlocks, visualOrder } from "../src/client/groups";

describe("splitCategory", () => {
  test("reads the tag a name starts with", () => {
    expect(splitCategory("[Work] Banner Migration")).toEqual({ category: "Work", rest: "Banner Migration" });
    expect(splitCategory("[Project]JKB")).toEqual({ category: "Project", rest: "JKB" });
  });

  test("a name that is only a tag shows its category", () => {
    expect(splitCategory("[Personal]")).toEqual({ category: "Personal", rest: "Personal" });
  });

  test("no tag, or an empty one, is no category", () => {
    expect(splitCategory("Debug")).toBeNull();
    expect(splitCategory("a [b] c")).toBeNull();
    expect(splitCategory("[] x")).toBeNull();
  });
});

describe("groupSessions", () => {
  const id = (s: string) => s;

  test("gathers a category where its first session sits", () => {
    const blocks = groupSessions(["[Work] A", "Debug", "[Personal]", "[work] B"], id);
    expect(blocks).toEqual([
      { category: "Work", sessions: ["[Work] A", "[work] B"] },
      { category: null, sessions: ["Debug"] },
      { category: "Personal", sessions: ["[Personal]"] },
    ]);
    expect(visualOrder(["[Work] A", "Debug", "[Personal]", "[work] B"], id))
      .toEqual(["[Work] A", "[work] B", "Debug", "[Personal]"]);
  });
});

describe("mergeOrder", () => {
  test("hidden sessions keep their slots; the dragged ones fill the rest", () => {
    // [Work] is collapsed, so only P and D were drawn, and D was dragged above P.
    const full = ["W1", "W2", "P", "D"];
    expect(mergeOrder(full, ["P", "D"], ["D", "P"])).toEqual(["W1", "W2", "D", "P"]);
  });

  test("with everything visible it is the dragged order", () => {
    expect(mergeOrder(["a", "b", "c"], ["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });
});

describe("moveWithinBlocks", () => {
  const id = (s: string) => s;
  const blocks = groupSessions(["[W] a", "[W] b", "D", "[P] c"], id);

  test("a grouped session trades places inside its group only", () => {
    expect(moveWithinBlocks(blocks, id, "[W] b", -1)).toEqual(["[W] b", "[W] a", "D", "[P] c"]);
    expect(moveWithinBlocks(blocks, id, "[W] b", 1)).toBeNull();
  });

  test("an untagged session moves past a whole block", () => {
    expect(moveWithinBlocks(blocks, id, "D", -1)).toEqual(["D", "[W] a", "[W] b", "[P] c"]);
    expect(moveWithinBlocks(blocks, id, "D", 1)).toEqual(["[W] a", "[W] b", "[P] c", "D"]);
  });
});
