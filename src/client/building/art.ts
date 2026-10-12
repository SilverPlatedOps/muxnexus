import typing from "./art/seated-typing.png";
import handUp from "./art/seated-hand-up.png";
import calm from "./art/seated-calm.png";
import asleep from "./art/seated-asleep.png";
import ghost from "./art/seated-ghost.png";
import away from "./art/walk-cup.png";
import deskStudy from "./art/desk-study.png";
import deskOffice from "./art/desk-office.png";
import deskWar from "./art/desk-war.png";
import officeL from "./art/rooms/office-left.png";
import officeC from "./art/rooms/office-centre.png";
import officeR from "./art/rooms/office-right.png";
import officeF from "./art/rooms/office-fill.png";
import warL from "./art/rooms/war-left.png";
import warC from "./art/rooms/war-centre.png";
import warR from "./art/rooms/war-right.png";
import warF from "./art/rooms/war-fill.png";
import studyL from "./art/rooms/study-left.png";
import studyC from "./art/rooms/study-centre.png";
import studyR from "./art/rooms/study-right.png";
import studyF from "./art/rooms/study-fill.png";
import loungeL from "./art/rooms/lounge-left.png";
import loungeC from "./art/rooms/lounge-centre.png";
import loungeR from "./art/rooms/lounge-right.png";
import loungeF from "./art/rooms/lounge-fill.png";
import storageL from "./art/rooms/storage-left.png";
import storageC from "./art/rooms/storage-centre.png";
import storageR from "./art/rooms/storage-right.png";
import storageF from "./art/rooms/storage-fill.png";
import sky from "./art/sky.png";
import lift from "./art/lift.png";
import catSleep from "./art/cat-sleep.png";
import catStretch from "./art/cat-stretch.png";
import dogSit from "./art/dog-sit.png";
import type { Pose, RoomType } from "./derive";

/** Imported rather than named in CSS: CSS would inline them into the page's stylesheet. */
export const POSE_ART: Record<Pose, string> = { "hand-up": handUp, calm, typing, away, asleep, ghost };

/**
 * A room in four pieces: its two ends and its centrepiece stay put, and a plain
 * strip of wall fills between them, so a floor of any width keeps its features once.
 */
export const ROOM_ART: Record<RoomType, { left: string; centre: string; right: string; fill: string }> = {
  office: { left: officeL, centre: officeC, right: officeR, fill: officeF },
  // The glass office is the vault's alone; here it falls back to the open office.
  glass: { left: officeL, centre: officeC, right: officeR, fill: officeF },
  war: { left: warL, centre: warC, right: warR, fill: warF },
  study: { left: studyL, centre: studyC, right: studyR, fill: studyF },
  lounge: { left: loungeL, centre: loungeC, right: loungeR, fill: loungeF },
  storage: { left: storageL, centre: storageC, right: storageR, fill: storageF },
};

export const DESK_ART: Record<RoomType, string> = { office: deskOffice, glass: deskOffice, war: deskWar, study: deskStudy, lounge: deskOffice, storage: deskStudy };

export const SKY_ART = sky;
export const LIFT_ART = lift;
export const PET_ART = { catSleep, catStretch, dogSit };
