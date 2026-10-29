// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import roomOffice from "./art/vault/room-office.png";
import roomGlass from "./art/vault/room-glass.png";
import roomWar from "./art/vault/room-war.png";
import roomStudy from "./art/vault/room-study.png";
import roomLounge from "./art/vault/room-lounge.png";
import roomStorage from "./art/vault/room-storage.png";
import skyDay from "./art/vault/sky-day.png";
import skyDusk from "./art/vault/sky-dusk.png";
import bowlFood from "./art/vault/bowl-food.png";
import bowlWater from "./art/vault/bowl-water.png";
import catBed from "./art/vault/cat-bed.png";
import switchOn from "./art/vault/switch-on.png";
import switchOff from "./art/vault/switch-off.png";
import catWalk from "./art/cat-walk.png";
import catSit from "./art/cat-sit.png";
import dogWalk from "./art/dog-walk.png";
import dogLie from "./art/dog-lie.png";
import bend from "./art/bend.png";
import { DESK_ART, LIFT_ART, PET_ART, POSE_ART, SKY_ART } from "./art";
import type { RoomType } from "./derive";
import type { SkyPhase } from "./sky";

/**
 * The vault's pictures. Rooms have see-through window glass, so whatever is
 * outside -- the real time of day, the chosen weather -- shows through them.
 * A room picture is 663×200 and is laid along a floor in four pieces: its left
 * and right ends, a centrepiece (the windows), and a plain strip of wall that
 * repeats to fill the gaps. The numbers are x ranges in the picture.
 */
export interface RoomCut { left: number; centre: [number, number]; right: number; fill: [number, number] }

export const ROOM_PICTURE: Record<RoomType, { url: string; cut: RoomCut }> = {
  office: { url: roomOffice, cut: { left: 160, centre: [165, 495], right: 500, fill: [488, 540] } },
  // A wall of glass: one pane repeats along the floor, so the outside fills the room.
  glass: { url: roomGlass, cut: { left: 158, centre: [158, 516], right: 516, fill: [158, 219] } },
  war: { url: roomWar, cut: { left: 250, centre: [262, 500], right: 500, fill: [244, 268] } },
  study: { url: roomStudy, cut: { left: 243, centre: [244, 490], right: 496, fill: [490, 512] } },
  lounge: { url: roomLounge, cut: { left: 158, centre: [158, 492], right: 492, fill: [492, 548] } },
  storage: { url: roomStorage, cut: { left: 140, centre: [140, 520], right: 520, fill: [505, 530] } },
};

export const SKY_PICTURE: Record<SkyPhase, string> = { night: SKY_ART, day: skyDay, dusk: skyDusk, dawn: skyDusk };

export const PROP_PICTURE = { bowlFood, bowlWater, catBed, switchOn, switchOff, lift: LIFT_ART };

export const PET_PICTURE = {
  cat: { walk: catWalk, sit: catSit, nap: PET_ART.catSleep, stretch: PET_ART.catStretch },
  dog: { walk: dogWalk, sit: PET_ART.dogSit, lie: dogLie },
};

export const PERSON_PICTURE = { ...POSE_ART, bend };
export { DESK_ART };
