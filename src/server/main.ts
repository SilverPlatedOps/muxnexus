import index from "../client/index.html";
import { createServer } from "./server";

export interface Args {
  host?: string;
  port: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { host: undefined, port: 7681 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (flag === "--host") args.host = value;
    else if (flag === "--port") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`invalid --port: ${value}`);
      args.port = n;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
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
  let host = args.host;
  if (!host) {
    try {
      host = await tailscaleIp();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error("Start Tailscale (`tailscale up`) or pass --host <address>.");
      process.exit(1);
    }
  }
  const running = createServer({ host, port: args.port, index });
  console.log(`cmux-viewer listening on http://${host}:${running.port}`);
}
