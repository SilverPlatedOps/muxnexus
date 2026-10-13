import typing from "./art/seated-typing.png";
import handUp from "./art/seated-hand-up.png";
import calm from "./art/seated-calm.png";
import asleep from "./art/seated-asleep.png";
import ghost from "./art/seated-ghost.png";
import away from "./art/walk-cup.png";
import deskStudy from "./art/desk-study.png";
import deskOffice from "./art/desk-office.png";
import deskWar from "./art/desk-war.png";
import sky from "./art/sky.png";
import lift from "./art/lift.png";
import catSleep from "./art/cat-sleep.png";
import catStretch from "./art/cat-stretch.png";
import dogSit from "./art/dog-sit.png";
import type { Pose, RoomType } from "./derive";

/** Imported rather than named in CSS: CSS would inline them into the page's stylesheet. */
export const POSE_ART: Record<Pose, string> = { "hand-up": handUp, calm, typing, away, asleep, ghost };

/** The desk a person spawns with, in their room's style; the glass office and the lounge borrow the office's. */
export const DESK_ART: Record<RoomType, string> = { office: deskOffice, glass: deskOffice, war: deskWar, study: deskStudy, lounge: deskOffice, storage: deskStudy };

export const SKY_ART = sky;
export const LIFT_ART = lift;
export const PET_ART = { catSleep, catStretch, dogSit };
