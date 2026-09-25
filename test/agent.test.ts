import { describe, expect, test } from "bun:test";
import {
  guardStamp,
  interruptedAfter,
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
  sharedCheckouts,
  sharingTitle,
  profileBadge,
  profileInitials,
  agentTitle,
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

describe("interruptedAfter", () => {
  // Shaped like the lines Claude Code writes; only the fields read here.
  const line = (o: object) => JSON.stringify({ isSidechain: false, ...o });
  const user = (at: string, content: unknown) =>
    line({ type: "user", timestamp: at, message: { role: "user", content } });
  const assistant = (at: string) =>
    line({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  const since = Date.parse("2026-09-25T09:35:25Z") / 1000;

  test("Esc while the model is writing leaves the marker last", () => {
    const tail = [assistant("2026-09-25T09:35:40Z"), user("2026-09-25T09:35:59Z", [{ type: "text", text: "[Request interrupted by user]" }])];
    expect(interruptedAfter(tail.join("\n"), since)).toBe(true);
  });

  test("Esc during a tool call, with a system line written after it", () => {
    const tail = [
      user("2026-09-25T09:35:59.306Z", [{ type: "tool_result", content: "The user doesn't want to proceed" }]),
      user("2026-09-25T09:35:59.310Z", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
      line({ type: "system", subtype: "away_summary", timestamp: "2026-09-25T09:39:03Z", content: "recap" }),
    ];
    expect(interruptedAfter(tail.join("\n") + "\n", since)).toBe(true);
  });

  test("a prompt typed after the interrupt is a new turn", () => {
    const tail = [user("2026-09-25T09:35:59Z", "[Request interrupted by user]"), user("2026-09-25T09:36:10Z", "carry on")];
    expect(interruptedAfter(tail.join("\n"), since)).toBe(false);
  });

  test("a stamp newer than the marker wins", () => {
    // UserPromptSubmit restamps before the new prompt reaches the file.
    const tail = user("2026-09-25T09:35:59Z", "[Request interrupted by user]");
    expect(interruptedAfter(tail, Date.parse("2026-09-25T09:36:10Z") / 1000)).toBe(false);
  });

  test("a subagent's interrupt is not the main thread's", () => {
    const tail = [assistant("2026-09-25T09:35:40Z"),
      line({ type: "user", isSidechain: true, timestamp: "2026-09-25T09:35:59Z", message: { content: "[Request interrupted by user]" } })];
    expect(interruptedAfter(tail.join("\n"), since)).toBe(false);
  });

  test("a cut-off first line and an empty tail are no evidence", () => {
    expect(interruptedAfter('rupted by user]"}}\n' + assistant("2026-09-25T09:35:40Z"), since)).toBe(false);
    expect(interruptedAfter("", since)).toBe(false);
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

  test("an interrupted turn is done though a status line keeps the window live", () => {
    const panes = [{ id: "@1", raw: "running 90 7", interrupted: true }, { id: "@2", raw: "input 90 8", interrupted: true }];
    const got = windowStates(panes, new Map([["@1", 100], ["@2", 100]]), 100, alive);
    expect(got.get("@1")?.state).toBe("done");
    expect(got.get("@2")?.state).toBe("done");
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

describe("profile badges", () => {
  const on = (profile?: string) => ({ agent: { state: "done" as const, since: "", ...(profile ? { profile } : {}) } });
  const profiles = ["personal", "work"];

  test("an initial each, two letters when two profiles share one", () => {
    expect([...profileInitials(profiles)]).toEqual([["personal", "P"], ["work", "W"]]);
    expect([...profileInitials(["personal", "work", "wife"])]).toEqual([["personal", "P"], ["work", "WO"], ["wife", "WI"]]);
  });

  test("the colour slot is the profile's row in the quota panel", () => {
    expect(profileBadge("personal", profiles)).toEqual({ profile: "personal", initial: "P", slot: 0 });
    expect(profileBadge("work", profiles)).toEqual({ profile: "work", initial: "W", slot: 1 });
  });

  test("a profile the panel does not list keeps its letter and gets no colour", () => {
    expect(profileBadge("client", profiles)).toEqual({ profile: "client", initial: "C", slot: null });
    // Its initial still avoids a listed profile's.
    expect(profileBadge("wife", profiles)).toEqual({ profile: "wife", initial: "WI", slot: null });
  });

  test("the tooltip names the account", () => {
    expect(agentTitle({ agent: { state: "running", since: "", profile: "work" } })).toBe("running · work profile");
    expect(agentTitle({ agent: { state: "running", since: "" } })).toBe("running");
  });
});

describe("sharedCheckouts", () => {
  const agent = (checkout?: string) => ({ state: "done" as const, since: "", ...(checkout ? { checkout } : {}) });
  const win = (id: string, checkout?: string) => ({ id, index: 0, name: id, active: false, panes: 1, agent: agent(checkout) });
  const label = (s: { name: string }, w: { id: string }) => `${s.name} › ${w.id}`;

  test("flags every agent in a checkout another agent is also in", () => {
    const got = sharedCheckouts([
      { name: "banner", windows: [win("@1", "/r/cms"), win("@2", "/r/deploy")] },
      { name: "voucher", windows: [win("@3", "/r/cms")] },
    ], label);
    expect(got.get("@1")).toEqual({ checkout: "/r/cms", others: ["voucher › @3"] });
    expect(got.get("@3")).toEqual({ checkout: "/r/cms", others: ["banner › @1"] });
    expect(got.has("@2")).toBe(false);
  });

  test("one window linked from two sessions is one agent, not a pair", () => {
    // A cmux tab session links the same window; the id says it is one.
    const got = sharedCheckouts([
      { name: "base", windows: [win("@1", "/r/cms")] },
      { name: "base~tab", windows: [win("@1", "/r/cms")] },
    ], label);
    expect(got.size).toBe(0);
  });

  test("windows without an agent or outside git are never flagged", () => {
    const plain = { id: "@9", index: 0, name: "zsh", active: false, panes: 1 };
    const got = sharedCheckouts([{ name: "a", windows: [plain, win("@2"), win("@3")] }], label);
    expect(got.size).toBe(0);
  });

  test("the title shows home as ~", () => {
    expect(sharingTitle({ checkout: "/Users/me/github/cms", others: ["[Work] Voucher › Voucher"] }))
      .toBe("Shared checkout ~/github/cms — also [Work] Voucher › Voucher");
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
