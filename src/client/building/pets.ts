/**
 * What a pet does next, as a plan: where to go and what to do there. Pure, so
 * the rules are tested here; the view walks the pet there, by lift when the
 * place is on another floor. Pets are decor that points at real things: the
 * dog keeps whoever has waited longest company, the cat visits whoever has
 * been idle longest. Neither ever means more than that.
 */

export type PetKind = "cat" | "dog";
/** A spot on a floor: the floor's key and an x in floor pixels. */
export interface PetPlace { floor: string; x: number }
export interface PetWorld {
  /** The floors a pet may walk, with how wide each is. */
  floors: { key: string; width: number }[];
  bowl: PetPlace;
  bed: PetPlace;
  /** The desk of whoever has waited longest, if anyone waits. */
  longestWait: PetPlace | null;
  /** The desk of whoever has been idle longest, if anyone is idle. */
  longestIdle: PetPlace | null;
}
export type PetAct = "sit" | "eat" | "nap" | "visit";
export interface Errand { to: PetPlace; then: PetAct; stayMs: number }

/** Where a pet sits beside a desk: the dog at its left, the cat at its right. */
const BESIDE = { dog: -28, cat: 24 } as const;
const MARGIN = { left: 120, right: 60 };

export function planErrand(kind: PetKind, here: PetPlace, world: PetWorld, rand: () => number = Math.random): Errand {
  const exists = (p: PetPlace | null): p is PetPlace => !!p && world.floors.some((f) => f.key === p.floor);
  const floor = world.floors.find((f) => f.key === here.floor) ?? world.floors[0];
  const wander = (): Errand => {
    const width = floor?.width ?? MARGIN.left + MARGIN.right;
    const x = Math.round(MARGIN.left + rand() * Math.max(0, width - MARGIN.left - MARGIN.right));
    return { to: { floor: floor?.key ?? here.floor, x }, then: "sit", stayMs: 8_000 };
  };
  const r = rand();
  if (kind === "dog") {
    if (exists(world.longestWait)) {
      return { to: { floor: world.longestWait.floor, x: world.longestWait.x + BESIDE.dog }, then: "sit", stayMs: 20_000 };
    }
    if (r < 0.3 && exists(world.bowl)) return { to: { floor: world.bowl.floor, x: world.bowl.x - 20 }, then: "eat", stayMs: 6_000 };
    return wander();
  }
  if (r < 0.35 && exists(world.bed)) return { to: world.bed, then: "nap", stayMs: 25_000 };
  if (r < 0.55 && exists(world.bowl)) return { to: { floor: world.bowl.floor, x: world.bowl.x - 20 }, then: "eat", stayMs: 6_000 };
  if (r < 0.75 && exists(world.longestIdle)) {
    return { to: { floor: world.longestIdle.floor, x: world.longestIdle.x + BESIDE.cat }, then: "visit", stayMs: 15_000 };
  }
  return wander();
}
