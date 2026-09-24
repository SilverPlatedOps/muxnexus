import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSource, UsageWindow } from "../shared/protocol";

/**
 * Quota for every Claude account on this machine, plus opencode, read straight
 * from the providers rather than inferred from a running session.
 *
 * Nothing here is ever written back. In particular an expired token is reported
 * as signed out and never refreshed: Claude Code owns that credential and
 * refreshes it on its own schedule, and a second writer racing it could leave
 * the user logged out of an account muxnexus does not otherwise touch.
 */

const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
const OPENCODE_USAGE = "https://opencode.ai/zen/go/v1/usage";

export interface HttpResult {
  status: number;
  body: string;
}

/** Injected so tests never reach the network. */
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<HttpResult>;
/** Injected so tests never reach the Keychain. Resolves null when there is no such item. */
export type SecretReader = (service: string) => Promise<string | null>;

export interface UsageReader {
  read(): Promise<UsageSource[]>;
}

/**
 * The Keychain service holding a profile's credentials. Claude Code names the
 * default profile's item plainly and suffixes every other with the first four
 * bytes of the sha256 of the config directory's absolute path.
 */
export function keychainService(configDir: string, home: string): string {
  const base = "Claude Code-credentials";
  if (configDir === join(home, ".claude")) return base;
  const hash = new Bun.CryptoHasher("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * What to call a profile in the sidebar: `.claude` is the one you started with,
 * and `.claude-work` is the work one. Deriving it beats a lookup table -- a
 * third account needs no code change.
 */
export function profileLabel(configDir: string): string {
  const dir = configDir.split("/").filter(Boolean).pop() ?? "";
  const suffix = dir.replace(/^\.claude-?/, "");
  return suffix === "" ? "personal" : suffix;
}

/**
 * Config directories that are really Claude profiles. `projects/` is the whole
 * test: on this machine it separates `.claude` and `.claude-work` from four
 * lookalikes (`.claude-shared`, `.claude-monitor`, ...) that are other tools'
 * directories rather than accounts.
 */
export function findProfiles(home: string, list: (dir: string) => string[], has: (p: string) => boolean): string[] {
  return list(home)
    .filter((d) => d === ".claude" || d.startsWith(".claude-"))
    .map((d) => join(home, d))
    .filter((p) => has(join(p, "projects")))
    .sort((a, b) => a.length - b.length); // `.claude` first: the default profile leads
}

/**
 * `KEY=value` pairs from a shell env file. The lines are `export KEY=value`, so
 * the prefix has to be stripped; quotes and comments are handled because the
 * file is written by hand.
 */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

/** The access token out of a Keychain item's JSON, or null if it is not shaped as expected. */
export function accessToken(item: string): string | null {
  try {
    const token = JSON.parse(item)?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/**
 * `limits[]` from `/api/oauth/usage`. Read the list rather than the sibling
 * `five_hour`/`seven_day` objects: it already carries `severity`, and the set of
 * kinds differs per account -- a work account reports two where a personal one
 * reports three -- so the panel renders what arrives instead of fixed keys. The
 * response also holds null-valued keys with internal codenames; they are ignored.
 */
export function parseClaudeUsage(body: string): UsageWindow[] {
  let limits: unknown;
  try {
    limits = JSON.parse(body)?.limits;
  } catch {
    return [];
  }
  if (!Array.isArray(limits)) return [];
  const out: UsageWindow[] = [];
  for (const l of limits) {
    if (typeof l?.kind !== "string" || typeof l?.percent !== "number") continue;
    out.push({
      kind: l.kind,
      percent: l.percent,
      ...(typeof l.resets_at === "string" ? { resetsAt: l.resets_at } : {}),
      ...(typeof l.severity === "string" ? { severity: l.severity } : {}),
    });
  }
  return out;
}

/** opencode reports `usage.{rolling,weekly,monthly}` as named objects rather than a list. */
export function parseOpencodeUsage(body: string): UsageWindow[] {
  let usage: unknown;
  try {
    const d = JSON.parse(body);
    usage = d?.usage ?? d;
  } catch {
    return [];
  }
  if (typeof usage !== "object" || usage === null) return [];
  const out: UsageWindow[] = [];
  for (const [kind, v] of Object.entries(usage as Record<string, unknown>)) {
    const w = v as { percent?: unknown; resetsAt?: unknown };
    if (typeof w?.percent !== "number") continue;
    out.push({
      kind,
      percent: w.percent,
      ...(typeof w.resetsAt === "string" ? { resetsAt: w.resetsAt } : {}),
    });
  }
  return out;
}

/**
 * A source's new state, given what the last check knew. A failure keeps the last
 * good numbers and only marks them: blanking a row on one network blip is worse
 * than showing a number that is a minute old, which is the rule the statusline
 * already follows.
 */
export function merge(previous: UsageSource | undefined, next: {
  id: string;
  label: string;
  windows: UsageWindow[];
  state: UsageSource["state"];
  now: string;
}): UsageSource {
  if (next.state === "ok") {
    return { id: next.id, label: next.label, windows: next.windows, state: "ok", checkedAt: next.now };
  }
  return {
    id: next.id,
    label: next.label,
    windows: previous?.windows ?? [],
    state: next.state,
    // Deliberately the old timestamp: it is when these numbers were true.
    checkedAt: previous?.checkedAt ?? next.now,
  };
}

export interface UsageOptions {
  home?: string;
  fetch?: Fetcher;
  secret?: SecretReader;
  list?: (dir: string) => string[];
  has?: (p: string) => boolean;
  readFile?: (p: string) => Promise<string | null>;
}

/** A plain HTTPS GET. Any failure is a status of 0 rather than a throw. */
const httpGet: Fetcher = async (url, headers) => {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: "" };
  }
};

/** One Keychain item, by service name. Absent or unreadable is null, never a throw. */
const keychainSecret: SecretReader = async (service) => {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 && out.trim() !== "" ? out.trim() : null;
};

export function createUsageReader(opts: UsageOptions = {}): UsageReader {
  const home = opts.home ?? homedir();
  const get = opts.fetch ?? httpGet;
  const secret = opts.secret ?? keychainSecret;
  const list = opts.list ?? ((dir: string) => { try { return readdirSync(dir); } catch { return []; } });
  const has = opts.has ?? ((p: string) => existsSync(p));
  const readFile = opts.readFile ?? (async (p: string) => { try { return await Bun.file(p).text(); } catch { return null; } });

  let last = new Map<string, UsageSource>();

  async function claude(dir: string): Promise<UsageSource> {
    const id = dir;
    const label = profileLabel(dir);
    const now = new Date().toISOString();
    const item = await secret(keychainService(dir, home));
    const token = item ? accessToken(item) : null;
    if (!token) return merge(last.get(id), { id, label, windows: [], state: "signed-out", now });
    const res = await get(CLAUDE_USAGE, {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    });
    // 401 is the ordinary state of an account nobody has used lately, not a fault.
    if (res.status === 401 || res.status === 403) {
      return merge(last.get(id), { id, label, windows: [], state: "signed-out", now });
    }
    if (res.status !== 200) return merge(last.get(id), { id, label, windows: [], state: "error", now });
    const windows = parseClaudeUsage(res.body);
    if (windows.length === 0) return merge(last.get(id), { id, label, windows: [], state: "error", now });
    return merge(last.get(id), { id, label, windows, state: "ok", now });
  }

  async function opencode(): Promise<UsageSource | null> {
    const id = "opencode";
    const now = new Date().toISOString();
    const env = await readFile(join(home, ".claude", "opencode-go", ".env"));
    if (env === null) return null; // not installed: no row at all, rather than an empty one
    const token = parseEnv(env).get("OPENCODE_GO_API_KEY");
    if (!token) return merge(last.get(id), { id, label: id, windows: [], state: "signed-out", now });
    const res = await get(OPENCODE_USAGE, { Authorization: `Bearer ${token}` });
    if (res.status === 401 || res.status === 403) {
      return merge(last.get(id), { id, label: id, windows: [], state: "signed-out", now });
    }
    if (res.status !== 200) return merge(last.get(id), { id, label: id, windows: [], state: "error", now });
    const windows = parseOpencodeUsage(res.body);
    if (windows.length === 0) return merge(last.get(id), { id, label: id, windows: [], state: "error", now });
    return merge(last.get(id), { id, label: id, windows, state: "ok", now });
  }

  return {
    async read() {
      const dirs = findProfiles(home, list, has);
      const settled = await Promise.all([...dirs.map(claude), opencode()]);
      const sources = settled.filter((s): s is UsageSource => s !== null);
      last = new Map(sources.map((s) => [s.id, s]));
      return sources;
    },
  };
}
