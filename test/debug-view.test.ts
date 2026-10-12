import { describe, expect, test } from "bun:test";
import { agentLine, attentionLine, eventLine, formatSpan } from "../src/client/views/debug";
import type { WorldAgent } from "../src/client/world";

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();
const NOW = Date.parse(at(0)) + 12 * 60_000 + 5_000; // 12m05s after at(0)

describe("formatSpan", () => {
  test("seconds, then minutes, then hours", () => {
    expect(formatSpan(45_000)).toBe("45s");
    expect(formatSpan(12 * 60_000 + 5_000)).toBe("12m05s");
    expect(formatSpan(72 * 60_000)).toBe("1h12m");
    expect(formatSpan(-5)).toBe("0s");
  });
});

describe("agentLine", () => {
  const base: WorldAgent = { kind: "claude", account: "work", state: "working", source: "hook", since: at(0) };

  test("a working agent: how long its turn has run, and how that is known", () => {
    expect(agentLine({ ...base, turnStartedAt: at(0), turnSource: "hook" }, NOW))
      .toBe("working 12m05s (turn from hook) · source hook · claude · work");
    expect(agentLine(base, NOW)).toBe("working 12m05s (from stamp) · source hook · claude · work");
  });

  test("a waiting agent: how long it has waited", () => {
    expect(agentLine({ ...base, state: "waiting", waitingSince: at(0), waitSource: "first-seen" }, NOW))
      .toBe("waiting 12m05s (wait first-seen) · source hook · claude · work");
  });

  test("an idle agent: how its turn ended, and how long the last one took", () => {
    const idle: WorldAgent = { ...base, state: "idle", source: "transcript", endedBy: "interrupted", turnStartedAt: at(0), turnEndedAt: at(30) };
    expect(agentLine(idle, NOW)).toBe("idle, interrupted (last turn 30s) · source transcript · claude · work");
    expect(agentLine({ ...base, state: "idle", endedBy: "finished", account: null }, NOW)).toBe("idle, finished · source hook · claude · default");
  });
});

describe("attentionLine / eventLine", () => {
  test("attention says counts and the longest wait", () => {
    expect(attentionLine({ waiting: 2, oldestWaitSince: at(0), unread: 1 }, NOW)).toBe("2 waiting, longest 12m05s · 1 unread");
    expect(attentionLine({ waiting: 0, unread: 0 }, NOW)).toBe("0 waiting · 0 unread");
  });

  test("an event names its kind, window and extras", () => {
    const t = Date.UTC(2026, 9, 12, 10, 0, 7);
    expect(eventLine({ kind: "began-waiting", ref: { session: "$1", window: "@2" }, at: t })).toMatch(/ began-waiting \$1 @2$/);
    expect(eventLine({ kind: "finished", ref: { session: "$1", window: "@2" }, at: t, source: "quiet" })).toMatch(/ finished \$1 @2 \(quiet\)$/);
    expect(eventLine({ kind: "replaced", ref: { session: "$1", window: "@3" }, previous: { session: "$1", window: "@2" }, at: t })).toMatch(/ replaced \$1 @3 \(was @2\)$/);
    expect(eventLine({ kind: "account-changed", ref: { session: "$1", window: "@2" }, at: t, from: "personal", to: "work" })).toMatch(/ account-changed \$1 @2 \(personal → work\)$/);
  });
});
