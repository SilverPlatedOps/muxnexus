import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import index from "../client/index.html";
import { createCmuxMirror } from "./cmux";
import { createServer } from "./server";
import { createUsageReader } from "./usage";

export interface Args {
  /** Addresses to bind (`--host`, repeatable). Empty means "work it out from Tailscale". */
  hosts: string[];
  port: number;
  /** Explicit tmux socket path (`--socket`). */
  socket?: string;
  /** Extra names the server answers to (`--allow-host`), for a reverse proxy or a custom DNS name. */
  allowHosts: string[];
}

/** cmux's built-in local-tmux server. Used by default when present so the browser and cmux share one tmux. */
export const CMUX_TMUX_SOCKET = join(homedir(), ".cmux", "local-tmux", "server.sock");

/**
 * Which tmux socket to drive: an explicit `--socket` wins; otherwise cmux's socket when it
 * exists; otherwise `undefined`, meaning tmux's own default socket. cmux is never required.
 */
export function resolveSocketPath(explicit: string | undefined, cmuxSocketExists: boolean): string | undefined {
  if (explicit) return explicit;
  return cmuxSocketExists ? CMUX_TMUX_SOCKET : undefined;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { hosts: [], port: 7681, socket: undefined, allowHosts: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (flag === "--host") args.hosts.push(value);
    else if (flag === "--socket") args.socket = value;
    else if (flag === "--allow-host") args.allowHosts.push(value);
    else if (flag === "--port") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid --port: ${value}`);
      args.port = n;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

/**
 * The addresses to listen on. Loopback is added to whatever you asked for, so
 * `localhost` keeps working while the tailnet address serves everything else --
 * a wildcard bind would do that too, but it would also answer on whatever
 * network the laptop joins next. A wildcard you asked for is left alone: it
 * already covers loopback, and binding it twice would collide.
 */
export function resolveHosts(explicit: readonly string[], tailscaleIp: string): string[] {
  const wanted = explicit.length ? [...explicit] : [tailscaleIp];
  if (!wanted.some((h) => h === "0.0.0.0" || h === "::")) wanted.push("127.0.0.1");
  return [...new Set(wanted)];
}

/**
 * This node's own MagicDNS name, long and short, from `tailscale status --json`.
 * These are the names a phone or iPad types, so the server has to answer to them;
 * the address it is bound to is not one of them. Never throws -- a tailnet
 * without MagicDNS simply has no extra names.
 */
export function magicDnsNames(json: string): string[] {
  let name: unknown;
  try {
    name = (JSON.parse(json) as { Self?: { DNSName?: unknown } })?.Self?.DNSName;
  } catch {
    return [];
  }
  if (typeof name !== "string") return [];
  const full = name.replace(/\.$/, "").toLowerCase();
  if (full === "") return [];
  const short = full.split(".")[0];
  return short && short !== full ? [full, short] : [full];
}

/** `tailscale status --json`, or "" when Tailscale cannot be reached. */
export async function tailscaleStatus(): Promise<string> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : "";
  } catch {
    return "";
  }
}

/** First IPv4 address reported by `tailscale ip -4`. Rejects if Tailscale is down. */
export async function tailscaleIp(): Promise<string> {
  const proc = Bun.spawn(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const ip = out.trim().split("\n")[0];
  if (code !== 0 || !ip) throw new Error(`tailscale ip -4 failed: ${err.trim() || "no address returned"}`);
  return ip;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  let tailnet = "";
  if (args.hosts.length === 0) {
    try {
      tailnet = await tailscaleIp();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error("Start Tailscale (`tailscale up`) or pass --host <address>.");
      process.exit(1);
    }
  }
  const hosts = resolveHosts(args.hosts, tailnet);
  const socketPath = resolveSocketPath(args.socket, existsSync(CMUX_TMUX_SOCKET));
  // Parity with cmux is opt-in by circumstance: only when driving cmux's own tmux and the CLI exists.
  const cmuxBin = socketPath === CMUX_TMUX_SOCKET ? Bun.which("cmux") : null;
  const mirror = socketPath && cmuxBin ? createCmuxMirror({ cmuxBin, socketPath }) : undefined;
  const allowHosts = [...args.allowHosts, ...magicDnsNames(await tailscaleStatus())];
  const usage = createUsageReader();
  const running = createServer({ hosts, port: args.port, socketPath, index, mirror, allowHosts, usage });
  for (const h of hosts) console.log(`muxnexus listening on http://${h}:${running.port}`);
  if (hosts.some((h) => h === "0.0.0.0" || h === "::")) {
    console.warn("warning: a wildcard bind answers on every network this machine joins, including untrusted ones.");
  }
  console.log(`tmux socket: ${socketPath ?? "tmux default"}${!args.socket && socketPath ? " (cmux local-tmux)" : ""}`);
  console.log(`cmux workspace mirror: ${mirror ? "on" : "off"}`);
  if (allowHosts.length) console.log(`also reachable as: ${allowHosts.join(", ")}`);
}
