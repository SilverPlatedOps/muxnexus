// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

/**
 * Where everything stands in the vault, in world pixels: floors stacked from
 * the roof down, a lift shaft on the left, desks in slots along each floor.
 * Every floor is as wide as the most crowded one, so the building is one
 * rectangle the camera can pan over, as in Fallout Shelter.
 */

export const VAULT = {
  roof: 22,
  roomH: 180,
  slab: 14,
  ground: 36,
  wall: 10,
  liftW: 84,
  /** Room left of the first desk: the plate above, the room's left props behind. */
  leftPad: 150,
  slot: 150,
  /** Room right of the last desk: the bowls and the cat's bed, the room's right props. */
  rightPad: 280,
  minRoomW: 1200,
} as const;

export interface LaidFloor<K extends string = string> { key: string; kind: K; y: number; desks: { id: string; x: number }[] }
export interface VaultLayout<K extends string = string> {
  width: number;
  height: number;
  shaft: { x: number; w: number };
  room: { x: number; w: number };
  floors: LaidFloor<K>[];
}

export function layoutVault<K extends string>(floors: readonly { key: string; kind: K; people: readonly { id: string }[] }[]): VaultLayout<K> {
  const most = Math.max(0, ...floors.map((f) => f.people.length));
  const roomW = Math.max(VAULT.minRoomW, VAULT.leftPad + most * VAULT.slot + VAULT.rightPad);
  const roomX = VAULT.wall + VAULT.liftW + VAULT.wall;
  return {
    width: roomX + roomW + VAULT.wall,
    height: VAULT.roof + floors.length * (VAULT.roomH + VAULT.slab) + VAULT.ground,
    shaft: { x: VAULT.wall, w: VAULT.liftW },
    room: { x: roomX, w: roomW },
    floors: floors.map((f, i) => ({
      key: f.key,
      kind: f.kind,
      y: VAULT.roof + i * (VAULT.roomH + VAULT.slab),
      desks: f.people.map((p, j) => ({ id: p.id, x: roomX + VAULT.leftPad + j * VAULT.slot + VAULT.slot / 2 })),
    })),
  };
}

const STROLL_MS = 14_000;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** The idle stroll, as an offset and a facing for a moment in its loop: out across the desk front, a sip, back. */
export function strollAt(ms: number): { dx: number; faceRight: boolean; walking: boolean } {
  const t = (((ms % STROLL_MS) + STROLL_MS) % STROLL_MS) / STROLL_MS;
  if (t < 0.14) return { dx: 0, faceRight: false, walking: false };
  if (t < 0.44) return { dx: -88 * ease((t - 0.14) / 0.3), faceRight: false, walking: true };
  if (t < 0.62) return { dx: -88, faceRight: true, walking: false };
  if (t < 0.9) return { dx: -88 + 88 * ease((t - 0.62) / 0.28), faceRight: true, walking: true };
  return { dx: 0, faceRight: false, walking: false };
}
