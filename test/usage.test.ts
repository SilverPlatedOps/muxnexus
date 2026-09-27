import { describe, expect, test } from "bun:test";
import {
  accessToken,
  backoffMs,
  categoryProfile,
  codexAuth,
  createUsageReader,
  findProfiles,
  keychainService,
  merge,
  parseClaudeUsage,
  parseCodexUsage,
  parseRetryAfter,
  profileLabel,
} from "../src/server/usage";
import { bar, formatReset, kindLabel } from "../src/client/usage";
import { badgesShown, marksShown, setBadgesShown, setMarksShown, type Store } from "../src/client/display";
import type { UsageSource } from "../src/shared/protocol";
import type { UsageStore } from "../src/server/usage";

const HOME = "/Users/someone";

describe("categoryProfile", () => {
  const dirs = [`${HOME}/.claude`, `${HOME}/.claude-work`];

  test("a tag naming a profile gets that profile's dir, whatever its case", () => {
    expect(categoryProfile("Work", dirs, HOME)).toBe(`${HOME}/.claude-work`);
    expect(categoryProfile("work", dirs, HOME)).toBe(`${HOME}/.claude-work`);
  });

  test("the default profile and unknown tags get nothing", () => {
    expect(categoryProfile("Personal", dirs, HOME)).toBeNull();
    expect(categoryProfile("Project", dirs, HOME)).toBeNull();
  });
});

describe("keychainService", () => {
  test("the default profile's item is unsuffixed", () => {
    expect(keychainService(`${HOME}/.claude`, HOME)).toBe("Claude Code-credentials");
  });

  test("any other profile is suffixed with sha256(path)[:8]", () => {
    // Pinned against sha256 of the path, worked out outside the code:
    // getting the hash, the slice or the input path wrong all show up here.
    expect(keychainService("/Users/me/.claude-work", "/Users/me"))
      .toBe("Claude Code-credentials-1e91dd84");
  });

  test("it is the absolute path that is hashed, not the directory name", () => {
    const a = keychainService("/Users/a/.claude-work", "/Users/a");
    const b = keychainService("/Users/b/.claude-work", "/Users/b");
    expect(a).not.toBe(b);
  });
});

describe("profileLabel", () => {
  test("the default profile is the personal one", () => {
    expect(profileLabel(`${HOME}/.claude`)).toBe("personal");
  });

  test("any other is named after its suffix, so a new account needs no code", () => {
    expect(profileLabel(`${HOME}/.claude-work`)).toBe("work");
    expect(profileLabel(`${HOME}/.claude-client`)).toBe("client");
  });

  test("Codex's home is the codex account", () => {
    expect(profileLabel(`${HOME}/.codex`)).toBe("codex");
  });
});

describe("findProfiles", () => {
  const dirs = [".claude", ".claude-work", ".claude-shared", ".claude-monitor", ".config", "Documents"];
  const has = (p: string) => p === `${HOME}/.claude/projects` || p === `${HOME}/.claude-work/projects`;

  test("a projects/ directory is what separates an account from a lookalike", () => {
    expect(findProfiles(HOME, () => dirs, has)).toEqual([`${HOME}/.claude`, `${HOME}/.claude-work`]);
  });

  test("the default profile comes first", () => {
    const reversed = [...dirs].reverse();
    expect(findProfiles(HOME, () => reversed, has)[0]).toBe(`${HOME}/.claude`);
  });

  test("an unreadable home is empty, not a throw", () => {
    expect(findProfiles(HOME, () => [], has)).toEqual([]);
  });
});

describe("accessToken", () => {
  test("reads the OAuth access token", () => {
    expect(accessToken(JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))).toBe("tok");
  });

  test("anything else is null rather than a throw", () => {
    expect(accessToken("not json")).toBeNull();
    expect(accessToken("{}")).toBeNull();
    expect(accessToken(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  });
});

describe("parseClaudeUsage", () => {
  // Shaped like a real response, including the null-valued internal codenames.
  const body = JSON.stringify({
    limits: [
      { kind: "session", group: "session", percent: 78, severity: "warning", resets_at: "2026-09-24T10:40:00Z" },
      { kind: "weekly_all", group: "weekly", percent: 27, severity: "normal", resets_at: "2026-09-26T00:00:00Z" },
    ],
    five_hour: { percent: 78 },
    some_codename: null,
    extra_usage: { is_enabled: false },
  });

  test("reads limits[] with its severity", () => {
    expect(parseClaudeUsage(body)).toEqual([
      { kind: "session", percent: 78, resetsAt: "2026-09-24T10:40:00Z", severity: "warning" },
      { kind: "weekly_all", percent: 27, resetsAt: "2026-09-26T00:00:00Z", severity: "normal" },
    ]);
  });

  test("accounts reporting different numbers of limits are both fine", () => {
    // Verified live: work returns two kinds where personal returns three.
    const three = JSON.stringify({ limits: [
      { kind: "session", percent: 1 }, { kind: "weekly_all", percent: 2 }, { kind: "weekly_scoped", percent: 3 },
    ] });
    expect(parseClaudeUsage(three)).toHaveLength(3);
    expect(parseClaudeUsage(JSON.stringify({ limits: [{ kind: "session", percent: 1 }] }))).toHaveLength(1);
  });

  test("garbage is empty rather than a throw", () => {
    expect(parseClaudeUsage("<html>502</html>")).toEqual([]);
    expect(parseClaudeUsage(JSON.stringify({ limits: null }))).toEqual([]);
    expect(parseClaudeUsage(JSON.stringify({ limits: [{ kind: "x" }] }))).toEqual([]);
  });
});

describe("codexAuth", () => {
  test("reads the ChatGPT token and account out of auth.json", () => {
    const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "tok", account_id: "acct" } });
    expect(codexAuth(auth)).toEqual({ token: "tok", accountId: "acct" });
  });

  test("an API-key login, or anything unexpected, has no token", () => {
    expect(codexAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk", tokens: null }))).toBeNull();
    expect(codexAuth("not json")).toBeNull();
    expect(codexAuth(JSON.stringify({ tokens: { access_token: "" } }))).toBeNull();
  });
});

describe("parseCodexUsage", () => {
  // Shaped like a real /wham/usage reply, trimmed of the upsell and credits.
  const reply = (limitReached: boolean, primary: number) => JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      allowed: !limitReached,
      limit_reached: limitReached,
      primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_after_seconds: 16628, reset_at: 1790493433 },
      secondary_window: { used_percent: 16, limit_window_seconds: 604800, reset_after_seconds: 603428, reset_at: 1791080233 },
    },
    additional_rate_limits: null,
  });

  test("names each window by its length, since Codex only calls them primary and secondary", () => {
    expect(parseCodexUsage(reply(false, 42))).toEqual([
      { kind: "5h", percent: 42, resetsAt: new Date(1790493433 * 1000).toISOString() },
      { kind: "7d", percent: 16, resetsAt: new Date(1791080233 * 1000).toISOString() },
    ]);
  });

  test("a spent window is marked when Codex says the limit is reached", () => {
    const [short, week] = parseCodexUsage(reply(true, 100));
    expect(short.severity).toBe("exceeded");
    expect(week.severity).toBeUndefined();
  });

  test("garbage, or a window without a length, is left out rather than a throw", () => {
    expect(parseCodexUsage("<html>403</html>")).toEqual([]);
    expect(parseCodexUsage(JSON.stringify({ rate_limit: null }))).toEqual([]);
    expect(parseCodexUsage(JSON.stringify({ rate_limit: { primary_window: { used_percent: 3 } } }))).toEqual([]);
  });
});

describe("merge", () => {
  const previous: UsageSource = {
    id: "p", label: "personal", provider: "claude", state: "ok", checkedAt: "2026-09-24T09:00:00Z",
    windows: [{ kind: "session", percent: 50 }],
  };

  test("a good read replaces everything", () => {
    const got = merge(previous, { id: "p", label: "personal", provider: "claude", windows: [{ kind: "session", percent: 60 }], state: "ok", now: "T1" });
    expect(got).toEqual({ id: "p", label: "personal", provider: "claude", state: "ok", checkedAt: "T1", windows: [{ kind: "session", percent: 60 }] });
  });

  test("a failure keeps the last good numbers and the time they were true", () => {
    const got = merge(previous, { id: "p", label: "personal", provider: "claude", windows: [], state: "error", now: "T1" });
    expect(got.windows).toEqual(previous.windows);
    expect(got.state).toBe("error");
    expect(got.checkedAt).toBe("2026-09-24T09:00:00Z");
  });

  test("a failure with nothing to fall back on is simply empty", () => {
    expect(merge(undefined, { id: "p", label: "p", provider: "claude", windows: [], state: "signed-out", now: "T1" }).windows).toEqual([]);
  });
});

describe("the reader, with the network and Keychain injected", () => {
  const base = {
    home: HOME,
    list: () => [".claude", ".claude-work"],
    has: (p: string) => p.endsWith("/projects"),
    readFile: async () => null, // codex not installed
    warn: () => {},
  };
  const item = JSON.stringify({ claudeAiOauth: { accessToken: "tok" } });
  const ok = JSON.stringify({ limits: [{ kind: "session", percent: 12, severity: "normal" }] });

  test("reports one source per profile", async () => {
    const reader = createUsageReader({
      ...base,
      secret: async () => item,
      fetch: async () => ({ status: 200, body: ok }),
    });
    const got = await reader.read();
    expect(got.map((s) => s.label)).toEqual(["personal", "work"]);
    expect(got.every((s) => s.state === "ok")).toBe(true);
  });

  test("a 401 is signed out, not an error -- an unused account's ordinary state", async () => {
    const reader = createUsageReader({
      ...base,
      secret: async () => item,
      fetch: async () => ({ status: 401, body: "" }),
    });
    expect((await reader.read()).map((s) => s.state)).toEqual(["signed-out", "signed-out"]);
  });

  test("a profile with no Keychain item is signed out rather than absent", async () => {
    const reader = createUsageReader({ ...base, secret: async () => null, fetch: async () => ({ status: 200, body: ok }) });
    expect((await reader.read()).map((s) => s.state)).toEqual(["signed-out", "signed-out"]);
  });

  test("a network failure keeps the previous numbers and marks them", async () => {
    let status = 200;
    const reader = createUsageReader({ ...base, secret: async () => item, fetch: async () => ({ status, body: ok }) });
    await reader.read();
    status = 0; // the shape httpGet reports for a thrown fetch
    const got = await reader.read();
    expect(got[0].state).toBe("error");
    expect(got[0].windows).toEqual([{ kind: "session", percent: 12, severity: "normal" }]);
  });

  test("the token never appears in what is returned", async () => {
    const reader = createUsageReader({ ...base, secret: async () => item, fetch: async () => ({ status: 200, body: ok }) });
    expect(JSON.stringify(await reader.read())).not.toContain("tok");
  });

  test("a failed read says why, once per profile, without the token", async () => {
    // "unavailable" in the panel is every failure at once; the log is where a
    // 429 is told apart from a timeout or a reply that no longer parses.
    const lines: string[] = [];
    const reader = createUsageReader({
      ...base,
      secret: async () => item,
      fetch: async () => ({ status: 429, body: '{"error":{"type":"rate_limit_error"}}' }),
      warn: (l) => lines.push(l),
    });
    await reader.read();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("personal");
    expect(lines[0]).toContain("429");
    expect(lines[0]).toContain("rate_limit_error");
    expect(lines.join("\n")).not.toContain("tok");
  });

  test("a successful read logs nothing", async () => {
    const lines: string[] = [];
    const reader = createUsageReader({
      ...base,
      secret: async () => item,
      fetch: async () => ({ status: 200, body: ok }),
      warn: (l) => lines.push(l),
    });
    await reader.read();
    expect(lines).toEqual([]);
  });

  test("codex is a row only when it is installed, read with its own token and account", async () => {
    const seen: Record<string, string>[] = [];
    const auth = JSON.stringify({ tokens: { access_token: "cxtok", account_id: "acct" } });
    const usage = JSON.stringify({ rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 } } });
    const reader = createUsageReader({
      ...base,
      secret: async () => item,
      readFile: async (p) => (p === `${HOME}/.codex/auth.json` ? auth : null),
      fetch: async (url, headers) => {
        if (url.includes("chatgpt.com")) seen.push(headers);
        return { status: 200, body: url.includes("chatgpt.com") ? usage : ok };
      },
    });
    const got = await reader.read();
    const codex = got.find((s) => s.id === "codex")!;
    expect(codex).toMatchObject({ label: "codex", provider: "codex", state: "ok", windows: [{ kind: "5h", percent: 7 }] });
    expect(got.filter((s) => s.provider === "claude").map((s) => s.label)).toEqual(["personal", "work"]);
    expect(seen).toEqual([{ Authorization: "Bearer cxtok", "ChatGPT-Account-Id": "acct" }]);
    expect(JSON.stringify(got)).not.toContain("cxtok");

    const without = createUsageReader({ ...base, secret: async () => item, fetch: async () => ({ status: 200, body: ok }) });
    expect((await without.read()).map((s) => s.id)).not.toContain("codex");
  });

  test("an expired codex token is signed out, and is never refreshed", async () => {
    const calls: string[] = [];
    const reader = createUsageReader({
      ...base,
      secret: async () => null,
      readFile: async (p) => (p.endsWith("/.codex/auth.json") ? JSON.stringify({ tokens: { access_token: "old" } }) : null),
      fetch: async (url) => { calls.push(url); return { status: 401, body: "" }; },
    });
    expect((await reader.read()).find((s) => s.id === "codex")?.state).toBe("signed-out");
    expect(calls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
  });
});

describe("backoff", () => {
  test("doubles per consecutive failure and then stops growing", () => {
    expect(backoffMs(0, 60_000)).toBe(0);
    expect(backoffMs(1, 60_000)).toBe(60_000);
    expect(backoffMs(2, 60_000)).toBe(120_000);
    expect(backoffMs(3, 60_000)).toBe(240_000);
    expect(backoffMs(20, 60_000)).toBe(15 * 60_000);
  });

  test("a failing source is not asked again until its backoff elapses", async () => {
    // The endpoint answered 429 during the build because nothing backed off.
    let calls = 0;
    let clock = 0;
    let status = 200;
    const ok = JSON.stringify({ limits: [{ kind: "session", percent: 12 }] });
    const reader = createUsageReader({
      home: "/h",
      list: () => [".claude"],
      has: (p) => p.endsWith("/projects"),
      readFile: async () => null,
      secret: async () => JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
      fetch: async () => { calls++; return { status, body: ok }; },
      backoffBaseMs: 1000,
      now: () => clock,
      warn: () => {},
    });
    await reader.read();
    expect(calls).toBe(1);

    status = 500;
    await reader.read();            // fails, arms a 1s backoff
    expect(calls).toBe(2);

    clock = 500;
    await reader.read();            // still inside it: no request
    expect(calls).toBe(2);

    clock = 1500;
    status = 200;
    const got = await reader.read(); // past it: asks again and recovers
    expect(calls).toBe(3);
    expect(got[0].state).toBe("ok");

    // Recovery clears the backoff, so the next tick is not skipped.
    clock = 1600;
    await reader.read();
    expect(calls).toBe(4);
  });

  test("the last good numbers survive the whole backoff", async () => {
    let clock = 0;
    let status = 200;
    const reader = createUsageReader({
      home: "/h",
      list: () => [".claude"],
      has: (p) => p.endsWith("/projects"),
      readFile: async () => null,
      secret: async () => JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
      fetch: async () => ({ status, body: JSON.stringify({ limits: [{ kind: "session", percent: 12 }] }) }),
      backoffBaseMs: 1000,
      now: () => clock,
      warn: () => {},
    });
    await reader.read();
    status = 429;
    await reader.read();
    clock = 500;
    const got = await reader.read();
    expect(got[0].windows).toEqual([{ kind: "session", percent: 12 }]);
  });

  // One profile, a counting fetch and a movable clock, for the tests below.
  function counted(opts: { status: () => number; retryAfterMs?: () => number | undefined; clock: () => number; store?: UsageStore }) {
    const seen = { calls: 0 };
    const reader = createUsageReader({
      home: "/h",
      list: () => [".claude"],
      has: (p) => p.endsWith("/projects"),
      readFile: async () => null,
      secret: async () => JSON.stringify({ claudeAiOauth: { accessToken: "t" } }),
      fetch: async () => {
        seen.calls++;
        return { status: opts.status(), body: JSON.stringify({ limits: [{ kind: "session", percent: 12 }] }), retryAfterMs: opts.retryAfterMs?.() };
      },
      backoffBaseMs: 60_000,
      now: opts.clock,
      warn: () => {},
      store: opts.store,
    });
    return { reader, seen };
  }

  test("a 429's Retry-After is waited out in full, past the backoff's cap", async () => {
    // /api/oauth/usage answered 429 with retry-after: 1400 -- longer than the
    // 15-minute cap, so capped backoff alone asked again inside the window.
    let clock = 0;
    const { reader, seen } = counted({ status: () => 429, retryAfterMs: () => 1_400_000, clock: () => clock });
    await reader.read();
    expect(seen.calls).toBe(1);
    clock = 15 * 60_000 + 1;
    await reader.read();
    expect(seen.calls).toBe(1);
    clock = 1_400_001;
    await reader.read();
    expect(seen.calls).toBe(2);
  });

  test("a Retry-After of 0 is no hint: the doubling backoff still applies", async () => {
    let clock = 0;
    const { reader, seen } = counted({ status: () => 429, retryAfterMs: () => 0, clock: () => clock });
    await reader.read();
    clock = 30_000;
    await reader.read();
    expect(seen.calls).toBe(1);
    clock = 60_001;
    await reader.read();
    expect(seen.calls).toBe(2);
  });

  test("a restart inside a backoff does not ask, and keeps the last numbers", async () => {
    // bun --watch restarts the server on every save, and a new reader used to
    // start with no backoff and nothing to show: "unavailable", and a request.
    let clock = 0;
    let status = 200;
    let saved: string | null = null;
    const store: UsageStore = { load: () => saved, save: (t) => { saved = t; } };
    const first = counted({ status: () => status, retryAfterMs: () => 1_400_000, clock: () => clock, store });
    await first.reader.read();
    status = 429;
    clock = 120_000;
    await first.reader.read();

    clock = 600_000;
    const second = counted({ status: () => status, retryAfterMs: () => 1_400_000, clock: () => clock, store });
    const got = await second.reader.read();
    expect(second.seen.calls).toBe(0);
    expect(got[0].state).toBe("error");
    expect(got[0].windows).toEqual([{ kind: "session", percent: 12 }]);

    clock = 120_000 + 1_400_001;
    status = 200;
    expect((await second.reader.read())[0].state).toBe("ok");
    expect(second.seen.calls).toBe(1);
  });

  test("a restart soon after a good read shows it rather than asking again", async () => {
    let clock = 0;
    let saved: string | null = null;
    const store: UsageStore = { load: () => saved, save: (t) => { saved = t; } };
    await counted({ status: () => 200, clock: () => clock, store }).reader.read();

    clock = 30_000;
    const soon = counted({ status: () => 200, clock: () => clock, store });
    expect((await soon.reader.read())[0].state).toBe("ok");
    expect(soon.seen.calls).toBe(0);

    clock = 60_001;
    await soon.reader.read();
    expect(soon.seen.calls).toBe(1);
  });

  test("a store that holds nothing usable is a cold start, not a throw", async () => {
    for (const text of [null, "", "not json", "{}", '{"sources":5}']) {
      const { reader, seen } = counted({ status: () => 200, clock: () => 0, store: { load: () => text, save: () => {} } });
      expect((await reader.read())[0].state).toBe("ok");
      expect(seen.calls).toBe(1);
    }
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-27T02:00:00Z");

  test("seconds become milliseconds", () => {
    expect(parseRetryAfter("1400", now)).toBe(1_400_000);
  });

  test("an HTTP date is the time until then", () => {
    expect(parseRetryAfter("Sun, 27 Sep 2026 02:05:00 GMT", now)).toBe(300_000);
  });

  test("zero, absent, past or unparseable is no hint", () => {
    for (const h of ["0", null, "", "soon", "-5", "Sun, 27 Sep 2026 01:00:00 GMT"]) {
      expect(parseRetryAfter(h, now)).toBeUndefined();
    }
  });
});

describe("formatReset", () => {
  // Built in local time: past a day the answer is a weekday and an hour on the
  // viewer's clock, so the test must not depend on the machine's timezone.
  const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime(); // Sep 2026; the 24th is a Thursday
  const now = local(24, 9);
  const at = (ms: number) => formatReset(new Date(ms).toISOString(), now);

  test("under an hour is minutes", () => {
    expect(at(local(24, 9, 12))).toBe("12m");
  });

  test("under a day is hours and minutes, each with its unit", () => {
    expect(at(local(24, 13, 1))).toBe("4h 1m");
    expect(at(local(24, 11, 51))).toBe("2h 51m");
    expect(at(local(24, 13))).toBe("4h"); // no "0m"
    expect(at(local(25, 8))).toBe("23h"); // tomorrow, but still a countdown
  });

  test("further out is the weekday and hour it resets, to the nearest hour", () => {
    expect(at(local(26, 20))).toBe("Sat 8pm");
    expect(at(local(25, 19, 59))).toBe("Fri 8pm");
    expect(at(local(27, 5, 10))).toBe("Sun 5am");
    expect(at(local(28, 12))).toBe("Mon 12pm");
    expect(at(local(28, 23, 45))).toBe("Tue 12am"); // rounding can cross midnight
  });

  test("once the weekday would come round to today's again, it is the date", () => {
    expect(at(local(30, 21))).toBe("Wed 9pm"); // six days on: still a unique weekday
    expect(at(new Date(2026, 9, 1, 8).getTime())).toBe("Oct 1"); // Thursday again
    expect(at(new Date(2026, 9, 2, 8).getTime())).toBe("Oct 2");
  });

  test("a reset in the past reads now, never a negative", () => {
    expect(at(local(24, 8))).toBe("now");
  });

  test("a missing or unparseable time is simply blank", () => {
    expect(formatReset(undefined, now)).toBe("");
    expect(formatReset("whenever", now)).toBe("");
  });
});

describe("bar", () => {
  test("fills in proportion", () => {
    expect(bar(0).fill).toHaveLength(0);
    expect(bar(100).track).toHaveLength(0);
    expect(bar(50).fill).toHaveLength(4);
  });

  test("a small but non-zero percentage still shows a block", () => {
    // 5% rounds to nothing; an empty bar beside "5%" reads as untouched.
    expect(bar(5).fill).toHaveLength(1);
    expect(bar(0).fill).toHaveLength(0);
  });

  test("is always the same width, whatever the provider claims", () => {
    // A provider is free to report 0, 100, or something outside both.
    for (const p of [-10, 0, 37, 99.6, 100, 250]) {
      const b = bar(p);
      expect(b.fill.length + b.track.length).toBe(8);
    }
  });
});

describe("kindLabel", () => {
  test("shortens the kinds we know", () => {
    expect(kindLabel("session")).toBe("5h");
    expect(kindLabel("weekly_all")).toBe("7d");
  });

  test("an unknown kind is shown as-is rather than dropped", () => {
    expect(kindLabel("quarterly_something")).toBe("quarterly_something");
  });
});

describe("badgesShown", () => {
  const memory = (): Store & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
  };

  test("on until a browser switches it off, and remembered there", () => {
    const store = memory();
    expect(badgesShown(store)).toBe(true);
    setBadgesShown(false, store);
    expect(badgesShown(store)).toBe(false);
    expect(store.data.get("muxnexus.badges")).toBe("0");
    setBadgesShown(true, store);
    expect(badgesShown(store)).toBe(true);
  });

  test("blocked storage shows the badges and swallows the write", () => {
    const blocked: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(badgesShown(blocked)).toBe(true);
    expect(() => setBadgesShown(false, blocked)).not.toThrow();
  });

  test("the shared-checkout mark is switched on its own, and on by default", () => {
    const store = memory();
    expect(marksShown(store)).toBe(true);
    setMarksShown(false, store);
    expect(marksShown(store)).toBe(false);
    expect(badgesShown(store)).toBe(true);
    const blocked: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(marksShown(blocked)).toBe(true);
  });
});
