// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Aditya Wirya Darma. Additional terms: see NOTICE.

import { Terminal } from "@xterm/xterm";
import type { AgentKind } from "../../shared/chat";
import type { Card, CardOption, GenericKey } from "../../shared/conversation";
import type { ClientMessage, ServerMessage } from "../../shared/protocol";
import { palette } from "../terminal";
import { appearance, onAppearance } from "../theme";
import { answerMessage, CONV_ERROR, cardArmedAt, cardButtons, cardTitle, wordsOptional } from "./model";

/**
 * What the agent waits on, answered from the phone: the waiting card, which
 * takes the text box's place while a dialog the server recognised is up, and
 * Screen, the way out for everything else (a read-only capture of the pane
 * with the generic keys). Card text comes from the agent's screen: it is set
 * as text, never as markup.
 */

type Result = Extract<ServerMessage, { t: "conv-result" }>;
type ScreenResult = Extract<ServerMessage, { t: "conv-screen-result" }>;

/** An answer with no `conv-result` by then is given up, so the card can be tapped again. */
const ANSWER_GIVE_UP_MS = 15_000;
/** An answer the agent took, on a dialog that is still up this long after: tappable again (its keys didn't land). */
const ANSWERED_HOLD_MS = 4000;
/** A key with no answer by then is given up, so the keys come back whatever happened to it. */
const KEY_GIVE_UP_MS = 10_000;
/** Screen standing in for a tab with no agent reads the pane again this often: nothing else says it has changed. */
const LIVE_MS = 1000;
/** A read with no answer by then is given up, so those reads go on. */
const READ_GIVE_UP_MS = 5000;
/** Screen's view padding (style.css `.conv-screen-view`), top and bottom. */
const VIEW_PAD = 16;
/** CSI and OSC sequences, to tell a blank row from one with text. */
const ESCAPES = /\x1b\[[0-9;:?<=>]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(cls: string, text: string): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  return b;
}

// ---- the waiting card ----

export interface CardDeps {
  send(m: ClientMessage): void;
  toast(m: string): void;
  /** The tab and conversation the view shows (the latest `conv`'s); null while there is none. An answer names the card's own conversation. */
  target(): { windowId: string; conversation: string } | null;
  openScreen(): void;
}

export interface WaitingCard {
  el: HTMLElement;
  /** What the latest `conv-card` says: a card read for `conversation`, Screen's offer (`screen`), or neither (hidden). */
  show(card: Card | null, screen: boolean, agent: AgentKind | null | undefined, conversation: string | null): void;
  /** True when `m` answers this card's answer (handled here). */
  result(m: Result): boolean;
  /** Forget the card and any answer in flight: another tab, or none. */
  reset(): void;
}

export function createWaitingCard(deps: CardDeps): WaitingCard {
  const root = el("div", "conv-card");
  root.hidden = true;
  root.setAttribute("role", "group");

  /** The card drawn, or null for Screen's offer or nothing, and the conversation it was read for. */
  let shown: Card | null = null;
  let shownFor: string | null = null;
  let shownScreen = false;
  /**
   * An answer out (`req` set) or taken by the agent (`req` null) for the
   * dialog read as `fingerprint`: the buttons stay off until that dialog goes.
   */
  let answering: { req: string | null; fingerprint: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The answer was refused as stale: off until the fresh card comes. */
  let stale = false;
  /** When the card shown starts taking taps (a new dialog waits a moment), and the timer that turns it on then. */
  let armAt = 0;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  /** The field an option's words are being typed in, with its Send. */
  let field: { input: HTMLTextAreaElement; send: HTMLButtonElement } | null = null;
  const buttons: HTMLButtonElement[] = [];

  function dropAnswer() {
    if (answering) clearTimeout(answering.timer);
    answering = null;
  }

  const busy = () => answering !== null || stale || Date.now() < armAt;

  function paintBusy() {
    root.classList.toggle("busy", busy());
    for (const b of buttons) b.disabled = busy();
    if (field && shown) field.send.disabled = busy() || (field.input.value.trim() === "" && !wordsOptional(shown));
  }

  function answer(option: CardOption, words?: string) {
    const t = deps.target();
    if (!t || !shown || busy()) return;
    const req = `answer-${++seq}`;
    const m = answerMessage({ card: shown, for: shownFor }, t, req, option, words);
    if (!m) return;
    const timer = setTimeout(() => {
      dropAnswer();
      paintBusy();
    }, ANSWER_GIVE_UP_MS);
    answering = { req, fingerprint: shown.fingerprint, timer };
    deps.send(m);
    paintBusy();
  }

  function optionButton(o: CardOption, cls: string): HTMLButtonElement {
    const b = button(cls, o.label);
    // As text, under the label: it comes from the agent's screen.
    if (o.description) b.append(el("span", "conv-card-desc", o.description));
    b.onclick = () => (o.takesText ? openField(o) : answer(o));
    buttons.push(b);
    return b;
  }

  /** The option's words, typed before it is sent. */
  function openField(o: CardOption) {
    if (!shown || busy()) return;
    const card = shown;
    const box = el("div", "conv-card-field");
    const input = el("textarea", "conv-input conv-card-input");
    input.rows = 3;
    input.placeholder = wordsOptional(card) ? "What to do instead (optional)" : "Your answer";
    input.setAttribute("aria-label", o.label);
    const send = button("conv-card-btn main", "Send");
    const back = button("conv-card-btn", "Back");
    send.onclick = () => answer(o, input.value);
    back.onclick = () => draw(card);
    input.addEventListener("input", paintBusy);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        if (!send.disabled) send.click();
      }
    });
    const row = el("div", "conv-card-buttons inline");
    row.append(send, back);
    box.append(el("div", "conv-card-field-label", o.label), input, row);
    buttons.length = 0;
    buttons.push(back);
    field = { input, send };
    root.querySelector(".conv-card-choices")?.replaceWith(box);
    paintBusy();
    input.focus();
  }

  function head(agent: AgentKind | null | undefined, card: Card | null): HTMLElement {
    const who = agent ? AGENT_NAME[agent] : "The agent";
    const of = card?.question && card.question.of > 1 ? ` · question ${card.question.at} of ${card.question.of}` : "";
    return el("div", "conv-card-meta", card ? `${who} asks${of}` : `${who} is waiting`);
  }

  let agentShown: AgentKind | null | undefined;

  function draw(card: Card) {
    field = null;
    buttons.length = 0;
    // Who asks and what, held at the top while a long card scrolls under it.
    const top = el("div", "conv-card-head");
    top.append(head(agentShown, card), el("div", "conv-card-title", cardTitle(card)));
    const parts: HTMLElement[] = [top];
    // As text: it comes from the agent's screen.
    if (card.description) parts.push(el("div", "conv-card-description", card.description));
    if (card.detail) parts.push(el("pre", "conv-pre conv-card-detail", card.detail));
    const { primary, secondary } = cardButtons(card);
    const choices = el("div", "conv-card-choices");
    const main = el("div", "conv-card-buttons");
    // A question's answers are equals; a decision (allow, approve, submit) has a main button.
    const decision = !card.question;
    primary.forEach((o, i) => main.append(optionButton(o, `conv-card-btn${decision && i === 0 ? " main" : ""}`)));
    choices.append(main);
    if (secondary.length > 0) {
      const more = el("div", "conv-card-buttons quiet");
      for (const o of secondary) more.append(optionButton(o, "conv-card-btn quiet"));
      choices.append(more);
    }
    parts.push(choices);
    root.replaceChildren(...parts);
    paintBusy();
  }

  function drawScreenOffer() {
    field = null;
    buttons.length = 0;
    const open = button("conv-card-btn main", "Open Screen");
    open.onclick = () => deps.openScreen();
    const row = el("div", "conv-card-buttons inline");
    row.append(open);
    root.replaceChildren(head(agentShown, null), el("div", "conv-card-title", "It is waiting on something only its screen shows"), row);
  }

  return {
    el: root,
    show(card, screen, agent, conversation) {
      agentShown = agent;
      // A card read for another conversation than the one drawn is another card, whatever its fingerprint.
      if (conversation !== shownFor) {
        dropAnswer();
        field = null;
        armAt = 0;
        shown = null;
        root.replaceChildren();
      }
      shownFor = conversation;
      stale = false;
      if (answering && answering.fingerprint !== card?.fingerprint) dropAnswer();
      if (card) {
        const now = Date.now();
        armAt = cardArmedAt(shown ? { fingerprint: shown.fingerprint, at: armAt } : null, card.fingerprint, now);
        clearTimeout(armTimer);
        if (armAt > now) armTimer = setTimeout(paintBusy, armAt - now + 1);
      }
      const same = card && shown ? card.fingerprint === shown.fingerprint : !card && !shown && screen === shownScreen;
      shown = card;
      shownScreen = !card && screen;
      root.hidden = !card && !screen;
      // The same dialog again (its highlight moved, the agent's state changed): what was typed stays.
      if (!same || root.childElementCount === 0) {
        if (card) draw(card);
        else if (screen) drawScreenOffer();
        else root.replaceChildren();
      }
      paintBusy();
    },
    result(m) {
      if (!answering || answering.req === null || m.req !== answering.req) return false;
      if (m.ok) {
        // Taken: held until the dialog goes, or a while if it never does (its keys didn't land).
        clearTimeout(answering.timer);
        answering.req = null;
        answering.timer = setTimeout(() => {
          dropAnswer();
          paintBusy();
        }, ANSWERED_HOLD_MS);
      } else {
        dropAnswer();
        // Unsent: the words are in the dialog's field at the desk, and what it shows now is not known.
        if (m.error === "prompt-changed" || m.error === "unsent") {
          deps.toast(CONV_ERROR[m.error]);
          // Off until the card is read afresh: opening the tab again sends it, whatever the server last sent.
          stale = true;
          const t = deps.target();
          if (t) deps.send({ t: "conv-open", windowId: t.windowId });
        } else if (m.error) deps.toast(CONV_ERROR[m.error]);
        // Neither: the action threw, and an `error` message (shown by the page) says why.
      }
      paintBusy();
      return true;
    },
    reset() {
      dropAnswer();
      stale = false;
      armAt = 0;
      clearTimeout(armTimer);
      shown = null;
      shownFor = null;
      shownScreen = false;
      field = null;
      buttons.length = 0;
      root.replaceChildren();
      root.hidden = true;
    },
  };
}

// ---- Screen ----

const KEYS: { label: string; key: GenericKey; name: string }[] = [
  { label: "1", key: "1", name: "1" },
  { label: "2", key: "2", name: "2" },
  { label: "3", key: "3", name: "3" },
  { label: "4", key: "4", name: "4" },
  { label: "5", key: "5", name: "5" },
  { label: "Enter", key: "Enter", name: "Enter" },
  { label: "Esc", key: "Escape", name: "Escape" },
  { label: "↑", key: "Up", name: "Up arrow" },
  { label: "↓", key: "Down", name: "Down arrow" },
  { label: "Tab", key: "Tab", name: "Tab" },
];

export interface ScreenDeps {
  send(m: ClientMessage): void;
  toast(m: string): void;
  /** The tab whose pane Screen shows; null while none is. */
  windowId(): string | null;
}

export interface ScreenView {
  el: HTMLElement;
  /** Show it over the conversation and read the pane; `fixed` (a tab with no agent) has no Close. */
  open(fixed: boolean): void;
  close(): void;
  /** Open, and whether it is the fixed one. */
  state(): "closed" | "open" | "fixed";
  result(m: ScreenResult): void;
}

export function createScreen(deps: ScreenDeps): ScreenView {
  const root = el("section", "conv-screen");
  root.hidden = true;
  root.setAttribute("aria-label", "Screen: the tab's terminal, read-only");
  const bar = el("div", "conv-screen-bar");
  const title = el("div", "conv-screen-title", "Screen");
  title.append(el("span", "conv-screen-hint", "read-only"));
  const refreshBtn = button("conv-screen-btn", "Refresh");
  const closeBtn = button("conv-screen-btn", "Close");
  bar.append(title, refreshBtn, closeBtn);
  const view = el("div", "conv-screen-view");
  const host = el("div", "conv-screen-term");
  const note = el("div", "conv-screen-note");
  view.append(host, note);
  const keys = el("div", "conv-screen-keys");
  const keyButtons = KEYS.map((k) => {
    const b = button("conv-screen-key", k.label);
    b.setAttribute("aria-label", `Press ${k.name}`);
    b.onclick = () => press(k.key);
    return b;
  });
  keys.append(...keyButtons);
  root.append(bar, view, keys);

  let mode: "closed" | "open" | "fixed" = "closed";
  /** `blind`: made while Screen had no size (a chat over the page), so xterm measured nothing: made again once it has one. */
  let term: { t: Terminal; off: () => void; blind: boolean } | null = null;
  /** The capture asked for last (a read, or a key's screen after it): an older one's answer is not drawn. */
  let latest: string | null = null;
  /** When the last read was asked for. */
  let askedAt = 0;
  let seq = 0;
  /** The capture drawn: one the same is not drawn again, so a reader scrolled up in it stays there. */
  let shown: string | null = null;
  /** Reads the pane again while Screen is the fixed one: a new Claude at its trust prompt has no hook to say it drew. */
  let live: ReturnType<typeof setInterval> | undefined;
  /** The screen drawn's token, which a key pressed on it carries; null until one is drawn. */
  let token: string | null = null;
  /** A key out: the keys stay off until its answer, so each key is pressed on the screen the one before left. */
  let keyOut: { req: string; timer: ReturnType<typeof setTimeout> } | null = null;

  function paintKeys() {
    for (const b of keyButtons) b.disabled = token === null || keyOut !== null;
  }

  function dropKey() {
    if (keyOut) clearTimeout(keyOut.timer);
    keyOut = null;
  }

  function dropTerm() {
    term?.off();
    term?.t.dispose();
    term = null;
    shown = null;
    host.replaceChildren();
  }

  /** `again`: a re-read, which leaves the note as it is (a "Couldn't read" stays up rather than flicker). */
  function refresh(again = false) {
    const windowId = deps.windowId();
    if (mode === "closed" || !windowId) return;
    latest = `screen-${++seq}`;
    askedAt = Date.now();
    if (!term && !again) {
      note.textContent = "Reading the screen…";
      note.hidden = false;
    }
    deps.send({ t: "conv-screen", req: latest, windowId });
  }

  /** The fixed Screen's next read: not over a key or a read still out, nor while nothing of it shows. */
  function reread() {
    if (mode !== "fixed" || keyOut || document.hidden || view.clientWidth === 0) return;
    if (latest !== null && Date.now() - askedAt < READ_GIVE_UP_MS) return;
    refresh(true);
  }

  /** A key, on the screen drawn: refused by the server if that has changed since. Its answer is the screen after it. */
  function press(key: GenericKey) {
    const windowId = deps.windowId();
    if (mode === "closed" || !windowId || token === null || keyOut) return;
    const req = `key-${++seq}`;
    latest = req;
    keyOut = { req, timer: setTimeout(() => { keyOut = null; paintKeys(); }, KEY_GIVE_UP_MS) };
    deps.send({ t: "conv-key", req, windowId, token, key });
    paintKeys();
  }

  /** A terminal of the pane's size, made once Screen is on the page (xterm measures its cells when opened). */
  function terminal(cols: number, rows: number): Terminal {
    if (term?.blind && view.clientWidth > 0) dropTerm();
    if (term) {
      term.t.reset();
      if (term.t.cols !== cols || term.t.rows !== rows) term.t.resize(cols, rows);
      return term.t;
    }
    const p = palette(appearance());
    const t = new Terminal({
      cols, rows, disableStdin: true, convertEol: true, scrollback: 0,
      fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 11, lineHeight: 1,
      theme: p.theme, minimumContrastRatio: p.minimumContrastRatio,
    });
    t.open(host);
    // A tap must not raise a keyboard: nothing is typed here.
    t.textarea?.setAttribute("inputmode", "none");
    if (t.textarea) {
      t.textarea.readOnly = true;
      t.textarea.tabIndex = -1;
    }
    const off = onAppearance((a) => {
      const q = palette(a);
      t.options.theme = q.theme;
      t.options.minimumContrastRatio = q.minimumContrastRatio;
    });
    term = { t, off, blind: view.clientWidth === 0 };
    return t;
  }

  paintKeys();
  refreshBtn.onclick = () => refresh();
  // A terminal made while hidden is drawn at the wrong cell size: read the pane again, to make it anew, once it shows.
  new ResizeObserver(() => { if (term?.blind && view.clientWidth > 0) refresh(); }).observe(view);
  closeBtn.onclick = () => close();

  function close() {
    mode = "closed";
    clearInterval(live);
    live = undefined;
    root.hidden = true;
    latest = null;
    token = null;
    dropKey();
    paintKeys();
    dropTerm();
  }

  return {
    el: root,
    open(fixed) {
      mode = fixed ? "fixed" : "open";
      closeBtn.hidden = fixed;
      root.hidden = false;
      clearInterval(live);
      live = fixed ? setInterval(reread, LIVE_MS) : undefined;
      refresh();
    },
    close,
    state: () => mode,
    result(m) {
      if (keyOut?.req === m.req) {
        dropKey();
        if (m.error) deps.toast("Not pressed: the screen had changed. Here it is now");
      }
      if (mode === "closed" || m.req !== latest) return paintKeys();
      latest = null;
      token = m.token || null;
      paintKeys();
      if (!m.ansi || m.cols <= 0 || m.rows <= 0) {
        token = null;
        paintKeys();
        dropTerm();
        note.textContent = "Couldn't read the screen";
        note.hidden = false;
        return;
      }
      note.hidden = true;
      if (term && !term.blind && m.ansi === shown && term.t.cols === m.cols && term.t.rows === m.rows) return;
      shown = m.ansi;
      // `capture-pane -p` ends every row with a newline: the last one would scroll the top row away.
      const ansi = m.ansi.replace(/\n$/, "");
      const rows = m.rows;
      terminal(m.cols, rows).write(`${ansi}\x1b[?25l`, () => {
        // The last row with anything on it at the bottom of the view: an agent's dialog and prompt sit at the
        // foot of its pane, a shell's few lines at the top.
        const lines = ansi.split("\n");
        let last = Math.min(lines.length, rows) - 1;
        while (last > 0 && !/\S/.test(lines[last]!.replace(ESCAPES, ""))) last--;
        const rowPx = host.offsetHeight / rows;
        view.scrollTop = Math.max(0, (last + 1) * rowPx + VIEW_PAD - view.clientHeight);
      });
    },
  };
}
