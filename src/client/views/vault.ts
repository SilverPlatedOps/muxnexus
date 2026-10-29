// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import type * as Pixi from "pixi.js";
import pixiUrl from "../../../node_modules/pixi.js/dist/pixi.min.mjs" with { type: "file" };
import type { View, ViewHost } from "../view-host";
import type { WindowRef, World } from "../world";
import {
  deriveBuilding, NEUTRAL, PALETTE, ROOM_CHOICES, ROOM_LABEL, span,
  type Building, type Floor, type Fuel, type Person, type QueueEntry, type RoomType, type Sheet,
} from "../building/derive";
import { layoutVault, strollAt, VAULT, type VaultLayout } from "../building/layout";
import { planErrand, type Errand, type PetKind, type PetPlace, type PetWorld } from "../building/pets";
import { skyAt, WEATHERS, type Weather } from "../building/sky";
import { DESK_ART, PERSON_PICTURE, PET_PICTURE, PROP_PICTURE, ROOM_PICTURE, SKY_PICTURE } from "../building/vault-art";
import { formatReset } from "../usage";
import { button, el, place, setText, sweep } from "./patch";

/**
 * The vault: the building drawn by a game renderer. Floors, people, pets, the
 * lift, light and weather are pictures on a WebGL canvas, under a camera you
 * can pan and zoom. Text and controls stay in the page -- the top bar, the
 * quota, the card, and a quiet list of everyone for the keyboard and screen
 * readers -- so nothing that must be read or reached lives in the canvas alone.
 * The renderer is fetched only when the vault is first shown.
 */

const QUEUE_SHOWN = 4;
const SHEETS_SHOWN = 8;
const BLOCKS = 10;
const ACCOUNT = PALETTE.map((c) => parseInt(c.slice(1), 16));
const NEUTRAL_HEX = parseInt(NEUTRAL.slice(1), 16);
const FLAG = 0xff6b4a;
const LIGHT = 0xffcf8a;
const STAND = VAULT.roomH - 30; // the floor line inside a room, where feet and desk legs meet it
const DESK_H = 88;
const DESKTOP = STAND - 58; // the desk's top surface
const SEATED_SHOWN = 70 / 86; // how much of a seated figure shows above the desk
const POSE_H: Record<string, number> = { typing: 86, "hand-up": 86, calm: 86, asleep: 90, ghost: 106, away: 100, bend: 96 };
const SPEED = { cat: 42, dog: 72 } as const;

const colourHex = (slot: number | null) => (slot === null ? NEUTRAL_HEX : ACCOUNT[slot % ACCOUNT.length]);
const colourCss = (slot: number | null) => (slot === null ? NEUTRAL : PALETTE[slot % PALETTE.length]);
const clock = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hashPhase(id: string, period: number): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % period;
}

function backAt(resetsAt: string, now: number): string {
  const ms = Date.parse(resetsAt) - now;
  if (ms > 0 && ms < 20 * 3600_000) return `back at ${clock(resetsAt)}`;
  return `back in ${formatReset(resetsAt, now)}`;
}

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

type Pic = keyof typeof PERSON_PICTURE;

interface DeskVis {
  id: string;
  root: Pixi.Container;
  light: Pixi.Sprite;
  desk: Pixi.Sprite;
  poses: [Pixi.Sprite, Pixi.Sprite];
  /** Which of `poses` shows the current pose, and since when it has been fading in. */
  on: 0 | 1;
  fadeAt: number;
  pic: Pic | null;
  laptop: Pixi.Graphics;
  /** Which kind of laptop is drawn, so it is redrawn only when that changes. */
  laptopKey: string;
  screen: Pixi.Sprite;
  sheets: Pixi.Graphics;
  sheetsKey: string;
  face: Pixi.Sprite;
  tag: Pixi.Container;
  tagBg: Pixi.Graphics;
  tagName: Pixi.Text;
  tagStatus: Pixi.Text;
  tagJobs: Pixi.Text;
  here: Pixi.Text;
  tagKey: string;
  phase: number;
  person: Person;
  floor: string;
  x: number;
  stroll: boolean;
  lookUntil: number;
  petted: boolean;
}

interface FloorVis {
  key: string;
  root: Pixi.Container;
  room: Pixi.Container;
  props: Pixi.Container;
  desks: Pixi.Container;
  pets: Pixi.Container;
  dark: Pixi.Graphics;
  glow: Pixi.Container;
  ui: Pixi.Container;
  door: Pixi.Sprite;
  plate: Pixi.Container;
  plateBg: Pixi.Graphics;
  plateText: Pixi.Text;
  sw: Pixi.Sprite;
  roomType: RoomType | null;
  width: number;
  /** The strips cut from the room picture for this floor; they share its source, so only they go when it is laid again. */
  pieces: Pixi.Texture[];
}

type Step =
  | { kind: "walk"; floor: string; x: number }
  | { kind: "ride"; to: string }
  | { kind: "stay"; act: Errand["then"]; ms: number };

interface PetVis {
  kind: PetKind;
  sprite: Pixi.Sprite;
  floor: string;
  x: number;
  steps: Step[];
  /** When the current stay ends. */
  until: number;
  act: Errand["then"] | "walk" | "ride";
  /** The errand's goal, kept to notice when the dog's should change. */
  goal: string;
  touchedUntil: number;
}

export function createVaultView(): View {
  let host: ViewHost | null = null;
  let world: World | null = null;
  let model: Building | null = null;
  let layout: VaultLayout<Floor["kind"]> | null = null;
  let selected: string | null = null;
  let carded: string | null = null;
  let cardFromKeys = false;
  let stopTick: (() => void) | null = null;
  let focusTaken = false;
  let alive = false;
  /** Every Text set in Pixelify Sans, for `fontsLanded`. */
  const pixelTexts = new Set<Pixi.Text>();
  /** The terminal a ⌘J or queue glide opens once the camera arrives; a newer glide or an unmount cancels it. */
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  /** Each mount's boot carries its own number: a boot from an earlier mount gives up. */
  let mountNo = 0;

  // ---- the page parts: top bar, stage, generator, card, and the keyboard's list ----
  const root = el("div", "bld vlt");
  const hud = el("header", "bld-hud");
  const stage = el("div", "vlt-stage");
  const a11y = el("div", "vlt-a11y");
  a11y.setAttribute("role", "list");
  a11y.setAttribute("aria-label", "Everyone in the vault");
  const card = el("div", "bld-card");
  const gen = el("footer", "bld-gen");
  const note = el("p", "bld-note", "Opening the vault…");
  stage.append(note, a11y);
  const pills = new Map<string, HTMLElement>();
  const fuels = new Map<string, HTMLElement>();
  const buttons = new Map<string, HTMLElement>();

  const people = () => model?.floors.flatMap((f) => f.people) ?? [];
  const floorOf = (id: string) => model?.floors.find((f) => f.people.some((p) => p.id === id)) ?? null;
  const open = (ref: WindowRef | null) => { if (ref) host?.actions.openWindow(ref); };

  function pref<T>(key: string, fallback: T, valid: (v: unknown) => v is T): T {
    try {
      const raw: unknown = JSON.parse(host?.prefs.get(key) ?? "null");
      return valid(raw) ? raw : fallback;
    } catch {
      return fallback;
    }
  }
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  function rooms(): Record<string, RoomType> {
    const raw = pref("rooms", {}, isRecord);
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => ROOM_CHOICES.includes(v as RoomType))) as Record<string, RoomType>;
  }
  /** Floors whose lights are off, by floor key, and the chosen weather: read once a second, not every frame. */
  let darkCache = new Set<string>();
  let weatherCache: Weather = "clear";
  function readPrefs() {
    darkCache = new Set(pref("dark", [] as string[], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string")));
    weatherCache = pref<Weather>("weather", "clear", (v): v is Weather => WEATHERS.includes(v as Weather));
  }
  const darkFloors = () => darkCache;
  const weather = () => weatherCache;

  // ---- top bar ----
  const clockEl = el("span", "bld-clock");
  const brand = el("div", "bld-brand");
  brand.append(el("span", "bld-logo", "muxnexus"), clockEl);
  const queueBox = el("div", "bld-queue");
  const hudTitle = el("span", "bld-hud-title");
  const pillRow = el("div", "bld-pills");
  const more = el("span", "bld-more");
  queueBox.append(hudTitle, pillRow, more, el("kbd", undefined, "⌘J"));
  const weatherBtn = button("bld-btn");
  weatherBtn.title = "The weather outside is a setting: click to change it";
  weatherBtn.onclick = () => {
    const next = WEATHERS[(WEATHERS.indexOf(weather()) + 1) % WEATHERS.length];
    host?.prefs.set("weather", JSON.stringify(next));
    readPrefs();
    paintHud();
  };
  const toTerminal = button("bld-btn");
  toTerminal.append("terminal ", el("kbd", undefined, "↵"));
  // The picked person's terminal; with nobody picked (or nobody at all), simply back to the terminal.
  toTerminal.onclick = () => {
    const target = people().find((p) => p.id === selected)?.target ?? null;
    if (target) open(target);
    else host?.leave();
  };
  const tools = el("div", "bld-tools");
  tools.append(el("span", "bld-hint", "L lights · drag to pan · pinch to zoom"), weatherBtn, toTerminal);
  hud.append(brand, queueBox, tools);

  function makePill(): HTMLElement {
    const b = button("bld-pill");
    const face = el("img", "bld-pill-face");
    face.src = PERSON_PICTURE["hand-up"];
    face.alt = "";
    b.append(face, el("span", "bld-pill-name"), el("span", "bld-pill-wait"));
    b.onclick = () => revealRef({ session: b.dataset.session ?? "", window: b.dataset.window ?? "" });
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
  function makeFuel(): HTMLElement {
    const r = el("div", "bld-fuel");
    const blocks = el("span", "bld-blocks");
    for (let i = 0; i < BLOCKS; i++) blocks.append(el("i"));
    r.append(el("b", "bld-fuel-name"), blocks, el("span", "bld-fuel-text"));
    return r;
  }
  function patchFuel(r: HTMLElement, f: Fuel, now: number) {
    r.dataset.level = f.signedOut ? "out" : f.level;
    if (r.style.getPropertyValue("--c") !== colourCss(f.slot)) r.style.setProperty("--c", colourCss(f.slot));
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
      : `${Math.round(f.percent)}%${reset ? ` · ${reset}` : ""}`);
  }
  function paintHud() {
    if (!host) return;
    const now = host.now();
    setText(clockEl, `${clock(now)} · ${skyAt(new Date(now))}`);
    setText(weatherBtn, `weather: ${weather()}`);
    if (!model) return;
    setText(hudTitle, `needs you · ${model.queue.length}`);
    queueBox.classList.toggle("calm", model.queue.length === 0);
    const seenQ = new Set<string>();
    place(pillRow, model.queue.slice(0, QUEUE_SHOWN), (q) => q.ref.window, pills, seenQ, makePill, patchPill);
    sweep(pills, seenQ);
    setText(more, model.queue.length > QUEUE_SHOWN ? `+${model.queue.length - QUEUE_SHOWN}` : "");
    const seenG = new Set<string>();
    place(gen.querySelector<HTMLElement>(".bld-fuels")!, model.fuel, (f) => `${f.provider}:${f.label}`, fuels, seenG, makeFuel,
      (r, f) => patchFuel(r, f, now));
    sweep(fuels, seenG);
  }

  // ---- the card, built once and patched ----
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

  function paintCard() {
    const p = carded ? people().find((x) => x.id === carded) : null;
    const fl = carded ? floorOf(carded) : null;
    const d = carded ? desks.get(carded) : null;
    if (!p || !fl || !d || !host || !app) {
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
    while (cardList.children.length < p.sheets.length) {
      const li = el("li");
      li.append(el("kbd"), el("i", "bld-chip"), el("span", "bld-card-acct"), el("span", "bld-card-name"), el("span", "bld-card-what"));
      cardList.append(li);
    }
    p.sheets.forEach((s, i) => {
      const li = cardList.children[i] as HTMLElement;
      li.classList.toggle("flag", s.flag);
      const [key, chip, acct, name, what] = li.children as unknown as HTMLElement[];
      setText(key, s.n <= 9 ? `⌘${s.n}` : "");
      chip.classList.toggle("dashed", s.dashed);
      chip.style.setProperty("--c", colourCss(s.slot));
      setText(acct, s.account ?? "—");
      setText(name, s.name);
      setText(what, sheetLine(s, now));
    });
    placeCard();
    card.classList.add("show");
  }
  /** Beside the desk on screen, flipped to its left near the right edge. */
  function placeCard() {
    const d = carded ? desks.get(carded) : null;
    if (!d || !app) return;
    const tl = d.root.toGlobal({ x: -64, y: -VAULT.roomH + 20 } as Pixi.PointData);
    const br = d.root.toGlobal({ x: 64, y: 0 } as Pixi.PointData);
    const s = stage.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const w = card.offsetWidth;
    const right = s.left - box.left + br.x + 10;
    const x = right + w > box.width - 8 ? s.left - box.left + tl.x - w - 10 : right;
    const top = clamp(s.top - box.top + tl.y, 8, box.height - card.offsetHeight - 8);
    card.style.left = `${Math.max(8, x)}px`;
    card.style.top = `${top}px`;
  }
  function showCard(id: string | null) {
    carded = id;
    paintCard();
  }

  // ---- the keyboard's list: one button per person, in the same order as the floors ----
  function makeButton(): HTMLElement {
    const b = button("vlt-person");
    b.tabIndex = -1;
    b.setAttribute("role", "listitem");
    b.onclick = () => open(people().find((p) => p.id === b.dataset.session)?.target ?? null);
    b.onfocus = () => {
      selected = b.dataset.session ?? null;
      paintSelection();
    };
    return b;
  }
  function paintSelection() {
    for (const [id, b] of buttons) {
      const on = id === selected;
      b.tabIndex = on ? 0 : -1;
    }
  }
  function move(dx: number, dy: number) {
    if (!model) return;
    const rows = model.floors.map((f) => f.people).filter((r) => r.length);
    if (!rows.length) return;
    let fi = rows.findIndex((r) => r.some((p) => p.id === selected));
    let pi = fi < 0 ? 0 : rows[fi].findIndex((p) => p.id === selected);
    if (fi < 0) fi = 0;
    if (dy) { fi = clamp(fi + dy, 0, rows.length - 1); pi = Math.min(pi, rows[fi].length - 1); }
    if (dx) pi = clamp(pi + dx, 0, rows[fi].length - 1);
    selected = rows[fi][pi].id;
    paintSelection();
    buttons.get(selected)?.focus({ preventScroll: true });
    follow(selected);
    cardFromKeys = true;
    showCard(selected);
  }
  root.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key in step) {
      e.preventDefault();
      move(...step[e.key]);
    } else if (e.key === "l" || e.key === "L") {
      const fl = selected ? floorOf(selected) : null;
      if (fl) toggleLights(fl.key);
    } else if (e.key === "Escape") {
      cardFromKeys = false;
      showCard(null);
    }
  });
  root.addEventListener("focusout", (e) => {
    if (root.contains(e.relatedTarget as Node | null)) return;
    cardFromKeys = false;
    showCard(null);
  });

  function toggleLights(key: string) {
    const dark = new Set(darkFloors());
    if (dark.has(key)) dark.delete(key);
    else dark.add(key);
    host?.prefs.set("dark", JSON.stringify([...dark]));
    readPrefs();
  }

  // ---- the renderer ----
  let P: typeof Pixi | null = null;
  let app: Pixi.Application | null = null;
  let tex: Record<string, Pixi.Texture> = {};
  let sky: Pixi.TilingSprite | null = null;
  let skyPhase = "";
  let weatherLayer: Pixi.Container | null = null;
  let flash: Pixi.Graphics | null = null;
  let worldLayer: Pixi.Container | null = null;
  let frame: Pixi.Graphics | null = null;
  let car: Pixi.Sprite | null = null;
  let rideLayer: Pixi.Container | null = null;
  const floorVis = new Map<string, FloorVis>();
  const desks = new Map<string, DeskVis>();
  const pets: PetVis[] = [];
  const drops: { s: Pixi.Sprite; vx: number; vy: number; sway: number }[] = [];
  let dropsFor = "";
  const cam = { x: 0, y: 0, s: 1, tx: 0, ty: 0, ts: 1, manual: false };
  let structure = "";
  let carY = 0;
  let carTarget = 0;
  let liftBusy: PetVis | null = null;
  let nextFlash = 0;

  const reduced = () => host?.reducedMotion() ?? false;

  async function boot(no: number) {
    const current = () => alive && no === mountNo;
    const mod = (await import(/* @vite-ignore */ pixiUrl)) as typeof Pixi;
    if (!current()) return;
    P = mod;
    P.TextureStyle.defaultOptions.scaleMode = "nearest";
    const a = new P.Application();
    await a.init({ resizeTo: stage, background: 0x0d1838, antialias: false, autoDensity: true, resolution: Math.min(2, window.devicePixelRatio || 1), preference: "webgl" });
    if (!current()) {
      a.destroy(true, { children: true });
      return;
    }
    app = a;
    const urls: Record<string, string> = {
      ...Object.fromEntries(Object.entries(PERSON_PICTURE).map(([k, v]) => [`person:${k}`, v])),
      ...Object.fromEntries(Object.entries(DESK_ART).map(([k, v]) => [`desk:${k}`, v])),
      ...Object.fromEntries(Object.entries(ROOM_PICTURE).map(([k, v]) => [`room:${k}`, v.url])),
      ...Object.fromEntries(Object.entries(SKY_PICTURE).map(([k, v]) => [`sky:${k}`, v])),
      ...Object.fromEntries(Object.entries(PROP_PICTURE).map(([k, v]) => [`prop:${k}`, v])),
      ...Object.fromEntries(Object.entries(PET_PICTURE.cat).map(([k, v]) => [`cat:${k}`, v])),
      ...Object.fromEntries(Object.entries(PET_PICTURE.dog).map(([k, v]) => [`dog:${k}`, v])),
    };
    const loaded = await Promise.all(Object.entries(urls).map(async ([k, u]) => [k, await mod.Assets.load<Pixi.Texture>(u)] as const));
    if (!current() || app !== a) return;
    tex = Object.fromEntries(loaded);
    // Seated figures are cut at the desktop: only their top shows above it.
    for (const k of ["typing", "hand-up", "calm", "asleep", "ghost"]) {
      const t = tex[`person:${k}`];
      tex[`seated:${k}`] = new P.Texture({ source: t.source, frame: new P.Rectangle(0, 0, t.width, Math.round(t.height * SEATED_SHOWN)) });
    }
    tex.glow = glowTexture(P);
    tex.drop = dropTexture(P);

    note.remove();
    stage.prepend(a.canvas);
    a.stage.eventMode = "static";
    a.stage.hitArea = a.screen;
    sky = new P.TilingSprite({ texture: tex["sky:night"], width: a.screen.width, height: a.screen.height });
    weatherLayer = new P.Container();
    flash = new P.Graphics();
    worldLayer = new P.Container();
    a.stage.addChild(sky, weatherLayer, worldLayer, flash);
    frame = new P.Graphics();
    rideLayer = new P.Container();
    car = new P.Sprite(tex["prop:lift"]);
    car.anchor.set(0.5, 1);
    worldLayer.addChild(frame);
    wireCamera(a);
    a.ticker.add((t) => frameUpdate(t.deltaMS));
    draw();
  }

  /** A soft round light, drawn once: laptops on faces, the pool under a waiting desk. */
  function glowTexture(p: typeof Pixi): Pixi.Texture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)");
    r.addColorStop(0.45, "rgba(255,255,255,.45)");
    r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    const t = p.Texture.from(c);
    t.source.scaleMode = "linear";
    return t;
  }
  function dropTexture(p: typeof Pixi): Pixi.Texture {
    const c = document.createElement("canvas");
    c.width = 2;
    c.height = 16;
    const g = c.getContext("2d")!;
    g.fillStyle = "rgba(200,220,255,.9)";
    g.fillRect(0, 0, 2, 16);
    return p.Texture.from(c);
  }

  // ---- the camera: drag to pan, wheel or pinch to zoom, glide to whoever is chosen ----
  function wireCamera(a: Pixi.Application) {
    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    a.stage.on("pointerdown", (e) => {
      if (e.target !== a.stage) return;
      drag = { x: e.global.x, y: e.global.y, cx: cam.tx, cy: cam.ty };
    });
    a.stage.on("globalpointermove", (e) => {
      if (!drag) return;
      cam.manual = true;
      cam.tx = drag.cx - (e.global.x - drag.x) / cam.s;
      cam.ty = drag.cy - (e.global.y - drag.y) / cam.s;
      clampCam();
    });
    const end = () => { drag = null; };
    a.stage.on("pointerup", end);
    a.stage.on("pointerupoutside", end);
    a.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      cam.manual = true;
      if (e.ctrlKey) {
        const r = a.canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const wx = cam.tx + (mx - a.screen.width / 2) / cam.ts;
        const wy = cam.ty + (my - a.screen.height / 2) / cam.ts;
        cam.ts = clamp(cam.ts * Math.exp(-e.deltaY * 0.01), fitScale() * 0.9, 2.2);
        cam.tx = wx - (mx - a.screen.width / 2) / cam.ts;
        cam.ty = wy - (my - a.screen.height / 2) / cam.ts;
      } else {
        cam.tx += e.deltaX / cam.s;
        cam.ty += e.deltaY / cam.s;
      }
      clampCam();
    }, { passive: false });
  }
  /** Open sky kept above the roof, so the weather has somewhere to show. */
  const SKY_ABOVE = 70;
  /** The whole height fits, with sky above; the width pans, as in Fallout Shelter. */
  function fitScale(): number {
    if (!app || !layout) return 1;
    return clamp((app.screen.height - 12) / (layout.height + SKY_ABOVE), 0.5, 1.25);
  }
  function clampCam() {
    if (!app || !layout) return;
    const halfW = app.screen.width / 2 / cam.ts;
    const halfH = app.screen.height / 2 / cam.ts;
    cam.tx = layout.width <= halfW * 2 ? layout.width / 2 : clamp(cam.tx, halfW - 24, layout.width - halfW + 24);
    const tall = layout.height + SKY_ABOVE;
    cam.ty = tall <= halfH * 2 ? (layout.height - SKY_ABOVE) / 2 + halfH - tall / 2 + SKY_ABOVE / 2 : clamp(cam.ty, halfH - SKY_ABOVE, layout.height - halfH + 16);
  }
  function follow(id: string | null, zoom?: number) {
    const d = id ? desks.get(id) : null;
    const f = d ? layout?.floors.find((x) => x.key === d.floor) : null;
    if (!d || !f || !app) return;
    if (zoom) cam.ts = zoom;
    const halfW = app.screen.width / 2 / cam.ts;
    // Keep the desk in view with a margin; only move as far as needed, unless asked to centre.
    if (zoom || d.x < cam.tx - halfW + 180 || d.x > cam.tx + halfW - 240) cam.tx = d.x;
    if (zoom) cam.ty = f.y + VAULT.roomH / 2;
    clampCam();
  }
  /** ⌘J and the queue: the camera glides to them, then their terminal opens. */
  function revealRef(ref: WindowRef) {
    const p = people().find((x) => x.id === ref.session);
    if (!p || reduced() || !app) {
      open(ref);
      return;
    }
    selected = p.id;
    paintSelection();
    follow(p.id, Math.max(cam.ts, 1.3));
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { revealTimer = undefined; if (alive) open(ref); }, 380);
  }

  // ---- building the scene from the model ----
  function rebuild() {
    if (!P || !app || !model || !worldLayer || !frame || !car || !rideLayer) return;
    const L = layoutVault(model.floors);
    layout = L;
    const key = JSON.stringify([L.width, L.floors.map((f) => [f.key, f.kind]), model.floors.map((f) => f.room)]);
    const same = key === structure;
    structure = key;

    // The frame: roof, slabs, outer walls, the shaft, the ground. Rooms are left open, so the sky shows through their glass.
    if (!same) {
      frame.clear();
      const concrete = 0x3a4050;
      frame.rect(0, 0, L.width, VAULT.roof).fill(concrete);
      frame.rect(0, 0, VAULT.wall, L.height).fill(concrete);
      frame.rect(L.width - VAULT.wall, 0, VAULT.wall, L.height).fill(concrete);
      frame.rect(L.shaft.x + L.shaft.w, 0, VAULT.wall, L.height).fill(concrete);
      frame.rect(L.shaft.x, VAULT.roof, L.shaft.w, L.height - VAULT.roof - VAULT.ground).fill(0x161a23);
      for (let x = L.shaft.x + 10; x < L.shaft.x + L.shaft.w; x += L.shaft.w - 20) frame.rect(x, VAULT.roof, 3, L.height - VAULT.roof - VAULT.ground).fill(0x2a2f3c);
      for (const f of L.floors) frame.rect(0, f.y + VAULT.roomH, L.width, VAULT.slab).fill(concrete);
      frame.rect(0, L.height - VAULT.ground, L.width, VAULT.ground).fill(0x232835);
      // The earth the vault stands in.
      frame.rect(-2000, L.height, L.width + 4000, 1200).fill(0x2a1f18);
      frame.rect(-2000, L.height, L.width + 4000, 4).fill(0x3d2c20);
      frame.rect(0, VAULT.roof - 3, L.width, 3).fill(0x4a5266);
    }

    const seenF = new Set<string>();
    model.floors.forEach((fl, i) => {
      const lf = L.floors[i];
      seenF.add(fl.key);
      let v = floorVis.get(fl.key);
      if (!v) {
        v = makeFloor(fl);
        floorVis.set(fl.key, v);
      }
      worldLayer!.addChildAt(v.root, Math.min(1 + i, worldLayer!.children.length));
      v.root.position.set(0, lf.y);
      if (v.roomType !== fl.room || v.width !== L.room.w) layRoom(v, fl.room, L);
      v.door.position.set(L.shaft.x + L.shaft.w / 2, STAND + 4);
      lf.desks.forEach((ld, j) => {
        const p = fl.people[j];
        let d = desks.get(p.id);
        if (!d) {
          d = makeDesk(p);
          desks.set(p.id, d);
        }
        d.floor = fl.key;
        d.x = ld.x;
        d.person = p;
        if (d.root.parent !== v!.desks) v!.desks.addChild(d.root);
        if (d.face.parent !== v!.glow) v!.glow.addChild(d.face);
        if (d.tag.parent !== v!.ui) v!.ui.addChild(d.tag);
        d.root.position.set(ld.x, 0);
        d.desk.texture = tex[`desk:${fl.room}`] ?? tex["desk:office"];
        d.desk.visible = true;
      });
      // Only idle people wander, one per floor; the basement's desks sleep under sheets.
      const stroller = fl.kind === "basement" ? undefined : fl.people.find((p) => p.pose === "away");
      for (const p of fl.people) {
        const d = desks.get(p.id)!;
        d.stroll = p === stroller;
      }
      paintPlate(v, fl);
    });
    for (const [k, v] of floorVis) {
      if (seenF.has(k)) continue;
      // A pet on a floor that is going goes home first; it is not part of the floor.
      for (const pet of pets) if (pet.sprite.parent === v.pets) v.pets.removeChild(pet.sprite);
      v.root.destroy({ children: true });
      for (const t of v.pieces.splice(0)) t.destroy();
      floorVis.delete(k);
    }
    const live = new Set(people().map((p) => p.id));
    for (const [id, d] of desks) {
      if (live.has(id)) continue;
      // A desk whose floor went is already destroyed with it.
      if (!d.root.destroyed) d.root.destroy({ children: true });
      if (!d.face.destroyed) d.face.destroy();
      if (!d.tag.destroyed) d.tag.destroy({ children: true });
      desks.delete(id);
    }
    worldLayer.addChild(car, rideLayer);
    if (!same) {
      carY = carTarget = restingCarY();
      if (!cam.manual) {
        cam.ts = cam.s = fitScale();
        const here = people().find((p) => p.current) ?? people().find((p) => p.id === selected);
        cam.tx = cam.x = here ? desks.get(here.id)?.x ?? L.width / 2 : L.width / 2;
        cam.ty = cam.y = L.height / 2 - SKY_ABOVE / 2;
        clampCam();
        cam.x = cam.tx;
        cam.y = cam.ty;
      }
      placeProps();
      ensurePets();
      const home = homeFloor();
      for (const pet of pets) {
        if (floorVis.has(pet.floor) && pet.sprite.parent) continue;
        if (liftBusy === pet) liftBusy = null;
        pet.steps = [];
        if (home) moveToFloor(pet, home.key, (layout?.room.x ?? 0) + 200);
      }
    }
  }

  function text(t: string, size: number, fill: number, weight: "400" | "600" = "400", family = "JetBrains Mono"): Pixi.Text {
    const made = new P!.Text({ text: t, style: { fontFamily: family, fontSize: size, fill, fontWeight: weight }, resolution: 3 });
    if (family.startsWith("Pixelify")) pixelTexts.add(made);
    return made;
  }

  /**
   * Pixi draws a Text into a texture once, so one drawn before Pixelify Sans
   * arrived keeps the fallback face. When a font lands, draw those again; the
   * plates are cleared so the next paint measures their background anew.
   */
  function fontsLanded() {
    for (const t of pixelTexts) {
      if (t.destroyed) {
        pixelTexts.delete(t);
        continue;
      }
      const was = t.text;
      t.text = "";
      t.text = was;
    }
    for (const v of floorVis.values()) v.plateText.text = "";
    draw();
  }

  function makeFloor(fl: Pick<Floor, "key">): FloorVis {
    const p = P!;
    const v: FloorVis = {
      key: fl.key,
      root: new p.Container(),
      room: new p.Container(),
      props: new p.Container(),
      desks: new p.Container(),
      pets: new p.Container(),
      dark: new p.Graphics(),
      glow: new p.Container(),
      ui: new p.Container(),
      door: new p.Sprite(tex["prop:lift"]),
      plate: new p.Container(),
      plateBg: new p.Graphics(),
      plateText: text("", 14, 0xf6dfae, "600", "Pixelify Sans, JetBrains Mono"),
      sw: new p.Sprite(tex["prop:switchOn"]),
      roomType: null,
      width: 0,
      pieces: [],
    };
    v.door.anchor.set(0.5, 1);
    v.door.tint = 0x8890a4;
    v.door.height = 126;
    v.door.scale.x = v.door.scale.y;
    v.glow.blendMode = "add";
    v.plate.addChild(v.plateBg, v.plateText);
    v.plateText.position.set(10, 3);
    v.plate.eventMode = "static";
    v.plate.cursor = "pointer";
    v.plate.on("pointertap", () => {
      // The plate furnishes the floor: each tap tries the next room type. Read now, not when the floor was made.
      const now = model?.floors.find((f) => f.key === v.key);
      if (!now || now.kind === "basement") return;
      const next = ROOM_CHOICES[(ROOM_CHOICES.indexOf(now.room) + 1) % ROOM_CHOICES.length];
      host?.prefs.set("rooms", JSON.stringify({ ...rooms(), [v.key]: next }));
      draw();
    });
    v.sw.anchor.set(0.5, 0.5);
    v.sw.height = 26;
    v.sw.scale.x = v.sw.scale.y;
    v.sw.eventMode = "static";
    v.sw.cursor = "pointer";
    v.sw.on("pointertap", () => toggleLights(v.key));
    v.ui.addChild(v.plate, v.sw);
    v.root.addChild(v.door, v.room, v.props, v.desks, v.pets, v.dark, v.glow, v.ui);
    return v;
  }

  function paintPlate(v: FloorVis, fl: Floor) {
    if (!layout) return;
    const n = fl.people.length;
    const here = fl.people.some((p) => p.current);
    const what = fl.kind === "basement" ? `storage · ${n} ${n === 1 ? "desk" : "desks"} under sheets` : `${ROOM_LABEL[fl.room]} ▸ · ${n} ${n === 1 ? "person" : "people"}`;
    const label = `${fl.name.toUpperCase()}  ${what}${here ? " · you're here" : ""}`;
    if (v.plateText.text !== label) {
      v.plateText.text = label;
      v.plateBg.clear().rect(0, 0, v.plateText.width + 20, 24).fill({ color: 0x0d1020, alpha: 0.88 })
        .stroke({ width: 2, color: here ? LIGHT : 0x4a5370 });
    }
    v.plate.position.set(layout.room.x + 6, 0);
    // On the wall left of the first desk, under the plate.
    v.sw.position.set(layout.room.x + 40, 78);
    v.sw.visible = fl.kind !== "basement";
  }

  /** Lay a room picture along a floor: both ends, the centrepiece, and plain wall repeated between. */
  function layRoom(v: FloorVis, room: RoomType, L: VaultLayout) {
    const p = P!;
    v.roomType = room;
    v.width = L.room.w;
    for (const c of v.room.removeChildren()) c.destroy();
    for (const t of v.pieces.splice(0)) t.destroy();
    const pic = tex[`room:${room}`];
    const cut = ROOM_PICTURE[room].cut;
    const k = VAULT.roomH / pic.height;
    const piece = (x0: number, x1: number) => {
      const t = new p.Texture({ source: pic.source, frame: new p.Rectangle(x0, 0, x1 - x0, pic.height) });
      v.pieces.push(t);
      return t;
    };
    const sprite = (t: Pixi.Texture, x: number) => {
      const s = new p.Sprite(t);
      s.scale.set(k);
      s.position.set(x, 0);
      v.room.addChild(s);
      return s;
    };
    const leftW = cut.left * k;
    const rightW = (pic.width - cut.right) * k;
    const centreW = (cut.centre[1] - cut.centre[0]) * k;
    const fillW = (cut.fill[1] - cut.fill[0]) * k;
    const x0 = L.room.x;
    const x1 = L.room.x + L.room.w;
    // Plain wall fills the gaps -- but never behind the centrepiece, whose glass must show the sky.
    const fill = piece(cut.fill[0], cut.fill[1]);
    const cx = Math.round(x0 + (L.room.w - centreW) * 0.55);
    const strip = (from: number, to: number) => {
      for (let x = from; x < to; x += fillW - 1) {
        const s = sprite(fill, x);
        if (x + fillW > to) s.scale.x = k * Math.max(0, to - x) / fillW;
      }
    };
    strip(x0 + leftW - 1, cx + 1);
    strip(cx + centreW - 1, x1 - rightW + 1);
    sprite(piece(cut.centre[0], cut.centre[1]), cx);
    sprite(piece(0, cut.left), x0);
    sprite(piece(cut.right, pic.width), x1 - rightW);
    v.dark.clear().rect(x0, 0, L.room.w, VAULT.roomH).fill({ color: 0x050816, alpha: 0.66 });
  }

  function makeDesk(p: Person): DeskVis {
    const x = P!;
    const root = new x.Container();
    const light = new x.Sprite(tex.glow);
    light.anchor.set(0.5);
    light.tint = LIGHT;
    light.width = 170;
    light.height = 46;
    light.position.set(0, STAND);
    const desk = new x.Sprite(tex["desk:office"]);
    desk.anchor.set(0.5, 1);
    desk.height = DESK_H;
    desk.scale.x = desk.scale.y;
    desk.position.set(0, STAND);
    const mk = () => {
      const s = new x.Sprite();
      s.anchor.set(0.5, 1);
      return s;
    };
    const poses: [Pixi.Sprite, Pixi.Sprite] = [mk(), mk()];
    const laptop = new x.Graphics();
    const screen = new x.Sprite(x.Texture.WHITE);
    screen.tint = 0xa0c8ff;
    screen.width = 34;
    screen.height = 4;
    screen.position.set(-17, DESKTOP - 19);
    const sheets = new x.Graphics();
    const face = new x.Sprite(tex.glow);
    face.anchor.set(0.5);
    face.tint = 0x6f9be0;
    face.width = 54;
    face.height = 44;
    face.blendMode = "add";
    const tag = new x.Container();
    const tagBg = new x.Graphics();
    const tagName = text("", 11, 0xe8e2d2, "600");
    const tagStatus = text("", 10, 0x8fdcb0);
    const tagJobs = text("", 10, 0x8a93a6);
    const here = text("you're here ▼", 11, LIGHT, "600", "Pixelify Sans, JetBrains Mono");
    here.anchor.set(0.5, 1);
    for (const t of [tagName, tagStatus, tagJobs]) t.anchor.set(0.5, 0);
    tag.addChild(tagBg, tagName, tagStatus, tagJobs, here);
    root.addChild(light, poses[0], desk, poses[1], laptop, screen, sheets);
    // Seated people sit between the chair (in the desk picture) and the desk's front: drawn over the picture,
    // cut at its top. Both pose sprites go above the desk; the laptop and sheets above them.
    root.setChildIndex(poses[0], root.children.length - 4);
    root.eventMode = "static";
    root.cursor = "pointer";
    root.hitArea = new x.Rectangle(-64, 12, 128, VAULT.roomH - 12);
    const d: DeskVis = {
      id: p.id, root, light, desk, poses, on: 0, fadeAt: 0, pic: null, laptop, laptopKey: "", screen, sheets, sheetsKey: "", face,
      tag, tagBg, tagName, tagStatus, tagJobs, here, tagKey: "", phase: hashPhase(p.id, 2800), person: p, floor: "", x: 0,
      stroll: false, lookUntil: 0, petted: false,
    };
    root.on("pointerover", () => {
      d.lookUntil = Infinity;
      if (!cardFromKeys) showCard(p.id);
    });
    root.on("pointerout", () => {
      d.lookUntil = performance.now() + 1000;
      showCard(cardFromKeys ? selected : null);
    });
    root.on("pointertap", () => {
      selected = d.id;
      paintSelection();
      open(d.person.target);
    });
    return d;
  }

  // ---- props and pets ----
  let bowlAt: PetPlace | null = null;
  let bedAt: PetPlace | null = null;
  const propSprites: Pixi.Sprite[] = [];
  function homeFloor(): FloorVis | null {
    const fl = model?.floors.find((f) => f.room === "study" && f.kind !== "basement") ?? model?.floors.find((f) => f.kind !== "basement");
    return fl ? floorVis.get(fl.key) ?? null : null;
  }
  function placeProps() {
    if (!P || !layout) return;
    for (const s of propSprites.splice(0)) s.destroy();
    const home = homeFloor();
    if (!home) return;
    const right = layout.room.x + layout.room.w;
    const put = (k: string, x: number, h: number) => {
      const s = new P!.Sprite(tex[`prop:${k}`]);
      s.anchor.set(0.5, 1);
      s.height = h;
      s.scale.x = s.scale.y;
      s.position.set(x, STAND + 2);
      home.props.addChild(s);
      propSprites.push(s);
    };
    put("bowlFood", right - 210, 16);
    put("bowlWater", right - 180, 15);
    put("catBed", right - 90, 22);
    bowlAt = { floor: home.key, x: right - 195 };
    bedAt = { floor: home.key, x: right - 90 };
  }

  function ensurePets() {
    if (!P || pets.length) return;
    const home = homeFloor();
    if (!home || !layout) return;
    for (const kind of ["cat", "dog"] as PetKind[]) {
      const s = new P.Sprite(tex[kind === "cat" ? "cat:nap" : "dog:sit"]);
      s.anchor.set(0.5, 1);
      s.eventMode = "static";
      s.cursor = "pointer";
      const pet: PetVis = { kind, sprite: s, floor: home.key, x: layout.room.x + layout.room.w - (kind === "cat" ? 90 : 300), steps: [], until: 0, act: "walk", goal: "", touchedUntil: 0 };
      // Touched, a pet answers: hovering, the cat stretches and the dog wags; a click gets a heart too.
      s.on("pointerover", () => { pet.touchedUntil = performance.now() + 700; });
      s.on("pointertap", () => {
        pet.touchedUntil = performance.now() + 900;
        heart(pet);
      });
      home.pets.addChild(s);
      pets.push(pet);
    }
  }
  function heart(pet: PetVis) {
    if (!P) return;
    const h = text("♥", 16, 0xff6b8a, "600");
    h.anchor.set(0.5, 1);
    h.position.set(pet.sprite.x, pet.sprite.y - pet.sprite.height);
    pet.sprite.parent?.addChild(h);
    const born = performance.now();
    const tick = () => {
      const t = (performance.now() - born) / 700;
      if (t >= 1 || h.destroyed) {
        app?.ticker.remove(tick);
        if (!h.destroyed) h.destroy();
        return;
      }
      h.y = pet.sprite.y - pet.sprite.height - 18 * t;
      h.alpha = 1 - t;
    };
    app?.ticker.add(tick);
  }

  function petWorld(): PetWorld | null {
    if (!layout || !model || !bowlAt || !bedAt) return null;
    const floors = model.floors.filter((f) => f.kind !== "basement").map((f) => ({ key: f.key, width: layout!.room.x + layout!.room.w }));
    const at = (id: string | null): PetPlace | null => {
      const d = id ? desks.get(id) : null;
      return d && d.floor !== "archived" ? { floor: d.floor, x: d.x } : null;
    };
    const idle = people().filter((p) => p.state === "idle" && p.since).sort((a, b) => Date.parse(a.since!) - Date.parse(b.since!))[0];
    return { floors, bowl: bowlAt, bed: bedAt, longestWait: at(model.longestWait), longestIdle: at(idle?.id ?? null) };
  }
  /** Turn an errand into steps: walk to the lift, ride, walk out, then stay. */
  function stepsFor(pet: PetVis, e: Errand): Step[] {
    const liftX = (layout?.shaft.x ?? 0) + (layout?.shaft.w ?? 0) / 2;
    const out: Step[] = [];
    if (e.to.floor !== pet.floor) {
      out.push({ kind: "walk", floor: pet.floor, x: liftX }, { kind: "ride", to: e.to.floor });
    }
    out.push({ kind: "walk", floor: e.to.floor, x: e.to.x }, { kind: "stay", act: e.then, ms: e.stayMs });
    return out;
  }
  function plan(pet: PetVis, now: number) {
    const w = petWorld();
    if (!w) return;
    const e = planErrand(pet.kind, { floor: pet.floor, x: pet.x }, w);
    pet.goal = `${e.to.floor}:${Math.round(e.to.x)}:${e.then}`;
    pet.steps = stepsFor(pet, e);
    pet.until = now;
    if (reduced()) {
      // No walking under reduced motion: the pet is simply where it is going.
      const last = pet.steps.filter((s): s is Extract<Step, { kind: "walk" }> => s.kind === "walk").pop();
      if (last) moveToFloor(pet, last.floor, last.x);
      pet.steps = pet.steps.filter((s) => s.kind === "stay");
    }
  }
  function moveToFloor(pet: PetVis, floor: string, x: number) {
    const v = floorVis.get(floor);
    if (!v) return;
    pet.floor = floor;
    pet.x = x;
    if (pet.sprite.parent !== v.pets) v.pets.addChild(pet.sprite);
  }
  function restingCarY(): number {
    const here = people().find((p) => p.current);
    const f = (here ? layout?.floors.find((x) => x.key === desks.get(here.id)?.floor) : null) ?? layout?.floors[0];
    return f ? f.y + STAND + 4 : 0;
  }

  function petFrame(pet: PetVis, now: number, dt: number) {
    const s = pet.sprite;
    let pic: string = pet.kind === "cat" ? "cat:sit" : "dog:sit";
    let h = pet.kind === "cat" ? 34 : 42;
    let face = 1;
    let bob = 0;
    const step = pet.steps[0];
    // The dog keeps whoever has waited longest company: a new longest wait sends it there at once.
    if (pet.kind === "dog" && model && liftBusy !== pet) {
      const w = petWorld();
      const want = w?.longestWait ? `${w.longestWait.floor}:${Math.round(w.longestWait.x - 28)}:sit` : "";
      if (want && want !== pet.goal && step?.kind !== "ride") plan(pet, now);
    }
    if (!step) {
      plan(pet, now);
    } else if (step.kind === "walk") {
      if (step.floor !== pet.floor) moveToFloor(pet, step.floor, pet.x);
      const dx = step.x - pet.x;
      const go = SPEED[pet.kind] * dt / 1000;
      if (Math.abs(dx) <= go || reduced()) {
        pet.x = step.x;
        pet.steps.shift();
      } else {
        pet.x += Math.sign(dx) * go;
        face = dx > 0 ? -1 : 1; // the walking pictures face left
        pic = `${pet.kind}:walk`;
        h = pet.kind === "cat" ? 30 : 38;
        bob = -Math.abs(Math.sin(now / 90)) * 2;
      }
    } else if (step.kind === "ride") {
      if (liftBusy && liftBusy !== pet) {
        // One pet in the lift at a time: wait by the doors.
      } else if (layout) {
        liftBusy = pet;
        const from = layout.floors.find((f) => f.key === pet.floor);
        const to = layout.floors.find((f) => f.key === step.to);
        const fromY = from ? from.y + STAND + 4 : carY;
        const toY = to ? to.y + STAND + 4 : carY;
        if (pet.act !== "ride") {
          // First the car comes to this floor; then the pet steps in and rides.
          carTarget = fromY;
          if (Math.abs(carY - fromY) < 1) {
            pet.act = "ride";
            rideLayer?.addChild(s);
            carTarget = toY;
          }
        } else if (!to) {
          // The floor it was going to has gone: the ride ends, and the pet goes home.
          pet.steps = [];
          pet.act = "walk";
          liftBusy = null;
          const home = homeFloor();
          if (home) moveToFloor(pet, home.key, (layout?.room.x ?? 0) + 200);
        } else if (Math.abs(carY - toY) >= 1) {
          // Sent every frame: a rebuild mid-ride must not leave the car parked.
          carTarget = toY;
        } else {
          moveToFloor(pet, step.to, pet.x);
          pet.steps.shift();
          pet.act = "walk";
          liftBusy = null;
        }
      }
    } else if (step.kind === "stay") {
      if (pet.act === "walk" || pet.act === "ride") {
        pet.act = step.act;
        pet.until = now + step.ms;
      }
      if (step.act === "nap") { pic = "cat:nap"; h = 26; }
      else if (step.act === "eat") { pic = pet.kind === "cat" ? "cat:sit" : "dog:lie"; h = pet.kind === "cat" ? 32 : 26; face = -1; }
      else { pic = pet.kind === "cat" ? "cat:sit" : "dog:sit"; }
      if (now >= pet.until) {
        pet.steps.shift();
        pet.act = "walk";
      }
    }
    if (now < pet.touchedUntil) {
      if (pet.kind === "cat") { pic = "cat:stretch"; h = 30; }
      else s.rotation = Math.sin(now / 40) * 0.12;
    } else {
      s.rotation = 0;
    }
    const t = tex[pic];
    if (t && s.texture !== t) s.texture = t;
    s.scale.set(1);
    s.scale.set((h / s.texture.height) * face, h / s.texture.height);
    if (pet.act === "ride" && liftBusy === pet && layout) {
      s.position.set(layout.shaft.x + layout.shaft.w / 2, carY - 6);
    } else {
      s.position.set(pet.x, STAND + 2 + bob);
    }
  }

  // ---- every frame: breathing, typing, strolls, fades, pets, the lift, weather, the camera ----
  function frameUpdate(dt: number) {
    if (!app || !layout || !model || !sky || !worldLayer) return;
    const now = performance.now();
    const still = reduced();

    // Camera glides toward its target.
    const k = still ? 1 : 1 - Math.exp(-dt / 120);
    cam.s += (cam.ts - cam.s) * k;
    cam.x += (cam.tx - cam.x) * k;
    cam.y += (cam.ty - cam.y) * k;
    worldLayer.scale.set(cam.s);
    worldLayer.position.set(Math.round(app.screen.width / 2 - cam.x * cam.s), Math.round(app.screen.height / 2 - cam.y * cam.s));
    // Tags and plates keep one size on screen whatever the zoom: they are read, not looked at.
    const tagScale = clamp(1 / cam.s, 0.45, 1.7);

    // Outside: the real time of day, the chosen weather, a little parallax.
    const phase = skyAt(new Date(host?.now() ?? Date.now()));
    if (phase !== skyPhase) {
      skyPhase = phase;
      sky.texture = tex[`sky:${phase}`];
    }
    sky.width = app.screen.width;
    sky.height = app.screen.height;
    const ts = app.screen.height / sky.texture.height;
    sky.tileScale.set(ts);
    sky.tilePosition.set(-cam.x * cam.s * 0.25, 0);
    weatherFrame(dt, now, still);

    const dark = darkFloors();
    for (const [key, v] of floorVis) {
      const off = dark.has(key);
      v.dark.alpha += ((off ? 1 : 0) - v.dark.alpha) * (still ? 1 : 1 - Math.exp(-dt / 160));
      v.glow.alpha = v.dark.alpha;
      v.sw.texture = tex[off ? "prop:switchOff" : "prop:switchOn"];
      for (const s of v.ui.children) if (s !== v.plate && s !== v.sw) s.scale.set(tagScale);
      v.plate.scale.set(tagScale);
    }

    for (const d of desks.values()) deskFrame(d, now, dt, still, tagScale);
    for (const pet of pets) petFrame(pet, now, dt);

    // The lift car glides between floors.
    if (car) {
      const dy = carTarget - carY;
      const go = 420 * dt / 1000;
      carY = still || Math.abs(dy) <= go ? carTarget : carY + Math.sign(dy) * go;
      car.position.set(layout.shaft.x + layout.shaft.w / 2, carY);
      car.height = 126;
      car.scale.x = car.scale.y;
      if (!liftBusy) {
        const rest = restingCarY();
        if (Math.abs(carTarget - rest) > 1) carTarget = rest;
      }
    }
    if (carded) placeCard();
  }

  function deskFrame(d: DeskVis, now: number, dt: number, still: boolean, tagScale: number) {
    const p = d.person;
    const basement = d.floor === "archived";
    const looking = now < d.lookUntil && (p.pose === "typing" || p.pose === "hand-up" || p.pose === "calm");
    const catHere = pets.find((x) => x.kind === "cat" && x.act === "visit" && x.floor === d.floor && Math.abs(x.x - (d.x + 88)) < 6);
    d.petted = !!catHere && p.pose === "away";
    const pic: Pic = d.petted ? "bend" : looking ? "calm" : p.pose;
    const seated = pic !== "away" && pic !== "bend";
    const want = seated ? tex[`seated:${pic}`] : tex[`person:${pic}`];
    if (d.pic !== pic) {
      // A new pose fades in over the old; a person's first pose is just there.
      const first = d.pic === null;
      d.on = first ? d.on : (d.on === 0 ? 1 : 0);
      d.fadeAt = first || still ? now - 1000 : now;
      d.pic = pic;
      d.poses[d.on].texture = want;
    }
    const fade = clamp((now - d.fadeAt) / 220, 0, 1);
    const cur = d.poses[d.on];
    const old = d.poses[d.on === 0 ? 1 : 0];
    const full = tex[`person:${pic}`];
    const scale = POSE_H[pic] / full.height;
    // Alive, never frozen: everyone breathes out of step; typing bobs; a raised hand sways; only idle people walk.
    const t = now + d.phase;
    let bob = still ? 0 : -Math.round((Math.sin(t / 2800 * Math.PI * 2) + 1) / 2);
    let rot = 0;
    let dx = 0;
    let faceRight = false;
    if (!still && pic === "typing") bob = -Math.round((Math.sin(t / 230 * Math.PI) + 1) * 0.75);
    if (!still && pic === "hand-up") rot = Math.sin(t / 1700 * Math.PI * 2) * 0.026;
    if (pic === "away") {
      const s = still || !d.stroll ? { dx: 0, faceRight: false, walking: false } : strollAt(t);
      dx = s.dx;
      faceRight = s.faceRight;
      if (s.walking) bob = -Math.round(Math.abs(Math.sin(t / 170 * Math.PI)) * 2);
    }
    cur.scale.set(faceRight ? -scale : scale, scale);
    cur.position.set(seated ? 0 : 58 + dx, (seated ? DESKTOP + 2 : STAND) + bob);
    cur.rotation = rot;
    cur.alpha = (pic === "ghost" ? 0.55 - (still ? 0 : (Math.sin(t / 3000 * Math.PI * 2) + 1) * 0.08) : 1) * fade;
    old.alpha = (1 - fade) * (old.alpha > 0 ? 1 : 0);
    if (fade >= 1) old.alpha = 0;
    // Seated people sit behind the laptop, in front of the chair: above the desk picture. Standing ones in front of it all.
    const order = d.root;
    order.setChildIndex(cur, seated ? order.getChildIndex(d.desk) + 1 : order.children.length - 1);
    cur.visible = old.visible = !basement;

    // The laptop: open in front of a seated person, glowing while they type.
    // A sleeper's laptop has gone dark; a ghost's state is not known, so it lights nothing.
    const lit = seated && pic !== "ghost" && pic !== "asleep";
    const glow = pic === "typing" && !still ? 0.35 + Math.sin(t / 2400 * Math.PI * 2) * 0.12 : lit ? 0.25 : 0;
    const open = !basement && pic !== "away" && pic !== "bend";
    if (d.laptopKey !== String(open)) {
      d.laptopKey = String(open);
      d.laptop.clear();
      if (open) {
        d.laptop.rect(-15, DESKTOP - 15, 30, 15).fill(0x3a3f4a).stroke({ width: 2, color: 0x1d2027 });
        d.laptop.rect(-5, DESKTOP - 11, 6, 3).fill(0x8a93a6);
      }
    }
    d.screen.visible = open && glow > 0;
    d.screen.alpha = glow;
    // In the dark, an open laptop lights the face above it.
    d.face.visible = lit && !basement;
    d.face.position.set(d.x, DESKTOP - 26);
    d.face.alpha = 0.5 + (pic === "typing" && !still ? Math.sin(t / 2400 * Math.PI * 2) * 0.1 : 0);

    // The pool of light under someone who needs you.
    d.light.visible = p.state === "waiting" && !basement;
    d.light.alpha = 0.55 + (still ? 0 : Math.sin(now / 2000 * Math.PI * 2) * 0.08);
    d.light.blendMode = "add";

    d.desk.tint = basement ? 0x8a8478 : 0xffffff;

    // The sheets: one per window, coloured by account, the flagged one on top.
    const key = basement ? "dust" : p.sheets.map((s) => `${s.slot}${s.flag ? "f" : ""}${s.dashed ? "d" : ""}${s.amber ? "a" : ""}`).join(",");
    if (key !== d.sheetsKey) {
      d.sheetsKey = key;
      d.sheets.clear();
      if (!basement) {
        const order2 = [...p.sheets.filter((s) => !s.flag), ...p.sheets.filter((s) => s.flag)].slice(-SHEETS_SHOWN);
        order2.forEach((s, i) => {
          const y = DESKTOP - 5 - i * 5;
          const c = s.amber ? 0xe3b73a : colourHex(s.slot);
          if (s.dashed) d.sheets.rect(22, y, 18, 5).stroke({ width: 1, color: c, alpha: 0.9 });
          else d.sheets.rect(22, y, 18, 5).fill(c).stroke({ width: 1, color: 0x2b241c });
          if (s.flag) d.sheets.rect(22, y, 18, 5).stroke({ width: 1.5, color: FLAG }).rect(41, y - 8, 4, 8).fill(FLAG);
        });
      } else {
        // The basement's desks wear dust sheets.
        d.sheets.roundRect(-46, STAND - 74, 92, 74, 26).fill({ color: 0xd8d2c1, alpha: 0.95 });
      }
    }

    // The tag: name, state as text, jobs when chosen.
    const sel = d.id === selected;
    const tagKey = `${p.label}|${p.status}|${p.jobs}|${sel}|${p.current}|${p.state}`;
    if (tagKey !== d.tagKey) {
      d.tagKey = tagKey;
      d.tagName.text = p.label;
      d.tagStatus.text = p.status;
      d.tagStatus.style.fill = p.state === "waiting" ? LIGHT : p.state === "working" ? 0x8fdcb0 : 0x8a93a6;
      d.tagJobs.text = sel ? p.jobs : "";
      const w = Math.max(d.tagName.width, d.tagStatus.width, d.tagJobs.width) + 12;
      const h = sel ? 44 : 31;
      d.tagName.position.set(0, -h + 2);
      d.tagStatus.position.set(0, -h + 16);
      d.tagJobs.position.set(0, -h + 29);
      d.tagBg.clear().rect(-w / 2, -h, w, h).fill({ color: 0x0d1020, alpha: 0.9 })
        .stroke({ width: sel || p.current ? 1.5 : 1, color: sel || p.current ? LIGHT : 0x2a3350 });
      d.here.visible = p.current;
    }
    d.tag.position.set(d.x, VAULT.roomH - 2);
    d.tag.scale.set(tagScale);
    d.here.position.set(0, -(VAULT.roomH - 26) / tagScale);
    void dt;
  }

  // Rain, snow, storm or fog, outside only: drawn behind the building, seen around it and through the glass.
  function weatherFrame(dt: number, now: number, still: boolean) {
    if (!app || !weatherLayer || !flash || !P) return;
    const w = weather();
    const W = app.screen.width;
    const H = app.screen.height;
    const count = w === "rain" ? 240 : w === "storm" ? 360 : w === "snow" ? 180 : 0;
    const key = `${w}:${Math.round(W / 100)}:${Math.round(H / 100)}`;
    if (key !== dropsFor) {
      dropsFor = key;
      for (const d of drops.splice(0)) d.s.destroy();
      for (let i = 0; i < count; i++) {
        const s = new P.Sprite(w === "snow" ? P.Texture.WHITE : tex.drop);
        if (w === "snow") {
          const r = 2 + Math.random() * 2.5;
          s.width = s.height = r;
          s.alpha = 0.75;
        } else {
          s.alpha = 0.5 + Math.random() * 0.4;
          s.rotation = 0.18;
        }
        s.position.set(Math.random() * W, Math.random() * H);
        weatherLayer.addChild(s);
        drops.push({ s, vx: w === "snow" ? 0 : -110, vy: w === "snow" ? 30 + Math.random() * 40 : 520 + Math.random() * 260, sway: Math.random() * 6.28 });
      }
    }
    if (!still) {
      for (const d of drops) {
        d.s.y += d.vy * dt / 1000;
        d.s.x += (d.vx + (w === "snow" ? Math.sin(now / 900 + d.sway) * 18 : 0)) * dt / 1000;
        if (d.s.y > H) { d.s.y = -12; d.s.x = Math.random() * (W + 120); }
        if (d.s.x < -20) d.s.x = W + 10;
      }
    }
    // A storm flashes now and then; fog hangs over everything outside.
    flash.clear();
    if (w === "storm" && !still) {
      if (!nextFlash || now > nextFlash + 260) nextFlash = now + 5000 + Math.random() * 9000;
      const t = now - nextFlash;
      if (t > 0 && t < 260) flash.rect(0, 0, W, H).fill({ color: 0xeef2ff, alpha: t < 80 ? 0.35 : t < 160 ? 0.08 : 0.25 });
    }
    weatherLayer.alpha = 1;
    if (w === "fog") flash.rect(0, 0, W, H).fill({ color: 0xc8d0dc, alpha: 0.12 });
    // The flash sits over the world but only shows outside the building: the frame and rooms are drawn above it otherwise.
    if (app.stage.getChildIndex(flash) !== 1) app.stage.setChildIndex(flash, 1);
  }

  // ---- the model, once a second and on every push ----
  function draw() {
    if (!host) return;
    readPrefs();
    paintHud();
    if (!world) return;
    model = deriveBuilding(world, host.now(), rooms());
    const all = people();
    if (!all.some((p) => p.id === selected)) selected = (all.find((p) => p.current) ?? all[0])?.id ?? null;
    // The keyboard's list, in floor order, labelled with the facts.
    const seenB = new Set<string>();
    place(a11y, all, (p) => p.id, buttons, seenB, makeButton, (b, p) => {
      b.dataset.session = p.id;
      if (b.getAttribute("aria-label") !== p.alt) b.setAttribute("aria-label", p.alt);
      setText(b, p.label);
    });
    sweep(buttons, seenB);
    paintSelection();
    rebuild();
    if (carded) paintCard();
    if (!focusTaken && buttons.size) {
      focusTaken = true;
      const active = document.activeElement;
      if (!active || active === document.body) buttons.get(selected ?? "")?.focus({ preventScroll: true });
    }
  }

  return {
    fullWindow: true,
    mount(h) {
      host = h;
      alive = true;
      mountNo++;
      gen.replaceChildren(el("span", "bld-gen-title", "generator"), el("div", "bld-fuels"));
      root.tabIndex = -1;
      root.replaceChildren(hud, stage, gen, card);
      h.root.replaceChildren(root);
      document.fonts?.addEventListener("loadingdone", fontsLanded);
      stopTick = h.tick(1, draw);
      draw();
      boot(mountNo).catch((e) => {
        note.textContent = `The vault could not open: ${e instanceof Error ? e.message : String(e)}`;
        if (!note.isConnected) stage.prepend(note);
      });
    },
    update(next) {
      world = next;
      draw();
    },
    reveal(ref) {
      revealRef(ref);
    },
    unmount() {
      alive = false;
      document.fonts?.removeEventListener("loadingdone", fontsLanded);
      pixelTexts.clear();
      clearTimeout(revealTimer);
      stopTick?.();
      stopTick = null;
      // The textures made here, not the loaded pictures, which Assets caches for the next mount:
      // the seated crops, the glow and the rain drop (with their canvases), each floor's room strips.
      for (const [k, t] of Object.entries(tex)) if (k.startsWith("seated:")) t.destroy();
      tex.glow?.destroy(true);
      tex.drop?.destroy(true);
      for (const v of floorVis.values()) for (const t of v.pieces.splice(0)) t.destroy();
      app?.destroy(true, { children: true });
      app = null;
      P = null;
      sky = weatherLayer = worldLayer = rideLayer = null;
      frame = flash = null;
      car = null;
      floorVis.clear();
      desks.clear();
      pets.length = 0;
      drops.length = 0;
      dropsFor = structure = skyPhase = "";
      layout = null;
      liftBusy = null;
      tex = {};
      propSprites.length = 0;
      bowlAt = bedAt = null;
      Object.assign(cam, { x: 0, y: 0, s: 1, tx: 0, ty: 0, ts: 1, manual: false });
      carY = carTarget = 0;
      nextFlash = 0;
      host = null;
      focusTaken = false;
      carded = null;
      cardFromKeys = false;
      card.classList.remove("show");
      pills.clear();
      fuels.clear();
      buttons.clear();
      a11y.replaceChildren();
      stage.replaceChildren(note, a11y);
      note.textContent = "Opening the vault…";
    },
  };
}
