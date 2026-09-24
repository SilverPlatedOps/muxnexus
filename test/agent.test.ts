import { describe, expect, test } from "bun:test";
import {
  guardStamp,
  parseStamp,
  STALE_SECONDS,
  unreadWindow,
  windowStates,
  worstState,
} from "../src/server/tmux";
import {
  formatElapsed,
  needsYouCount,
  nextAttention,
  sessionAgent,
  sessionGlyph,
  windowDots,
  windowGlyph,
} from "../src/client/agent";
import { summaryWindow } from "../src/client/usage";
import type { WindowInfo } from "../src/shared/protocol";

describe("parseStamp", () => {
  test("reads what the hook writes", () => {
    expect(parseStamp("running 1790242563 61936")).toEqual({ state: "running", since: 1790242563, pid: 61936 });
    expect(parseStamp("  input 1 2  ")).toEqual({ state: "input", since: 1, pid: 2 });
  });

  test("reads the config dir after the pid, spaces and all", () => {
    expect(parseStamp("done 1 2 /Users/me/.claude-work")).toEqual({ state: "done", since: 1, pid: 2, configDir: "/Users/me/.claude-work" });
    expect(parseStamp("done 1 2 /Users/me/My Profiles/.claude")?.configDir).toBe("/Users/me/My Profiles/.claude");
  });

  test("anything else is no stamp rather than a guess", () => {
    // The option is a string tmux hands back verbatim; it can hold anything.
    for (const raw of ["", "running", "running 1", "sleeping 1 2", "running x 2", "running 1 0"]) {
      expect(parseStamp(raw)).toBeNull();
    }
  });
});

describe("worstState", () => {
  test("wanting the human outranks working, which outranks idle", () => {
    expect(worstState(["done", "input", "running"])).toBe("input");
    expect(worstState(["done", "running"])).toBe("running");
    expect(worstState(["done"])).toBe("done");
  });

  test("nothing at all is undefined", () => {
    expect(worstState([])).toBeUndefined();
  });
});

describe("guardStamp", () => {
  const alive = () => true;
  const dead = () => false;
  const stamp = (state: "input" | "running" | "done") => ({ state, since: 1000, pid: 42 });

  test("a dead process means no state, however recent the stamp", () => {
    // SessionEnd removes the stamp on a clean exit; a killed agent never fires it.
    expect(guardStamp(stamp("running"), 2000, 2000, dead)).toBeNull();
    expect(guardStamp(stamp("input"), 2000, 2000, dead)).toBeNull();
  });

  test("running with a frozen window is reported as done", () => {
    // Stop does not fire when the user interrupts, so `running` would stick.
    const frozen = 2000 - STALE_SECONDS - 1;
    expect(guardStamp(stamp("running"), frozen, 2000, alive)).toBe("done");
  });

  test("running with a live window stays running", () => {
    expect(guardStamp(stamp("running"), 1999, 2000, alive)).toBe("running");
  });

  test("the freeze guard never touches input -- a waiting agent draws nothing", () => {
    // This is the whole point: a prompt sits there silently for an hour.
    expect(guardStamp(stamp("input"), 0, 999999, alive)).toBe("input");
  });
});

describe("windowStates", () => {
  const alive = () => true;
  const activity = new Map([["@1", 100]]);

  test("takes the most urgent pane in a window", () => {
    const got = windowStates(
      [{ id: "@1", raw: "done 50 7" }, { id: "@1", raw: "input 60 8" }],
      activity, 100, alive,
    );
    expect(got.get("@1")).toEqual({ state: "input", since: 60 });
  });

  test("the profile is the speaking pane's", () => {
    const got = windowStates(
      [{ id: "@1", raw: "done 50 7 /h/.claude" }, { id: "@1", raw: "input 60 8 /h/.claude-work" }],
      activity, 100, alive,
    );
    expect(got.get("@1")).toEqual({ state: "input", since: 60, configDir: "/h/.claude-work" });
  });

  test("reports the longest wait when two panes agree", () => {
    const got = windowStates(
      [{ id: "@1", raw: "input 90 7" }, { id: "@1", raw: "input 30 8" }],
      activity, 100, alive,
    );
    expect(got.get("@1")?.since).toBe(30);
  });

  test("unstamped panes contribute nothing", () => {
    expect(windowStates([{ id: "@1", raw: "" }], activity, 100, alive).size).toBe(0);
  });

  test("a window with no activity entry still resolves", () => {
    // A pane whose window vanished between the two tmux calls.
    const got = windowStates([{ id: "@9", raw: "input 10 7" }], activity, 100, alive);
    expect(got.get("@9")?.state).toBe("input");
  });
});

describe("unreadWindow", () => {
  const link = (bell: boolean, attached: boolean, active: boolean) => ({ bell, attached, active });

  test("no bell anywhere is not unread", () => {
    expect(unreadWindow([link(false, false, true)])).toBe(false);
  });

  test("a bell on any winlink counts, not just the base's", () => {
    // Observed live: the bell sat on a cmux tab session's winlink while the
    // base's flag was clear, because the base was viewing when it rang.
    expect(unreadWindow([link(false, false, true), link(true, false, false)])).toBe(true);
  });

  test("an attached session showing the window means it has been seen", () => {
    expect(unreadWindow([link(true, false, false), link(false, true, true)])).toBe(false);
  });

  test("a detached session showing it does not count as seen", () => {
    expect(unreadWindow([link(true, false, false), link(false, false, true)])).toBe(true);
  });
});

describe("glyphs", () => {
  const w = (agent?: WindowInfo["agent"], unread?: boolean) => ({ agent, unread });

  test("a window shows the most urgent thing true of it", () => {
    expect(windowGlyph(w({ state: "input", since: "" }))).toBe("input");
    expect(windowGlyph(w({ state: "running", since: "" }))).toBe("running");
    expect(windowGlyph(w({ state: "done", since: "" }, true))).toBe("unread");
    expect(windowGlyph(w({ state: "done", since: "" }))).toBe("seen");
    expect(windowGlyph(w(undefined))).toBe("none");
  });

  test("a bell with no agent still shows unread -- something rang", () => {
    expect(windowGlyph(w(undefined, true))).toBe("unread");
  });

  test("input beats running even when the running window rang", () => {
    expect(windowGlyph(w({ state: "input", since: "" }, true))).toBe("input");
  });

  test("a session takes the worst of its windows", () => {
    expect(sessionGlyph([w({ state: "done", since: "" }), w({ state: "input", since: "" })])).toBe("input");
    expect(sessionGlyph([w(undefined), w({ state: "done", since: "" }, true)])).toBe("unread");
    expect(sessionGlyph([])).toBe("none");
  });

  test("window dots appear only when two or more windows have something to say", () => {
    // One agent among plain shells would only repeat the row's own glyph.
    expect(windowDots([w({ state: "running", since: "" }), w(undefined), w(undefined)])).toEqual([]);
    expect(windowDots([w({ state: "input", since: "" })])).toEqual([]);
    expect(windowDots([])).toEqual([]);
    // Two agents: every window keeps its slot, so a dot still points at a tab.
    expect(windowDots([w({ state: "running", since: "" }), w(undefined), w({ state: "done", since: "" })]))
      .toEqual(["running", "none", "seen"]);
    // A bell counts as something to say, agent or not.
    expect(windowDots([w(undefined, true), w({ state: "input", since: "" })])).toEqual(["unread", "input"]);
  });
});

describe("sessionAgent", () => {
  test("speaks for the window that has waited longest", () => {
    const got = sessionAgent([
      { agent: { state: "input", since: "2026-09-24T10:00:00Z" } },
      { agent: { state: "input", since: "2026-09-24T09:00:00Z" } },
    ]);
    expect(got?.since).toBe("2026-09-24T09:00:00Z");
  });

  test("says nothing for a session that is merely idle", () => {
    expect(sessionAgent([{ agent: { state: "done", since: "x" }, unread: true }])).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  const now = Date.parse("2026-09-24T10:00:00Z");

  test("minutes, hours and days", () => {
    expect(formatElapsed("2026-09-24T09:56:00Z", now)).toBe("4m");
    expect(formatElapsed("2026-09-24T08:48:00Z", now)).toBe("1h12");
    expect(formatElapsed("2026-09-22T07:00:00Z", now)).toBe("2d03");
  });

  test("under a minute says nothing rather than flickering 0m", () => {
    expect(formatElapsed("2026-09-24T09:59:30Z", now)).toBe("");
  });

  test("a missing or unparseable stamp is blank", () => {
    expect(formatElapsed(undefined, now)).toBe("");
    expect(formatElapsed("soon", now)).toBe("");
  });
});

describe("needsYouCount and nextAttention", () => {
  const s = (name: string, glyph: "input" | "unread" | "none") => ({
    name,
    windows: (glyph === "none"
      ? [{ id: "@1", index: 0, name: "z", active: true, panes: 1 }]
      : glyph === "input"
        ? [{ id: "@1", index: 0, name: "z", active: true, panes: 1, agent: { state: "input" as const, since: "" } }]
        : [{ id: "@1", index: 0, name: "z", active: true, panes: 1, unread: true }]) as WindowInfo[],
  });

  test("counts only sessions that are blocked", () => {
    expect(needsYouCount([s("a", "input"), s("b", "unread"), s("c", "none")])).toBe(1);
  });

  test("jumps to the next blocked session after the current one, wrapping", () => {
    const list = [s("a", "input"), s("b", "none"), s("c", "input")];
    expect(nextAttention(list, "a")).toBe("c");
    expect(nextAttention(list, "c")).toBe("a");
  });

  test("falls back to unread when nothing is blocked", () => {
    expect(nextAttention([s("a", "none"), s("b", "unread")], "a")).toBe("b");
  });

  test("returns null when nothing wants you, so the key does nothing", () => {
    expect(nextAttention([s("a", "none")], "a")).toBeNull();
    expect(nextAttention([], null)).toBeNull();
  });
});

describe("summaryWindow", () => {
  test("every account shows its 5h window, so the rows can be compared", () => {
    // Claude calls it `session`, opencode calls it `rolling`.
    expect(summaryWindow([
      { kind: "weekly_all", percent: 90 },
      { kind: "session", percent: 12 },
    ])?.kind).toBe("session");
    expect(summaryWindow([
      { kind: "weekly", percent: 49 },
      { kind: "rolling", percent: 4 },
    ])?.kind).toBe("rolling");
  });

  test("the 5h window wins even when a longer one is the severe one", () => {
    // Otherwise one account's row silently changes meaning.
    expect(summaryWindow([
      { kind: "weekly_all", percent: 95, severity: "warning" },
      { kind: "session", percent: 3, severity: "normal" },
    ])?.kind).toBe("session");
  });

  test("with no 5h window, the severe one, else the fullest", () => {
    expect(summaryWindow([
      { kind: "weekly_all", percent: 20, severity: "warning" },
      { kind: "monthly", percent: 90 },
    ])?.kind).toBe("weekly_all");
    expect(summaryWindow([{ kind: "weekly", percent: 20 }, { kind: "monthly", percent: 41 }])?.kind).toBe("monthly");
  });

  test("nothing to summarise is undefined", () => {
    expect(summaryWindow([])).toBeUndefined();
  });
});
