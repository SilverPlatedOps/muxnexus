import { cpus as osCpus } from "node:os";
import type { DockerContainer, DockerStats } from "../shared/protocol";

/**
 * The containers for the system overview's Docker tab: what each one is,
 * whether it is up, and what it is costing. Read with the `docker` CLI, so the
 * engine shown is whichever one it points at -- Rancher Desktop, Docker
 * Desktop, colima.
 *
 * Nothing here runs unless a browser has the tab open (server.ts). The engine
 * lives in a VM behind a socket, and while that VM starts or wedges the CLI can
 * hang rather than fail, so every call is cut off after TIMEOUT_MS: a reading
 * that says the engine is not answering beats a tab that waits on it for good.
 */

/** Why a reading has no containers. A Runner throws it; anything else thrown reads as the engine being down. */
export class EngineUnavailable extends Error {
  constructor(readonly engine: Exclude<DockerStats["engine"], "up">) {
    super(engine);
  }
}

export type Runner = (cmd: string[], timeoutMs: number) => Promise<string>;

export interface DockerReader {
  read(): Promise<DockerStats>;
}

/** Longer than `docker stats --no-stream` takes when well (about two seconds: it waits for a second sample). */
const TIMEOUT_MS = 5_000;

/** Tab-separated: a label value can hold a comma ("Broadcom, Inc."), so `{{.Labels}}` cannot be split. */
const PS_FORMAT = [
  "{{.ID}}", "{{.Names}}", "{{.Image}}", "{{.State}}", "{{.Status}}",
  '{{.Label "com.docker.compose.project"}}', '{{.Label "com.docker.compose.service"}}',
].join("\t");
const STATS_FORMAT = "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}";

/** `docker stats` writes memory in binary units (MiB); decimal ones (MB) are read too, for an engine that prints those. */
const UNITS: Record<string, number> = {
  B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4,
  kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12,
};

/**
 * How long past the kill to wait for the output to close. SIGKILL cannot be
 * ignored, but a child the CLI started can hold its stdout open past it, and
 * the reading must end regardless.
 */
const GRACE_MS = 1_000;

export async function run(cmd: string[], timeoutMs: number): Promise<string> {
  let p;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
  } catch {
    throw new EngineUnavailable("missing"); // no `docker` on PATH
  }
  const done = await Promise.race([
    Promise.all([new Response(p.stdout).text(), p.exited]),
    Bun.sleep(timeoutMs + GRACE_MS).then(() => null),
  ]);
  // The signal, not `p.killed`: Bun sets that on a process that exited by itself too.
  if (!done || p.signalCode) {
    p.kill("SIGKILL");
    throw new EngineUnavailable("slow");
  }
  const [out, code] = done;
  if (code !== 0) throw new EngineUnavailable("down");
  return out;
}

/** `545.2MiB`, `3.827GiB`, `0B`, in bytes. */
export function parseSize(text: string): number | undefined {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  const unit = m ? UNITS[m[2]] : undefined;
  return m && unit ? Number(m[1]) * unit : undefined;
}

/** `docker ps -a` in PS_FORMAT, one container a line. A container compose did not start has no project. */
export function parsePs(text: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    if (f.length < 7 || !f[0]) continue;
    containers.push({
      id: f[0],
      name: f[1],
      image: f[2],
      state: f[3],
      status: f[4],
      ...(f[5] ? { project: f[5] } : {}),
      ...(f[6] ? { service: f[6] } : {}),
    });
  }
  return containers;
}

/**
 * `docker stats --no-stream` in STATS_FORMAT: each running container's CPU and
 * memory by id. The limit after the slash is left: it is the VM's memory only
 * for a container that sets none of its own (`docker info` says the VM's).
 */
export function parseStats(text: string): Map<string, { cpu: number; mem: number }> {
  const usage = new Map<string, { cpu: number; mem: number }>();
  for (const line of text.split("\n")) {
    const [id, cpuText, memText] = line.split("\t");
    if (!id || !cpuText || !memText) continue;
    const cpu = Number.parseFloat(cpuText);
    const mem = parseSize(memText.split("/")[0] ?? "");
    if (!Number.isFinite(cpu) || mem === undefined) continue;
    usage.set(id, { cpu, mem });
  }
  return usage;
}

/**
 * `cores` puts each container on the overview's CPU scale: `docker stats`
 * counts one core as 100%, and the System tab's apps are a share of the whole
 * Mac, so the two tabs can be read against each other.
 */
export function createDockerReader(opts: { run?: Runner; cores?: number } = {}): DockerReader {
  const exec = opts.run ?? run;
  const cores = Math.max(1, opts.cores ?? osCpus().length);
  return {
    async read() {
      let ps: string;
      try {
        ps = await exec(["docker", "ps", "-a", "--format", PS_FORMAT], TIMEOUT_MS);
      } catch (e) {
        return { engine: e instanceof EngineUnavailable ? e.engine : "down", containers: [] };
      }
      const containers = parsePs(ps);
      // With nothing running there is nothing to measure, and two seconds saved.
      // A `stats` or `info` that fails or times out still leaves the list worth showing.
      const [usage, info] = await Promise.all([
        containers.some((c) => c.state === "running")
          ? exec(["docker", "stats", "--no-stream", "--format", STATS_FORMAT], TIMEOUT_MS).then(parseStats, () => undefined)
          : undefined,
        exec(["docker", "info", "--format", "{{.MemTotal}}"], TIMEOUT_MS).catch(() => undefined),
      ]);
      const vmMem = Number(info?.trim());
      return {
        engine: "up",
        containers: containers.map((c) => {
          const u = usage?.get(c.id);
          return u ? { ...c, cpu: u.cpu / cores, mem: u.mem } : c;
        }),
        ...(vmMem > 0 ? { vmMem } : {}),
      };
    },
  };
}
