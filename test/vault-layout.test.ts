import { describe, expect, test } from "bun:test";
import { layoutVault, strollAt, VAULT } from "../src/client/building/layout";

const floor = (key: string, n: number, kind: "group" | "lobby" | "basement" = "group") =>
  ({ key, kind, people: Array.from({ length: n }, (_, i) => ({ id: `${key}${i}` })) });

describe("layoutVault", () => {
  test("floors stack from the roof down, each a room tall plus its slab", () => {
    const l = layoutVault([floor("a", 1), floor("b", 2)]);
    expect(l.floors.map((f) => [f.key, f.y])).toEqual([["a", VAULT.roof], ["b", VAULT.roof + VAULT.roomH + VAULT.slab]]);
    expect(l.height).toBe(VAULT.roof + 2 * (VAULT.roomH + VAULT.slab) + VAULT.ground);
  });

  test("desks sit in slots after the plate, left to right in spawn order", () => {
    const l = layoutVault([floor("a", 2)]);
    const x0 = l.room.x + VAULT.leftPad + VAULT.slot / 2;
    expect(l.floors[0].desks).toEqual([{ id: "a0", x: x0 }, { id: "a1", x: x0 + VAULT.slot }]);
  });

  test("every floor is as wide as the most crowded one, and never narrower than the minimum", () => {
    expect(layoutVault([floor("a", 1)]).room.w).toBe(VAULT.minRoomW);
    const wide = layoutVault([floor("a", 12), floor("b", 1)]);
    expect(wide.room.w).toBe(VAULT.leftPad + 12 * VAULT.slot + VAULT.rightPad);
    expect(wide.width).toBe(wide.room.x + wide.room.w + VAULT.wall);
  });

  test("the lift shaft runs down the left of every floor", () => {
    const l = layoutVault([floor("a", 1)]);
    expect(l.shaft).toEqual({ x: VAULT.wall, w: VAULT.liftW });
    expect(l.room.x).toBe(VAULT.wall + VAULT.liftW + VAULT.wall);
  });
});

describe("strollAt", () => {
  test("a pause, out across the desk front facing left, a sip facing back, home again", () => {
    const at = (f: number) => strollAt(f * 14_000);
    expect(at(0.05)).toEqual({ dx: 0, faceRight: false, walking: false });
    expect(at(0.3).walking).toBe(true);
    expect(at(0.3).faceRight).toBe(false);
    expect(at(0.5)).toEqual({ dx: -88, faceRight: true, walking: false });
    expect(at(0.75).faceRight).toBe(true);
    expect(at(0.95)).toEqual({ dx: 0, faceRight: false, walking: false });
    expect(strollAt(-1000)).toEqual(strollAt(13_000));
  });
});
