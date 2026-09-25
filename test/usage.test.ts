import { describe, expect, test } from "bun:test";
import {
  accessToken,
  backoffMs,
  categoryProfile,
  createUsageReader,
  findProfiles,
  keychainService,
  merge,
  parseClaudeUsage,
  parseEnv,
  parseOpencodeUsage,
  profileLabel,
} from "../src/server/usage";
import { badgesShown, bar, formatReset, kindLabel, setBadgesShown, type Store } from "../src/client/usage";
import type { UsageSource } from "../src/shared/protocol";

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

describe("parseEnv", () => {
  test("strips the export prefix", () => {
    // Reading these files without this is how the first live check got a 401.
    expect(parseEnv("export OPENCODE_GO_API_KEY=abc123").get("OPENCODE_GO_API_KEY")).toBe("abc123");
  });

  test("handles quotes, comments, blank lines and plain assignments", () => {
    const env = parseEnv(`
# a comment
export A="quoted"
B='single'
C=plain
`);
    expect(env.get("A")).toBe("quoted");
    expect(env.get("B")).toBe("single");
    expect(env.get("C")).toBe("plain");
  });

  test("a value containing = survives", () => {
    expect(parseEnv("export T=ab=cd==").get("T")).toBe("ab=cd==");
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

describe("parseOpencodeUsage", () => {
  const body = JSON.stringify({
    usage: {
      rolling: { status: "ok", percent: 2, resetsAt: "2026-09-24T14:04:31.235Z" },
      weekly: { status: "ok", percent: 40, resetsAt: "2026-09-28T00:00:00.000Z" },
    },
  });

  test("reads the named windows", () => {
    expect(parseOpencodeUsage(body)).toEqual([
      { kind: "rolling", percent: 2, resetsAt: "2026-09-24T14:04:31.235Z" },
      { kind: "weekly", percent: 40, resetsAt: "2026-09-28T00:00:00.000Z" },
    ]);
  });

  test("garbage is empty rather than a throw", () => {
    expect(parseOpencodeUsage("nope")).toEqual([]);
    expect(parseOpencodeUsage(JSON.stringify({ usage: null }))).toEqual([]);
  });
});

describe("merge", () => {
  const previous: UsageSource = {
    id: "p", label: "personal", state: "ok", checkedAt: "2026-09-24T09:00:00Z",
    windows: [{ kind: "session", percent: 50 }],
  };

  test("a good read replaces everything", () => {
    const got = merge(previous, { id: "p", label: "personal", windows: [{ kind: "session", percent: 60 }], state: "ok", now: "T1" });
    expect(got).toEqual({ id: "p", label: "personal", state: "ok", checkedAt: "T1", windows: [{ kind: "session", percent: 60 }] });
  });

  test("a failure keeps the last good numbers and the time they were true", () => {
    const got = merge(previous, { id: "p", label: "personal", windows: [], state: "error", now: "T1" });
    expect(got.windows).toEqual(previous.windows);
    expect(got.state).toBe("error");
    expect(got.checkedAt).toBe("2026-09-24T09:00:00Z");
  });

  test("a failure with nothing to fall back on is simply empty", () => {
    expect(merge(undefined, { id: "p", label: "p", windows: [], state: "signed-out", now: "T1" }).windows).toEqual([]);
  });
});

describe("the reader, with the network and Keychain injected", () => {
  const base = {
    home: HOME,
    list: () => [".claude", ".claude-work"],
    has: (p: string) => p.endsWith("/projects"),
    readFile: async () => null, // opencode not installed
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

  test("opencode is a row only when it is installed", async () => {
    const withIt = createUsageReader({
      ...base,
      secret: async () => null,
      readFile: async () => "export OPENCODE_GO_API_KEY=k",
      fetch: async () => ({ status: 200, body: JSON.stringify({ usage: { rolling: { percent: 5 } } }) }),
    });
    expect((await withIt.read()).map((s) => s.id)).toContain("opencode");
    const without = createUsageReader({ ...base, secret: async () => null, fetch: async () => ({ status: 200, body: ok }) });
    expect((await without.read()).map((s) => s.id)).not.toContain("opencode");
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
});
