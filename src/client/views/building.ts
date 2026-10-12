import type { View, ViewHost } from "../view-host";
import type { WindowRef, World } from "../world";
import {
  deriveBuilding, NEUTRAL, PALETTE, ROOM_CHOICES, ROOM_LABEL, span,
  type Building, type Floor, type Fuel, type Person, type Pose, type QueueEntry, type RoomType, type Sheet,
} from "../building/derive";
import { DESK_ART, LIFT_ART, PET_ART, POSE_ART, ROOM_ART, SKY_ART } from "../building/art";
import { formatReset } from "../usage";
import { button, el, place, setText, sweep } from "./patch";

/**
 * The building: one floor per group, one person per session, one sheet per
 * window. It shows who wants you and opens them; nothing walks around yet.
 * It takes the whole window, with its own top bar, while it shows.
 */

const QUEUE_SHOWN = 4;
const SHEETS_SHOWN = 8;
const BLOCKS = 10;

const colour = (slot: number | null) => (slot === null ? NEUTRAL : PALETTE[slot % PALETTE.length]);
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** When an empty account comes back: a clock time within the day, else how long. */
function backAt(resetsAt: string, now: number): string {
  const ms = Date.parse(resetsAt) - now;
  if (ms > 0 && ms < 20 * 3600_000) return `back at ${clock(resetsAt)}`;
  return `back in ${formatReset(resetsAt, now)}`;
}

function img(cls: string, src?: string): HTMLImageElement {
  const i = el("img", cls);
  i.alt = "";
  i.draggable = false;
  if (src) i.src = src;
  return i;
}

function setSrc(i: HTMLImageElement, src: string) {
  if (i.getAttribute("src") !== src) i.src = src;
}

function setVar(e: HTMLElement, name: string, value: string) {
  if (e.style.getPropertyValue(name) !== value) e.style.setProperty(name, value);
}

/** A steady offset per person, so a room of breathing people never breathes in step. */
function phase(id: string, periodMs: number): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `${-(Math.abs(h) % periodMs)}ms`;
}

/** Show `pose` on a person's two stacked pictures: the new one fades in as the old fades out, never a pop. */
function setPose(holder: Element, pose: Pose) {
  const [a, b] = holder.children as unknown as [HTMLImageElement, HTMLImageElement];
  const on = b.classList.contains("on") ? b : a;
  // A new person appears as they are; only a change of pose fades.
  if (!on.dataset.pose) {
    on.src = POSE_ART[pose];
    on.dataset.pose = pose;
    return;
  }
  if (on.dataset.pose === pose && on.classList.contains("on")) return;
  const off = on === a ? b : a;
  if (off.dataset.pose !== pose) {
    off.src = POSE_ART[pose];
    off.dataset.pose = pose;
  }
  off.classList.add("on");
  on.classList.remove("on");
}

/** A ♥ that rises and fades: what touching a pet gets you. */
function heart(on: HTMLElement) {
  const h = el("span", "bld-heart", "♥");
  on.append(h);
  setTimeout(() => h.remove(), 700);
}

/** One job's line in the card: what it is doing and for how long, as text. */
function sheetLine(s: Sheet, now: number): string {
  const ago = s.since ? span(now - Date.parse(s.since)) : "";
  if (s.state === "working") return ago ? `typing · turn ${ago}` : "typing";
  if (s.state === "waiting") return ago ? `asked ${ago} ago` : "asked";
  if (s.state === "idle") return ago ? `idle ${ago}` : "idle";
  return "quiet · inferred";
}

function stateLine(p: Person, now: number): string {
  const ago = p.since ? span(now - Date.parse(p.since)) : "";
  const how = p.state === "ghost" ? "inferred from terminal" : "reported by agent";
  if (p.state === "waiting" && p.since) return `● waiting since ${clock(p.since)} · ${ago} · ${how}`;
  if (p.state === "working") return `● working · ${how}`;
  return `${p.status} · ${how}`;
}

export function createBuildingView(): View {
  let host: ViewHost | null = null;
  let world: World | null = null;
  let model: Building | null = null;
  /** The selected person, by session id; kept across pushes while the session lives. */
  let selected: string | null = null;
  /** The person the card is about, while it shows. */
  let carded: string | null = null;
  /** The card came from the arrows: it follows the selection, and a passing mouse hands it back. */
  let cardFromKeys = false;
  let stopTick: (() => void) | null = null;
  let focusTaken = false;

  const root = el("div", "bld");
  const hud = el("header", "bld-hud");
  const tower = el("div", "bld-tower");
  const shell = el("div", "bld-shell");
  const card = el("div", "bld-card");
  const gen = el("footer", "bld-gen");
  const floors = new Map<string, HTMLElement>();
  const desks = new Map<string, HTMLElement>();
  const pills = new Map<string, HTMLElement>();
  const fuels = new Map<string, HTMLElement>();
  tower.style.backgroundImage = `url("${SKY_ART}")`;
  tower.append(shell);

  const people = () => model?.floors.flatMap((f) => f.people) ?? [];
  const floorOf = (id: string) => model?.floors.find((f) => f.people.some((p) => p.id === id)) ?? null;
  const open = (ref: WindowRef | null) => { if (ref) host?.actions.openWindow(ref); };

  /** What the room picker remembers: a room per floor key, in this browser. */
  function rooms(): Record<string, RoomType> {
    try {
      const raw: unknown = JSON.parse(host?.prefs.get("rooms") ?? "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      // Only what the picker could have written survives: a damaged pref heals on the next pick.
      return Object.fromEntries(Object.entries(raw).filter(([, v]) => ROOM_CHOICES.includes(v as RoomType))) as Record<string, RoomType>;
    } catch {
      return {};
    }
  }

  // ---- top bar: the brand and clock, the needs-you queue, the way back ----
  const clockEl = el("span", "bld-clock");
  const brand = el("div", "bld-brand");
  brand.append(el("span", "bld-logo", "muxnexus"), clockEl);
  const queueBox = el("div", "bld-queue");
  const hudTitle = el("span", "bld-hud-title");
  const pillRow = el("div", "bld-pills");
  const more = el("span", "bld-more");
  queueBox.append(hudTitle, pillRow, more, el("kbd", undefined, "⌘J"));
  const toTerminal = button("bld-btn");
  toTerminal.append("terminal ", el("kbd", undefined, "↵"));
  toTerminal.title = "Open the selected person's terminal";
  toTerminal.onclick = () => open(people().find((p) => p.id === selected)?.target ?? null);
  const tools = el("div", "bld-tools");
  tools.append(el("span", "bld-hint", "arrows move"), toTerminal);
  hud.append(brand, queueBox, tools);

  function makePill(): HTMLElement {
    const b = button("bld-pill");
    b.append(img("bld-pill-face", POSE_ART["hand-up"]), el("span", "bld-pill-name"), el("span", "bld-pill-wait"));
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

  // ---- pets: the cat naps on a study floor; the dog sits with whoever has waited longest ----
  const cat = img("bld-cat", PET_ART.catSleep);
  cat.onmouseenter = () => setSrc(cat, PET_ART.catStretch);
  cat.onmouseleave = () => setSrc(cat, PET_ART.catSleep);
  const catBox = el("span", "bld-pet-box bld-cat-box");
  catBox.title = "the cat";
  catBox.append(cat);
  catBox.onclick = () => heart(catBox);
  const dogBox = el("span", "bld-pet-box bld-dog-box");
  dogBox.append(img("bld-dog", PET_ART.dogSit));
  dogBox.onclick = (e) => { e.stopPropagation(); heart(dogBox); };

  let trotEnd: ReturnType<typeof setTimeout> | null = null;

  function placePets(b: Building) {
    const catFloor = b.floors.find((f) => f.room === "study") ?? b.floors.find((f) => f.kind !== "basement");
    const catRoom = catFloor ? floors.get(`${catFloor.kind}:${catFloor.key}`)?.querySelector(".bld-room") ?? null : null;
    if (catRoom && catBox.parentElement !== catRoom) catRoom.append(catBox);
    if (!catRoom) catBox.remove();

    // In the room beside the desk -- not inside the desk, where touching the dog would touch the desk,
    // nor in the row, whose children are the desks alone (a stranger there gets it rebuilt, and focus lost).
    const wait = b.longestWait ? desks.get(b.longestWait) ?? null : null;
    const row = wait?.parentElement ?? null;
    const top = b.floors[0];
    const where = row?.parentElement ?? (top ? floors.get(`${top.kind}:${top.key}`)?.querySelector(".bld-room") ?? null : null);
    dogBox.classList.toggle("by-desk", !!wait);
    const left = wait && row ? `${row.offsetLeft + wait.offsetLeft - 20}px` : "";
    if (dogBox.style.left !== left) {
      // Along its own floor it trots over; to another floor it simply turns up there.
      const trots = dogBox.parentElement === where && dogBox.style.left !== "" && left !== "";
      dogBox.classList.toggle("trot", trots);
      if (trotEnd) clearTimeout(trotEnd);
      trotEnd = trots ? setTimeout(() => dogBox.classList.remove("trot"), 1400) : null;
      dogBox.style.left = left;
    }
    dogBox.title = wait ? "the dog sits with whoever has waited longest" : "the dog";
    if (where && dogBox.parentElement !== where) where.append(dogBox);
    if (!where) dogBox.remove();
  }

  // ---- floors and desks ----
  function makeFloor(): HTMLElement {
    const f = el("section", "bld-floor");
    const liftBox = el("div", "bld-lift");
    liftBox.append(img("bld-lift-car", LIFT_ART));
    const plate = el("div", "bld-plate");
    const meta = el("span", "bld-plate-meta");
    const pick = el("select", "bld-roompick");
    pick.setAttribute("aria-label", "Room type");
    for (const r of ROOM_CHOICES) {
      const o = el("option", undefined, ROOM_LABEL[r]);
      o.value = r;
      pick.append(o);
    }
    pick.onchange = () => {
      const key = f.dataset.floor;
      if (!key) return;
      host?.prefs.set("rooms", JSON.stringify({ ...rooms(), [key]: pick.value }));
      draw();
    };
    // The picker furnishes the floor; its arrows are not for moving between people.
    pick.onkeydown = (e) => e.stopPropagation();
    const line = el("span", "bld-plate-line");
    line.append(pick, meta);
    plate.append(el("b"), line);
    const room = el("div", "bld-room");
    room.append(el("div", "bld-row"));
    f.append(liftBox, plate, room);
    return f;
  }

  function makeDesk(): HTMLElement {
    const d = button("bld-desk");
    d.tabIndex = -1;
    const tag = el("div", "bld-tag");
    tag.append(el("b"), el("span", "bld-status"), el("span", "bld-jobs"));
    const person = el("span", "bld-person");
    person.append(img("bld-pose on"), img("bld-pose"));
    d.append(el("div", "bld-light"), el("span", "bld-here", "you're here"), person, img("bld-desk-art"),
      el("div", "bld-laptop"), el("div", "bld-sheets"), tag);
    d.onclick = () => {
      selected = d.dataset.session ?? null;
      open(people().find((p) => p.id === selected)?.target ?? null);
    };
    d.onfocus = () => { selected = d.dataset.session ?? null; paintSelection(); };
    d.onmouseenter = () => {
      showCard(d.dataset.session ?? null);
      lookAt(d, true);
    };
    d.onmouseleave = () => {
      showCard(cardFromKeys ? selected : null);
      lookAt(d, false);
    };
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
      setVar(e, "--c", colour(s.slot));
    });
    box.dataset.more = sheets.length > SHEETS_SHOWN ? `+${sheets.length - SHEETS_SHOWN}` : "";
  }

  /**
   * Touched, a seated person looks up at you for a moment, then goes back to
   * what they were doing. Someone away, asleep or a ghost is left be.
   */
  const looking = new Map<HTMLElement, ReturnType<typeof setTimeout> | null>();
  const LOOKS = new Set<Pose>(["typing", "hand-up", "calm"]);
  function lookAt(d: HTMLElement, on: boolean) {
    const t = looking.get(d);
    if (t) clearTimeout(t);
    if (on) looking.set(d, null);
    else looking.set(d, setTimeout(() => { looking.delete(d); posePerson(d); }, 1000));
    posePerson(d);
  }
  function posePerson(d: HTMLElement) {
    const pose = (d.dataset.pose ?? "calm") as Pose;
    setPose(d.querySelector(".bld-person")!, looking.has(d) && LOOKS.has(pose) ? "calm" : pose);
  }

  function patchDesk(d: HTMLElement, p: Person, room: RoomType) {
    d.dataset.session = p.id;
    if (!d.style.getPropertyValue("--phase")) d.style.setProperty("--phase", phase(p.id, 2800));
    d.dataset.state = p.state;
    d.dataset.pose = p.pose;
    d.classList.toggle("current", p.current);
    if (d.getAttribute("aria-label") !== p.alt) d.setAttribute("aria-label", p.alt);
    posePerson(d);
    setSrc(d.querySelector<HTMLImageElement>(".bld-desk-art")!, DESK_ART[room]);
    patchSheets(d.querySelector<HTMLElement>(".bld-sheets")!, p.sheets);
    const [name, status, jobs] = d.querySelector(".bld-tag")!.children;
    setText(name, p.label);
    setText(status, p.status);
    setText(jobs, p.jobs);
  }

  function patchFloor(f: HTMLElement, fl: Floor, seenD: Set<string>) {
    f.dataset.kind = fl.kind;
    f.dataset.floor = fl.key;
    f.dataset.room = fl.room;
    const here = fl.people.some((p) => p.current);
    f.classList.toggle("here", here);
    const roomEl = f.querySelector<HTMLElement>(".bld-room")!;
    const art = ROOM_ART[fl.room];
    setVar(roomEl, "--l", `url("${art.left}")`);
    setVar(roomEl, "--c", `url("${art.centre}")`);
    setVar(roomEl, "--r", `url("${art.right}")`);
    setVar(roomEl, "--f", `url("${art.fill}")`);
    const plate = f.querySelector(".bld-plate")!;
    setText(plate.querySelector("b")!, fl.name);
    const pick = plate.querySelector<HTMLSelectElement>(".bld-roompick")!;
    pick.hidden = fl.kind === "basement";
    if (fl.kind !== "basement" && pick.value !== fl.room) pick.value = fl.room;
    const n = fl.people.length;
    const count = fl.kind === "basement"
      ? `storage · ${n} ${n === 1 ? "desk" : "desks"} under sheets`
      : `· ${n} ${n === 1 ? "person" : "people"}`;
    setText(plate.querySelector(".bld-plate-meta")!, `${count}${here ? " · you're here" : ""}`);
    place(f.querySelector<HTMLElement>(".bld-row")!, fl.people, (p) => p.id, desks, seenD, makeDesk,
      (d, p) => patchDesk(d, p, fl.room));
    // Only idle people wander, and only one per floor at a time; the rest stand by their desks.
    const stroller = fl.kind === "basement" ? undefined : fl.people.find((p) => p.pose === "away");
    for (const p of fl.people) desks.get(p.id)?.classList.toggle("stroll", p === stroller);
  }

  // ---- the card: who this is, what each job is doing, how it is known ----
  function showCard(id: string | null) {
    carded = id;
    paintCard();
  }

  // Built once, patched in place: a card rebuilt every second flickers and jumps.
  const cardName = el("b");
  const cardWhere = el("span");
  const cardHead = el("div", "bld-card-head");
  cardHead.append(cardName, cardWhere);
  const cardLine = el("span");
  const cardJobs = el("span", "bld-card-jobs");
  const cardState = el("div", "bld-card-state");
  cardState.append(cardLine, cardJobs);
  const cardList = el("ol", "bld-card-list");
  const cardActs = el("div", "bld-card-acts");
  cardActs.append(el("kbd", undefined, "↵"), " sit with them");
  card.append(cardHead, cardState, cardList, cardActs);

  function makeJob(): HTMLElement {
    const li = el("li");
    li.append(el("kbd"), el("i", "bld-chip"), el("span", "bld-card-acct"), el("span", "bld-card-name"), el("span", "bld-card-what"));
    return li;
  }

  function paintCard() {
    const p = carded ? people().find((x) => x.id === carded) : null;
    const d = carded ? desks.get(carded) : null;
    const fl = carded ? floorOf(carded) : null;
    if (!p || !d || !fl || !host) {
      card.classList.remove("show");
      return;
    }
    const now = host.now();
    setText(cardName, p.label);
    setText(cardWhere, `${fl.name} · ${ROOM_LABEL[fl.room]}`);
    cardState.className = `bld-card-state ${p.state}`;
    setText(cardLine, stateLine(p, now));
    setText(cardJobs, p.jobs);
    while (cardList.children.length > p.sheets.length) cardList.lastElementChild!.remove();
    while (cardList.children.length < p.sheets.length) cardList.append(makeJob());
    p.sheets.forEach((s, i) => {
      const li = cardList.children[i] as HTMLElement;
      li.classList.toggle("flag", s.flag);
      const [key, chip, acct, name, what] = li.children as unknown as HTMLElement[];
      setText(key, s.n <= 9 ? `⌘${s.n}` : "");
      chip.classList.toggle("dashed", s.dashed);
      setVar(chip, "--c", colour(s.slot));
      setText(acct, s.account ?? "—");
      setText(name, s.name);
      setText(what, sheetLine(s, now));
    });
    // Placed on every paint: the desk moves when its floor scrolls or the window changes size.
    {
      // Beside the desk, flipped to its left when the right edge is near.
      const r = d.getBoundingClientRect();
      const box = root.getBoundingClientRect();
      const w = card.offsetWidth;
      const right = r.right - box.left + 8;
      const x = right + w > box.width - 8 ? r.left - box.left - w - 8 : right;
      const left = `${Math.max(8, x)}px`;
      const top = `${Math.max(8, Math.min(r.top - box.top, box.height - card.offsetHeight - 8))}px`;
      if (card.style.left !== left) card.style.left = left;
      if (card.style.top !== top) card.style.top = top;
    }
    card.classList.add("show");
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
    setVar(r, "--c", colour(f.slot));
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
    if (!rows.length) return;
    let fi = rows.findIndex((r) => r.some((p) => p.id === selected));
    let pi = fi < 0 ? 0 : rows[fi].findIndex((p) => p.id === selected);
    if (fi < 0) fi = 0;
    if (dy) { fi = Math.max(0, Math.min(rows.length - 1, fi + dy)); pi = Math.min(pi, rows[fi].length - 1); }
    if (dx) pi = Math.max(0, Math.min(rows[fi].length - 1, pi + dx));
    selected = rows[fi][pi].id;
    paintSelection();
    const d = desks.get(selected);
    d?.focus({ preventScroll: true });
    d?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: host?.reducedMotion() ? "auto" : "smooth" });
    cardFromKeys = true;
    showCard(selected);
  }

  root.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key in step) {
      e.preventDefault();
      move(...step[e.key]);
    } else if (e.key === "Escape") {
      cardFromKeys = false;
      showCard(null);
    }
    // Enter and Space on a focused desk are its click.
  });
  root.addEventListener("focusout", (e) => {
    if (root.contains(e.relatedTarget as Node | null)) return;
    cardFromKeys = false;
    showCard(null);
  });

  // ---- fit: every floor on screen, down to 60 %, before the tower scrolls ----
  const FLOOR_PX = 190; // a floor's height less the slab it shares with the next
  let floorCount = 0;
  function fit() {
    if (!floorCount) return;
    const room = tower.clientHeight - 36;
    const z = Math.max(0.6, Math.min(1, room / (floorCount * FLOOR_PX + 16)));
    setVar(tower, "--z", z.toFixed(3));
  }
  const resize = new ResizeObserver(() => { fit(); if (carded) paintCard(); });
  tower.addEventListener("scroll", () => { if (carded) paintCard(); }, { passive: true });
  shell.addEventListener("scroll", () => { if (carded) paintCard(); }, { passive: true, capture: true });

  // ---- draw ----
  function draw() {
    if (!host) return;
    const now = host.now();
    setText(clockEl, clock(now));
    if (!world) {
      if (!shell.querySelector(".bld-note")) shell.replaceChildren(el("p", "bld-note", "Waiting for the first state…"));
      return;
    }
    model = deriveBuilding(world, now, rooms());
    const all = people();
    if (!all.some((p) => p.id === selected)) selected = (all.find((p) => p.current) ?? all[0])?.id ?? null;

    setText(hudTitle, `needs you · ${model.queue.length}`);
    queueBox.classList.toggle("calm", model.queue.length === 0);
    const seenQ = new Set<string>();
    place(pillRow, model.queue.slice(0, QUEUE_SHOWN), (q) => q.ref.window, pills, seenQ, makePill, patchPill);
    sweep(pills, seenQ);
    setText(more, model.queue.length > QUEUE_SHOWN ? `+${model.queue.length - QUEUE_SHOWN}` : "");

    const seenF = new Set<string>();
    const seenD = new Set<string>();
    place(shell, model.floors, (f) => `${f.kind}:${f.key}`, floors, seenF, makeFloor, (f, fl) => patchFloor(f, fl, seenD));
    sweep(floors, seenF);
    sweep(desks, seenD);
    placePets(model);
    if (floorCount !== model.floors.length) {
      floorCount = model.floors.length;
      fit();
    }

    const seenG = new Set<string>();
    place(gen.querySelector<HTMLElement>(".bld-fuels")!, model.fuel, (f) => `${f.provider}:${f.label}`, fuels, seenG, makeFuel,
      (r, f) => patchFuel(r, f, now));
    sweep(fuels, seenG);
    paintSelection();
    if (carded) paintCard();
    // Arrows need focus here: taken once, when the first desks appear, and only from nobody --
    // never from the search or a note, and never again on a later tick.
    if (!focusTaken && desks.size) {
      focusTaken = true;
      const active = document.activeElement;
      if (!active || active === document.body) desks.get(selected ?? "")?.focus({ preventScroll: true });
    }
  }

  return {
    fullWindow: true,
    mount(h) {
      host = h;
      gen.replaceChildren(el("span", "bld-gen-title", "generator"), el("div", "bld-fuels"));
      root.tabIndex = -1;
      root.replaceChildren(hud, tower, gen, card);
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
      carded = null;
      cardFromKeys = false;
      card.classList.remove("show");
      if (trotEnd) clearTimeout(trotEnd);
      trotEnd = null;
      for (const t of looking.values()) if (t) clearTimeout(t);
      looking.clear();
      floors.clear();
      desks.clear();
      pills.clear();
      fuels.clear();
    },
  };
}
