import { describe, expect, test } from "bun:test";
import { crumbParts } from "../src/client/labels";

describe("crumbParts", () => {
  test("a tagged name reads as its group, then itself", () => {
    expect(crumbParts("[Personal] Private")).toEqual({ group: "Personal", name: "Private" });
  });

  test("an untagged name is all name", () => {
    expect(crumbParts("scratch")).toEqual({ group: null, name: "scratch" });
  });

  test("a tag with nothing after it stays whole, rather than reading as a group of nothing", () => {
    expect(crumbParts("[Work]")).toEqual({ group: null, name: "[Work]" });
  });
});
