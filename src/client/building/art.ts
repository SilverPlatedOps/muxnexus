import shell from "./art/room-shell-study.png";
import desk from "./art/desk-study.png";
import typing from "./art/seated-typing.png";
import handUp from "./art/seated-hand-up.png";
import calm from "./art/seated-calm.png";
import asleep from "./art/seated-asleep.png";
import ghost from "./art/seated-ghost.png";
import away from "./art/walk-cup.png";
import type { Pose } from "./derive";

/** Imported rather than named in CSS: CSS would inline them into the page's stylesheet. */
export const SHELL_ART = shell;
export const DESK_ART = desk;
export const POSE_ART: Record<Pose, string> = { "hand-up": handUp, calm, typing, away, asleep, ghost };
