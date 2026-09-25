import { describe, expect, test } from "bun:test";
import { parseSession, shellQuote } from "../src/server/tmux";
import { defaultTarget, targets, weigh } from "../src/client/move";
import type { UsageSource } from "../src/shared/protocol";

describe("parseSession", () => {
  test("splits the id from the path", () => {
    expect(parseSession("29cd0b7f /Users/me/.claude/projects/-a/29cd.jsonl")).toEqual({
      sessionId: "29cd0b7f",
      transcriptPath: "/Users/me/.claude/projects/-a/29cd.jsonl",
    });
  });

  // The path is the rest of the line for exactly this reason.
  test("keeps a path that holds spaces whole", () => {
    expect(parseSession("abc /Users/me/My Projects/x.jsonl")?.transcriptPath)
      .toBe("/Users/me/My Projects/x.jsonl");
  });

  test("is null for an unstamped or half-written option", () => {
    expect(parseSession("")).toBeNull();
    expect(parseSession("   ")).toBeNull();
    expect(parseSession("only-an-id")).toBeNull();
  });
});

describe("shellQuote", () => {
  test("survives a space", () => {
    expect(shellQuote("/a b/c.jsonl")).toBe("'/a b/c.jsonl'");
  });

  // Without this the argument ends early and `claude --resume` resumes nothing,
  // or something else.
  test("survives an embedded single quote", () => {
    expect(shellQuote("/it's/c.jsonl")).toBe("'/it'\\''s/c.jsonl'");
  });
});

function source(label: string, percent: number, kind = "session"): UsageSource {
  return { id: label, label, state: "ok", checkedAt: "", windows: [{ kind, percent }] };
}

describe("targets", () => {
  test("pairs each profile with the quota row the panel shows it", () => {
    const out = targets([source("personal", 100), source("work", 23)], ["personal", "work"], "personal");
    expect(out.map((t) => [t.label, t.percent, t.here])).toEqual([
      ["personal", 100, true],
      ["work", 23, false],
    ]);
  });

  test("bands the bar's colour without inventing a budget", () => {
    const [a, b, c] = targets(
      [source("a", 10), source("b", 85), source("c", 100)],
      ["a", "b", "c"],
    );
    expect([a!.tone, b!.tone, c!.tone]).toEqual([undefined, "warning", "critical"]);
  });

  // An account with no quota source is still a place the conversation can go.
  test("keeps a profile that reports nothing", () => {
    const out = targets([], ["personal", "work"], "personal");
    expect(out).toHaveLength(2);
    expect(out[1]!.percent).toBeUndefined();
  });
});

describe("defaultTarget", () => {
  test("skips the account we are already on", () => {
    expect(defaultTarget(targets([source("personal", 5), source("work", 23)], ["personal", "work"], "personal")))
      .toBe("work");
  });

  test("prefers an account with room left", () => {
    const list = targets(
      [source("personal", 0), source("work", 100), source("glm", 12)],
      ["personal", "work", "glm"],
      "personal",
    );
    expect(defaultTarget(list)).toBe("glm");
  });

  // Landing on nothing would make the keyboard default a dead key at exactly the
  // moment every account is spent, which is when the picker is most used.
  test("still names a target when every other account is at its limit", () => {
    const list = targets([source("personal", 40), source("work", 100)], ["personal", "work"], "personal");
    expect(defaultTarget(list)).toBe("work");
  });

  test("is null when there is nowhere else to go", () => {
    expect(defaultTarget(targets([source("personal", 40)], ["personal"], "personal"))).toBeNull();
  });
});

describe("weigh", () => {
  test("reports the transcript in the units it actually has", () => {
    expect(weigh(16_000_000)).toBe("16 MB transcript");
    expect(weigh(1_400_000)).toBe("1.4 MB transcript");
    expect(weigh(24_000)).toBe("24 KB transcript");
  });

  test("says nothing rather than zero when the size is unknown", () => {
    expect(weigh(undefined)).toBeNull();
    expect(weigh(0)).toBeNull();
  });
});
