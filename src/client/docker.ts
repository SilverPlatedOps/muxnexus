import type { DockerContainer, DockerStats } from "../shared/protocol";
import { formatBytes, formatCpu, gauge, pressure } from "./system";

/**
 * The overview's Docker tab: each container under the compose project that
 * started it, what it costs while it runs, and how much of the engine's memory
 * the running ones fill, under the docker context's name so another machine's
 * engine is not taken for the Mac's. The server reads Docker only while this
 * tab is the one showing (`{t:"docker", on}`): `docker stats` takes two seconds
 * and wakes the VM, which is too dear for a list nobody is looking at.
 */

export type OverviewTab = "system" | "docker";

const TAB_KEY = "muxnexus.system.tab";
/** The group for containers compose did not start, set in italics so no project of the same name passes for it. */
const UNGROUPED = "no project";

export function loadTab(): OverviewTab {
  try {
    return localStorage.getItem(TAB_KEY) === "docker" ? "docker" : "system";
  } catch {
    return "system";
  }
}

export function saveTab(tab: OverviewTab): void {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* this view only */ }
}

const running = (c: DockerContainer) => c.state === "running";

/**
 * What a row calls its container: the compose service, since the group above
 * it already names the project -- `shop-orders-kafka-1` is `kafka` under
 * `shop-orders` -- with the replica number only when it is not the first. A
 * name compose did not make up (`container_name:`) is shown as it is.
 */
export function containerLabel(c: DockerContainer): string {
  if (!c.project || !c.service) return c.name;
  // Compose v2 joins with dashes, v1 with underscores.
  for (const sep of ["-", "_"]) {
    const prefix = `${c.project}${sep}${c.service}${sep}`;
    const n = c.name.startsWith(prefix) ? c.name.slice(prefix.length) : "";
    if (/^\d+$/.test(n)) return n === "1" ? c.service : `${c.service}-${n}`;
  }
  return c.name;
}

export interface ContainerGroup {
  /** Absent for the containers started by hand. */
  project?: string;
  running: number;
  containers: DockerContainer[];
}

/**
 * The containers by compose project: projects with something running first,
 * then by name, hand-started containers last; in each, the running ones first.
 */
export function groupContainers(containers: readonly DockerContainer[]): ContainerGroup[] {
  const byProject = new Map<string | undefined, DockerContainer[]>();
  for (const c of containers) {
    const list = byProject.get(c.project);
    if (list) list.push(c);
    else byProject.set(c.project, [c]);
  }
  const groups = [...byProject].map(([project, list]) => ({
    ...(project === undefined ? {} : { project }),
    running: list.filter(running).length,
    containers: list.sort((a, b) => Number(running(b)) - Number(running(a)) || containerLabel(a).localeCompare(containerLabel(b))),
  }));
  return groups.sort((a, b) =>
    Number(a.project === undefined) - Number(b.project === undefined) ||
    Number(b.running > 0) - Number(a.running > 0) ||
    (a.project ?? "").localeCompare(b.project ?? ""));
}

/**
 * What the running containers use, in bytes, or undefined when none of them was
 * measured: a `docker stats` that failed or timed out is not a reading of zero.
 */
export function containersMem(s: DockerStats): number | undefined {
  const up = s.containers.filter(running);
  if (up.length > 0 && up.every((c) => c.mem === undefined)) return undefined;
  return up.reduce((sum, c) => sum + (c.mem ?? 0), 0);
}

/**
 * What the tab says in place of a list, or null when there is a list to show.
 * It names the context, so a remote engine gone quiet is not read as the Mac's;
 * named, "down" is a failed connection as often as a stopped engine.
 */
export function engineNote(s: DockerStats): string | null {
  const on = s.context ? ` on ${s.context}` : "";
  if (s.engine === "down") return s.context ? `Docker${on} can't be reached` : "Docker is not running";
  if (s.engine === "slow") return `Docker${on} is not answering`;
  if (s.engine === "missing") return "No docker command on the PATH";
  return s.containers.length === 0 ? `No containers${on}` : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function containerRow(c: DockerContainer): HTMLElement {
  const up = running(c);
  const r = el("div", up ? "sys-app" : "sys-app dock-off");
  r.append(el("span", "sys-app-name dock-name", containerLabel(c)));
  if (up) {
    r.append(
      el("span", "sys-num", c.cpu === undefined ? "–" : formatCpu(c.cpu)),
      el("span", "sys-num", c.mem === undefined ? "–" : formatBytes(c.mem)),
    );
  } else {
    r.append(el("span", "sys-num dock-state", c.state));
  }
  r.title = `${c.name}\n${c.image}\n${c.status}`;
  return r;
}

export interface DockerPanel {
  /** A new reading from the server. */
  receive(stats: DockerStats): void;
  /** The tab closed, or the socket went: whatever comes next is a fresh start. */
  reset(): void;
}

export function createDockerPanel(body: HTMLElement): DockerPanel {
  function draw(s: DockerStats) {
    const note = engineNote(s);
    if (note) {
      body.replaceChildren(el("div", "sys-wait", note));
      return;
    }
    const parts: HTMLElement[] = [];
    if (s.context) {
      const ctx = el("div", "sys-row dock-context");
      ctx.append(el("span", "sys-label", "Context"), el("span", "sys-value dock-context-name", s.context));
      ctx.title = `Read through docker context ${s.context}`;
      parts.push(ctx);
    }
    const used = containersMem(s);
    if (s.vmMem && used !== undefined) {
      // The containers' share of the engine's machine: a VM the Mac holds whole
      // whatever its containers use, or another computer, whose own processes
      // outside Docker are not counted.
      const mem = gauge("Mem", used, s.vmMem, pressure((used / s.vmMem) * 100));
      mem.title = `The running containers use ${Math.round((used / s.vmMem) * 100)}% of the memory the engine has`;
      parts.push(mem);
    }
    const head = el("div", "sys-app sys-app-head");
    head.append(el("span", "sys-app-name", "Container"), el("span", "sys-num", "CPU"), el("span", "sys-num", "Mem"));
    const list = el("div", "dock-list");
    for (const g of groupContainers(s.containers)) {
      const h = el("div", g.project === undefined ? "sys-app dock-group dock-loose" : "sys-app dock-group");
      h.append(el("span", "sys-app-name", g.project ?? UNGROUPED), el("span", "sys-num", `${g.running}/${g.containers.length}`));
      h.title = `${g.running} of ${g.containers.length} running`;
      list.append(h, ...g.containers.map(containerRow));
    }
    const table = el("div", "sys-apps");
    table.append(head, list);
    parts.push(table);
    body.replaceChildren(...parts);
  }

  return {
    receive: draw,
    reset() {
      body.replaceChildren(el("div", "sys-wait", "Reading…"));
    },
  };
}
