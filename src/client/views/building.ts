import type { View, ViewHost } from "../view-host";
import type { WindowRef, World } from "../world";
import { deriveBuilding, NEUTRAL, PALETTE, type Building, type Floor, type Person, type QueueEntry, type Fuel, type Sheet } from "../building/derive";
import { DESK_ART, POSE_ART, SHELL_ART } from "../building/art";
import { formatReset } from "../usage";
import { button, el, place, setText, sweep } from "./patch";

/**
 * The building: one floor per group, one person per session, one sheet per
 * window. Read-only in this milestone -- it shows who wants you and opens
 * them; nothing moves on its own.
 */

const QUEUE_SHOWN = 4;
const SHEETS_SHOWN = 8;
const BLOCKS = 10;

const colour = (slot: number | null) => (slot === null ? NEUTRAL : PALETTE[slot % PALETTE.length]);

/** When an empty account comes back: a clock time within the day, else how long. */
function backAt(resetsAt: string, now: number): string {
  const ms = Date.parse(resetsAt) - now;
  if (ms > 0 && ms < 20 * 3600_000) return `back at ${new Date(resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return `back in ${formatReset(resetsAt, now)}`;
}

function img(cls: string): HTMLImageElement {
  const i = el("img", cls);
  i.alt = "";
  i.draggable = false;
  return i;
}

function setSrc(i: HTMLImageElement, src: string) {
  if (i.getAttribute("src") !== src) i.src = src;
}

export function createBuildingView(): View {
  let host: ViewHost | null = null;
  let world: World | null = null;
  let model: Building | null = null;
  /** The selected person, by session id; kept across pushes while the session lives. */
  let selected: string | null = null;
  let stopTick: (() => void) | null = null;
  let focusTaken = false;

  const root = el("div", "bld");
  const hud = el("div", "bld-hud");
  const tower = el("div", "bld-tower");
  const gen = el("div", "bld-gen");
  const floors = new Map<string, HTMLElement>();
  const desks = new Map<string, HTMLElement>();
  const pills = new Map<string, HTMLElement>();
  const fuels = new Map<string, HTMLElement>();

  const people = () => model?.floors.flatMap((f) => f.people) ?? [];
  const open = (ref: WindowRef | null) => { if (ref) host?.actions.openWindow(ref); };

  // ---- HUD: the needs-you queue ----
  const hudTitle = el("span", "bld-hud-title");
  const pillRow = el("div", "bld-pills");
  const more = el("span", "bld-more");
  hud.append(hudTitle, pillRow, more, el("span", "bld-hint", "⌘J next · ↵ open · arrows move"));

  function makePill(): HTMLElement {
    const b = button("bld-pill");
    const face = img("bld-pill-face");
    face.src = POSE_ART["hand-up"];
    b.append(face, el("span", "bld-pill-name"), el("span", "bld-pill-wait"));
    b.onclick = () => open({ session: b.dataset.session ?? "", window: b.dataset.window ?? "" });
    return b;
  }
  function patchPill(b: HTMLElement, q: QueueEntry) {
    b.dataset.session = q.ref.session;
    b.dataset.window = q.ref.window;
    const [, name, wait] = b.children;
    setText(name, q.label);
    setText(wait, q.wait);
    b.title = `${q.label} · waiting ${q.wait}`;
  }

  // ---- floors and desks ----
  function makeFloor(): HTMLElement {
    const f = el("section", "bld-floor");
    const plate = el("div", "bld-plate");
    plate.append(el("b"), el("span"));
    const room = el("div", "bld-room");
    room.style.backgroundImage = `url("${SHELL_ART}")`;
    room.append(el("div", "bld-row"));
    f.append(el("div", "bld-lift"), plate, room);
    return f;
  }

  function makeDesk(): HTMLElement {
    const d = button("bld-desk");
    d.tabIndex = -1;
    const sheets = el("div", "bld-sheets");
    const tag = el("div", "bld-tag");
    tag.append(el("b"), el("span", "bld-status"), el("span", "bld-jobs"));
    const deskArt = img("bld-desk-art");
    deskArt.src = DESK_ART;
    d.append(el("div", "bld-light"), img("bld-person"), deskArt, el("div", "bld-laptop"), sheets, tag);
    d.onclick = () => { selected = d.dataset.session ?? null; open(people().find((p) => p.id === selected)?.target ?? null); };
    d.onfocus = () => { selected = d.dataset.session ?? null; paintSelection(); };
    return d;
  }

  function patchSheets(box: HTMLElement, sheets: readonly Sheet[]) {
    // Flagged sheet on top of the pile: drawn last.
    const order = [...sheets.filter((s) => !s.flag), ...sheets.filter((s) => s.flag)];
    const shown = order.slice(-SHEETS_SHOWN);
    while (box.children.length > shown.length) box.lastElementChild!.remove();
    while (box.children.length < shown.length) box.append(el("i", "bld-sheet"));
    shown.forEach((s, i) => {
      const e = box.children[i] as HTMLElement;
      const cls = `bld-sheet${s.flag ? " flag" : ""}${s.dashed ? " dashed" : ""}${s.amber ? " amber" : ""}`;
      if (e.className !== cls) e.className = cls;
      const c = colour(s.slot);
      if (e.style.getPropertyValue("--c") !== c) e.style.setProperty("--c", c);
      e.title = `${s.name} · ${s.account ?? "no account"} · ${s.state}`;
    });
    box.dataset.more = sheets.length > SHEETS_SHOWN ? `+${sheets.length - SHEETS_SHOWN}` : "";
  }

  function patchDesk(d: HTMLElement, p: Person) {
    d.dataset.session = p.id;
    d.dataset.state = p.state;
    d.dataset.pose = p.pose;
    d.classList.toggle("current", p.current);
    if (d.getAttribute("aria-label") !== p.alt) d.setAttribute("aria-label", p.alt);
    const person = d.querySelector<HTMLImageElement>(".bld-person")!;
    setSrc(person, POSE_ART[p.pose]);
    patchSheets(d.querySelector<HTMLElement>(".bld-sheets")!, p.sheets);
    const [name, status, jobs] = d.querySelector(".bld-tag")!.children;
    setText(name, p.label);
    setText(status, p.status);
    setText(jobs, p.jobs);
  }

  function patchFloor(f: HTMLElement, fl: Floor, seenD: Set<string>) {
    f.dataset.kind = fl.kind;
    f.dataset.floor = fl.key;
    const here = fl.people.some((p) => p.current);
    f.classList.toggle("here", here);
    const [name, meta] = f.querySelector(".bld-plate")!.children;
    setText(name, fl.name);
    const n = fl.people.length;
    const count = fl.kind === "basement" ? `${n} ${n === 1 ? "desk" : "desks"} under sheets` : `${n} ${n === 1 ? "person" : "people"}`;
    setText(meta, here ? `${count} · you're here` : count);
    place(f.querySelector<HTMLElement>(".bld-row")!, fl.people, (p) => p.id, desks, seenD, makeDesk, patchDesk);
  }

  // ---- generator ----
  function makeFuel(): HTMLElement {
    const r = el("div", "bld-fuel");
    const blocks = el("span", "bld-blocks");
    for (let i = 0; i < BLOCKS; i++) blocks.append(el("i"));
    r.append(el("b", "bld-fuel-name"), blocks, el("span", "bld-fuel-text"));
    return r;
  }
  function patchFuel(r: HTMLElement, f: Fuel, now: number) {
    r.dataset.level = f.signedOut ? "out" : f.level;
    r.style.setProperty("--c", colour(f.slot));
    const [name, blocks, text] = r.children;
    setText(name, f.label);
    const on = f.percent === null ? 0 : Math.min(BLOCKS, Math.round(f.percent / 10));
    [...blocks.children].forEach((b, i) => {
      const cls = i < on ? (f.level !== "ok" && i === on - 1 ? "on amber" : "on") : "";
      if (b.className !== cls) b.className = cls;
    });
    const reset = f.resetsAt ? formatReset(f.resetsAt, now) : "";
    setText(text, f.signedOut ? "signed out"
      : f.percent === null ? "no reading"
      : f.level === "empty" ? `empty${f.resetsAt ? ` · ${backAt(f.resetsAt, now)}` : ""}`
      : `${f.percent}%${reset ? ` · ${reset}` : ""}`);
  }

  // ---- selection and keys ----
  function paintSelection() {
    for (const [id, d] of desks) {
      const on = id === selected;
      d.classList.toggle("selected", on);
      d.tabIndex = on ? 0 : -1;
    }
  }

  function move(dx: number, dy: number) {
    if (!model) return;
    const rows = model.floors.map((f) => f.people).filter((r) => r.length);
    let fi = rows.findIndex((r) => r.some((p) => p.id === selected));
    let pi = fi < 0 ? 0 : rows[fi].findIndex((p) => p.id === selected);
    if (fi < 0) fi = 0;
    if (!rows.length) return;
    if (dy) { fi = Math.max(0, Math.min(rows.length - 1, fi + dy)); pi = Math.min(pi, rows[fi].length - 1); }
    if (dx) pi = Math.max(0, Math.min(rows[fi].length - 1, pi + dx));
    selected = rows[fi][pi].id;
    paintSelection();
    const d = desks.get(selected);
    d?.focus({ preventScroll: true });
    d?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  root.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key in step) {
      e.preventDefault();
      move(...step[e.key]);
    }
    // Enter and Space on a focused desk are its click.
  });

  // ---- fit: every floor on screen, down to 60 %, before the tower scrolls ----
  const FLOOR_PX = 190; // a floor's height less the slab it shares with the next
  let floorCount = 0;
  function fit() {
    if (!floorCount) return;
    const room = tower.clientHeight - 20;
    const z = Math.max(0.6, Math.min(1, room / (floorCount * FLOOR_PX + 10)));
    const v = z.toFixed(3);
    if (tower.style.getPropertyValue("--z") !== v) tower.style.setProperty("--z", v);
  }
  const resize = new ResizeObserver(fit);

  // ---- draw ----
  function draw() {
    if (!host) return;
    if (!world) {
      if (!tower.querySelector(".bld-note")) tower.replaceChildren(el("p", "bld-note", "Waiting for the first state…"));
      return;
    }
    const now = host.now();
    model = deriveBuilding(world, now);
    const all = people();
    if (!all.some((p) => p.id === selected)) selected = (all.find((p) => p.current) ?? all[0])?.id ?? null;

    setText(hudTitle, `needs you · ${model.queue.length}`);
    hud.classList.toggle("calm", model.queue.length === 0);
    const seenQ = new Set<string>();
    place(pillRow, model.queue.slice(0, QUEUE_SHOWN), (q) => q.ref.window, pills, seenQ, makePill, patchPill);
    sweep(pills, seenQ);
    setText(more, model.queue.length > QUEUE_SHOWN ? `+${model.queue.length - QUEUE_SHOWN}` : "");

    const seenF = new Set<string>();
    const seenD = new Set<string>();
    place(tower, model.floors, (f) => `${f.kind}:${f.key}`, floors, seenF, makeFloor, (f, fl) => patchFloor(f, fl, seenD));
    sweep(floors, seenF);
    sweep(desks, seenD);
    if (floorCount !== model.floors.length) {
      floorCount = model.floors.length;
      fit();
    }

    const seenG = new Set<string>();
    const fuelRow = gen.querySelector<HTMLElement>(".bld-fuels")!;
    place(fuelRow, model.fuel, (f) => `${f.provider}:${f.label}`, fuels, seenG, makeFuel, (r, f) => patchFuel(r, f, now));
    sweep(fuels, seenG);
    paintSelection();
    // Arrows need focus here: taken once, when the first desks appear, and only from nobody --
    // never from the search or a note, and never again on a later tick.
    if (!focusTaken && desks.size) {
      focusTaken = true;
      const active = document.activeElement;
      if (!active || active === document.body) desks.get(selected ?? "")?.focus({ preventScroll: true });
    }
  }

  return {
    mount(h) {
      host = h;
      gen.replaceChildren(el("span", "bld-gen-title", "generator"), el("div", "bld-fuels"));
      root.tabIndex = -1;
      root.replaceChildren(hud, tower, gen);
      h.root.replaceChildren(root);
      resize.observe(tower);
      stopTick = h.tick(1, draw);
      draw();
    },
    update(next) {
      world = next;
      draw();
    },
    reveal(ref) {
      open(ref);
    },
    unmount() {
      stopTick?.();
      stopTick = null;
      resize.disconnect();
      host = null;
      floorCount = 0;
      focusTaken = false;
      floors.clear();
      desks.clear();
      pills.clear();
      fuels.clear();
    },
  };
}
