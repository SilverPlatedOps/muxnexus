import type { ConversationInfo, UsageSource, WindowInfo } from "../shared/protocol";
import { bar, formatReset, kindLabel } from "./usage";

/**
 * "Move to...": carry the conversation a tab holds to another account.
 *
 * The modal asks two questions in one screen -- how to carry it, and where to --
 * because the answer to the second depends on the cost of the first. A resume
 * re-reads the whole transcript once on arrival, so moving a large conversation
 * to an account that is nearly spent defeats the move; the quota bars sit beside
 * the targets so that is visible before the click rather than after it.
 *
 * Only Resume is built. Hand off (summarise, carry a file, start fresh) is shown
 * disabled rather than hidden: it is half of the design and its absence is worth
 * stating on screen.
 */

export interface MoveActions {
  moveTo(windowId: string, profile: string): void;
}

/** A target account, as the modal lists it. */
export interface Target {
  label: string;
  /** Percent of the short window spent, when the account reports one. */
  percent?: number;
  resetsAt?: string;
  tone?: string;
  /** This is the account the conversation is already on. */
  here: boolean;
}

const SHORT = "5h";

/**
 * The quota panel's own rows, reduced to what the picker needs. Sources the
 * panel shows but that are not Claude profiles (a foreign CLI reporting usage)
 * are left out: resuming a Claude transcript on one is not a thing that exists.
 */
export function targets(sources: readonly UsageSource[], profiles: readonly string[], on?: string): Target[] {
  return profiles.map((label) => {
    const src = sources.find((s) => s.label === label);
    // Found through the short-window label rather than a key: providers name it
    // differently (`session`, `rolling`), as the quota panel already handles.
    const w = src?.windows.find((x) => kindLabel(x.kind) === SHORT) ?? src?.windows[0];
    return {
      label,
      ...(w ? { percent: w.percent, tone: tone(w.percent) } : {}),
      ...(w?.resetsAt ? { resetsAt: w.resetsAt } : {}),
      here: label === on,
    };
  });
}

/** The provider publishes no budget, so this is the panel's own banding, not a number. */
function tone(percent: number): string | undefined {
  if (percent >= 100) return "critical";
  if (percent >= 80) return "warning";
  return undefined;
}

/**
 * Which target the modal lands on: the first account that is neither the one we
 * are already on nor out of room. Falling back to the first other account means
 * the keyboard default is never "nowhere" when every account is spent.
 */
export function defaultTarget(list: readonly Target[]): string | null {
  const others = list.filter((t) => !t.here);
  return (others.find((t) => (t.percent ?? 0) < 100) ?? others[0])?.label ?? null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Bytes as the transcript's weight. Honest where a token count would be a guess. */
export function weigh(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / 1_000_000;
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB transcript` : `${Math.round(bytes / 1000)} KB transcript`;
}

export function openMove(
  host: HTMLElement,
  w: WindowInfo,
  conversation: ConversationInfo,
  list: readonly Target[],
  actions: MoveActions,
  now: number,
  bytes?: number,
): void {
  const back = el("div", "modal-back");
  const box = el("div", "move");

  const head = el("div", "move-head");
  head.append(el("span", "move-title", w.customName ?? w.label ?? w.name));
  const weight = weigh(bytes);
  head.append(el("span", "move-sub", [w.agent?.profile ? `on ${w.agent.profile}` : null, weight]
    .filter(Boolean).join(" · ")));
  box.append(head);

  box.append(el("div", "move-cap", "CARRY"));
  const carry = el("div", "move-carry");
  const resume = el("div", "move-opt sel");
  resume.append(el("span", "move-opt-name", "Resume"));
  resume.append(el("span", "move-opt-note", "the whole conversation, re-read once on arrival"));
  const hand = el("div", "move-opt off");
  hand.append(el("span", "move-opt-name", "Hand off"));
  hand.append(el("span", "move-opt-note", "summarise into a file — not built yet"));
  carry.append(resume, hand);
  box.append(carry);

  box.append(el("div", "move-cap", "TO"));
  const pick = defaultTarget(list);
  for (const t of list) {
    const row = el("div", `urow${t.here ? " off" : ""}${t.label === pick ? " pick" : ""}`);
    row.append(el("span", "ucaret", t.label === pick ? "▸" : ""));
    row.append(el("span", "uname", t.label));
    if (t.percent === undefined) {
      row.append(el("span", "ustat", "no quota reported"));
    } else {
      row.append(el("span", "ukind", SHORT));
      const b = bar(t.percent);
      const meter = el("span", "umeter");
      meter.append(el("span", `ufill${t.tone ? " " + t.tone : ""}`, b.fill));
      meter.append(el("span", "utrack", b.track));
      row.append(meter);
      row.append(el("span", "upct", `${Math.round(t.percent)}%`));
      row.append(el("span", "ureset", formatReset(t.resetsAt, now)));
    }
    if (t.here) row.append(el("span", "ustat", "here"));
    if (!t.here) {
      row.onclick = () => { close(); actions.moveTo(w.id, t.label); };
    }
    box.append(row);
  }

  // Said once, plainly: the transcript is read by the account it moves to, and
  // the conversation it started in keeps its own copy.
  box.append(el("div", "move-foot",
    "Types a resume into this tab's shell. Quit the agent there first — the original stays put."));

  back.append(box);
  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener("keydown", function esc(e) {
    if (e.key !== "Escape") return;
    close();
    document.removeEventListener("keydown", esc);
  });
  host.append(back);
}
