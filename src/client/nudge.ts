import type { SessionInfo, SwapNotice } from "../shared/protocol";
import { windowPlace } from "./labels";
import { formatBytes, formatRate } from "./system";

/**
 * The whole-page nudge for an urgent episode: a banner across the top that
 * names what is holding the memory, so the next move is plain without opening
 * anything. It never takes the keyboard -- a prompt half typed into a tab keeps
 * going -- and it works with the sidebar hidden or on a phone. It pulses until
 * Got it, then stays steady until the episode ends; the page title and icon
 * say it too, for a browser tab that is not the one in front.
 */

const TITLE = "muxnexus";
const BANNER_ID = "nudge";
/** The icon a tab shows while urgent: the page's square with a red dot. */
const ALERT_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="4" width="22" height="22" rx="4" fill="#61afef"/><circle cx="24" cy="8" r="7" fill="#e06c75" stroke="#171a1f" stroke-width="2"/></svg>',
)}`;

export interface NudgeView {
  headline: string;
  holders: string;
  blinking: boolean;
  title: string;
}

export function nudgeModel(n: SwapNotice | null, sessions: readonly SessionInfo[]): NudgeView | null {
  if (!n || n.severity !== "urgent") return null;
  const writes = n.reason !== "pressure";
  const rate = n.rate === null ? null : formatRate(n.rate);
  const names = n.holders.flatMap((h) => {
    if (h.kind === "app") return [`${h.name} ${formatBytes(h.bytes)}`];
    for (const s of sessions) {
      const w = s.windows.find((x) => x.id === h.name);
      if (w) return [`${windowPlace(s, w)} ${formatBytes(h.bytes)}`];
    }
    return [];
  });
  return {
    headline: writes ? (rate ? `● Swap writing ${rate} to the SSD` : "● Swapping to the SSD") : "● Memory pressure",
    holders: names.length > 0 ? `Biggest: ${names.join(" · ")}` : "",
    blinking: !n.acked,
    title: `${writes ? (rate ? `● Swap ${rate}` : "● Swapping") : "● Memory pressure"} · ${TITLE}`,
  };
}

export function createNudge(host: HTMLElement, actions: { ack(episode: number): void; showList(): void }): { update(n: SwapNotice | null, sessions: readonly SessionInfo[]): void } {
  let banner: HTMLElement | null = null;
  let parts: { head: HTMLElement; who: HTMLElement } | null = null;
  let icon: HTMLLinkElement | null = null;
  let episode = 0;

  // Made once per episode on screen and only refreshed after: a button that
  // has the keys keeps them through the notice every five seconds.
  function make(): HTMLElement {
    const b = document.createElement("div");
    b.id = BANNER_ID;
    b.className = "nudge-banner";
    // Announced once as it appears; its updates after that are not.
    b.setAttribute("role", "alert");
    const head = document.createElement("span");
    head.className = "nudge-head";
    const who = document.createElement("span");
    who.className = "nudge-who";
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const list = document.createElement("button");
    list.type = "button";
    list.className = "nudge-btn";
    list.textContent = "Show list";
    list.onclick = () => actions.showList();
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "nudge-btn solid";
    ok.textContent = "Got it";
    ok.onclick = () => actions.ack(episode);
    b.append(head, who, spacer, list, ok);
    parts = { head, who };
    return b;
  }

  function show(view: NudgeView, ep: number) {
    episode = ep;
    if (!banner) {
      banner = make();
      host.prepend(banner);
      host.classList.add("has-nudge");
    }
    parts!.head.textContent = view.headline;
    parts!.who.textContent = view.holders;
    banner.classList.toggle("blink", view.blinking);
    document.title = view.title;
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      icon.href = ALERT_ICON;
      document.head.append(icon);
    }
  }

  function hide() {
    banner?.remove();
    banner = null;
    parts = null;
    host.classList.remove("has-nudge");
    icon?.remove();
    icon = null;
    document.title = TITLE;
  }

  return {
    update(n, sessions) {
      const view = nudgeModel(n, sessions);
      if (view && n) show(view, n.episode);
      else hide();
    },
  };
}
