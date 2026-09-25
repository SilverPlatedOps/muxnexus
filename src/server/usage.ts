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
 * The config dir a new session's agents should use, when its `[Category]` tag
 * names a profile: `[Work] Voucher` gets `.claude-work`. Null for the default
 * profile -- Claude Code keys the default's Keychain item on the variable being
 * unset, so setting it to `~/.claude` explicitly could look signed out -- and
 * for a tag that names no profile.
 */
export function categoryProfile(category: string, dirs: readonly string[], home: string): string | null {
  const want = category.toLowerCase();
  const dir = dirs.find((d) => profileLabel(d) === want);
  if (!dir || dir === join(home, ".claude")) return null;
  return dir;
}

/** The Claude config dirs on this machine, read from disk. */
export function localProfiles(home: string = homedir()): string[] {
  return findProfiles(home, (dir) => { try { return readdirSync(dir); } catch { return []; } }, existsSync);
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

/**
 * How long to leave a failing source alone, doubling per consecutive failure.
 *
 * Without this the server asks a source that is refusing every 60 s forever,
 * which is how `/api/oauth/usage` came to answer 429 during the build: quota
 * moves slowly enough that nothing is lost by waiting, and a provider that is
 * rate-limiting us is the last thing to keep poking.
 */
export function backoffMs(failures: number, baseMs: number): number {
  if (failures <= 0) return 0;
  return Math.min(baseMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

const MAX_BACKOFF_MS = 15 * 60_000;

export interface UsageOptions {
  home?: string;
  fetch?: Fetcher;
  secret?: SecretReader;
  list?: (dir: string) => string[];
  has?: (p: string) => boolean;
  readFile?: (p: string) => Promise<string | null>;
  /** First backoff step after a failed read; doubles from there. */
  backoffBaseMs?: number;
  now?: () => number;
  /** Where a failed read says why. The panel only shows "unavailable". */
  warn?: (line: string) => void;
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

  const baseMs = opts.backoffBaseMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  let last = new Map<string, UsageSource>();
  /** Consecutive failures per source, and when each may be tried again. */
  const failures = new Map<string, number>();
  const nextAttempt = new Map<string, number>();

  /**
   * Why a read failed, for the server log. Status 0 is httpGet's shape for a
   * fetch that threw -- a timeout or no network, not a reply. The body is
   * clipped: a 429's is a short JSON error, and nothing in it is a secret.
   */
  function failed(label: string, res: HttpResult, why?: string): void {
    const reply = res.status === 0 ? "no reply (network or timeout)" : `HTTP ${res.status}`;
    warn(`usage: ${label}: ${why ?? reply}${res.body ? `: ${res.body.slice(0, 200)}` : ""}`);
  }

  /** Whether this source is still serving out a backoff. */
  function waiting(id: string): boolean {
    return now() < (nextAttempt.get(id) ?? 0);
  }

  function record(source: UsageSource): UsageSource {
    // Signed out is a settled answer, not a failure: it costs one Keychain read
    // and no request, so there is nothing to back off from.
    if (source.state === "error") {
      const n = (failures.get(source.id) ?? 0) + 1;
      failures.set(source.id, n);
      nextAttempt.set(source.id, now() + backoffMs(n, baseMs));
    } else {
      failures.delete(source.id);
      nextAttempt.delete(source.id);
    }
    return source;
  }

  async function claude(dir: string): Promise<UsageSource> {
    const id = dir;
    const label = profileLabel(dir);
    const stamp = new Date().toISOString();
    const previous = last.get(id);
    // Still backing off: report what we last knew rather than asking again.
    if (waiting(id) && previous) return previous;
    const now = stamp;
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
    if (res.status !== 200) {
      failed(label, res);
      return merge(last.get(id), { id, label, windows: [], state: "error", now });
    }
    const windows = parseClaudeUsage(res.body);
    if (windows.length === 0) {
      failed(label, res, "HTTP 200 but no usage windows in the reply");
      return merge(last.get(id), { id, label, windows: [], state: "error", now });
    }
    return merge(last.get(id), { id, label, windows, state: "ok", now });
  }

  async function opencode(): Promise<UsageSource | null> {
    const id = "opencode";
    const stamp = new Date().toISOString();
    const previous = last.get(id);
    if (waiting(id) && previous) return previous;
    const now = stamp;
    const env = await readFile(join(home, ".claude", "opencode-go", ".env"));
    if (env === null) return null; // not installed: no row at all, rather than an empty one
    const token = parseEnv(env).get("OPENCODE_GO_API_KEY");
    if (!token) return merge(last.get(id), { id, label: id, windows: [], state: "signed-out", now });
    const res = await get(OPENCODE_USAGE, { Authorization: `Bearer ${token}` });
    if (res.status === 401 || res.status === 403) {
      return merge(last.get(id), { id, label: id, windows: [], state: "signed-out", now });
    }
    if (res.status !== 200) {
      failed(id, res);
      return merge(last.get(id), { id, label: id, windows: [], state: "error", now });
    }
    const windows = parseOpencodeUsage(res.body);
    if (windows.length === 0) {
      failed(id, res, "HTTP 200 but no usage windows in the reply");
      return merge(last.get(id), { id, label: id, windows: [], state: "error", now });
    }
    return merge(last.get(id), { id, label: id, windows, state: "ok", now });
  }

  return {
    async read() {
      const dirs = findProfiles(home, list, has);
      const settled = await Promise.all([...dirs.map(claude), opencode()]);
      // A source returned unchanged was skipped for backoff, not attempted, so
      // it must not count as another failure -- that would let a source extend
      // its own backoff indefinitely without ever being asked again.
      const sources = settled
        .filter((s): s is UsageSource => s !== null)
        .map((s) => (s === last.get(s.id) ? s : record(s)));
      last = new Map(sources.map((s) => [s.id, s]));
      return sources;
    },
  };
}
