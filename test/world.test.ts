import { describe, expect, test } from "bun:test";
import { buildWorld, nextWaiting, type WorldInput } from "../src/client/world";
import { needsYouCount, nextAttention } from "../src/client/agent";
import { visualOrder } from "../src/client/groups";
import { sessionLabel } from "../src/client/labels";
import type { AgentInfo, SessionInfo, WindowInfo } from "../src/shared/protocol";

const win = (id: string, extra: Partial<WindowInfo> = {}): WindowInfo =>
  ({ id, index: Number(id.slice(1)), name: "zsh", active: false, panes: 1, ...extra });
const ses = (id: string, name: string, windows: WindowInfo[], extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name, attached: 0, windows, ...extra });
const agent = (state: AgentInfo["state"], since: string, extra: Partial<AgentInfo> = {}): AgentInfo =>
  ({ state, since, ...extra });
const input = (sessions: SessionInfo[], over: Partial<WorldInput> = {}): WorldInput =>
  ({ sessions, tmuxServer: "1-1", usage: [], folded: new Set(), current: null, marksShown: true, ...over });

const T = (m: number) => new Date(Date.UTC(2026, 9, 12, 10, m)).toISOString();

describe("buildWorld: structure", () => {
  const sessions = [
    ses("$1", "[Work] Alpha", [win("@1")]),
    ses("$2", "Solo", [win("@2")]),
    ses("$3", "[work] Beta", [win("@3")]),
  ];

  test("groups follow the sidebar: a tag gathers its sessions where its first one sits", () => {
    const w = buildWorld(input(sessions));
    expect(w.groups.map((g) => [g.key, g.name, g.sessions.map((s) => s.id)])).toEqual([
      ["work", "Work", ["$1", "$3"]],
      [null, null, ["$2"]],
    ]);
    expect(w.groups[0].sessions.map((s) => s.label)).toEqual(["Alpha", "Beta"]);
    expect(w.groups[1].sessions[0].label).toBe("Solo");
  });

  test("a folded group says so; an untagged session never is", () => {
    const w = buildWorld(input(sessions, { folded: new Set(["work", "solo"]) }));
    expect(w.groups.map((g) => g.folded)).toEqual([true, false]);
  });

  test("the current session is marked by tmux name", () => {
    const w = buildWorld(input(sessions, { current: "Solo" }));
    expect(w.groups[1].sessions[0].current).toBe(true);
    expect(w.groups[0].sessions[0].current).toBe(false);
  });

  test("lineage carries every key a replacement can be found by", () => {
    const w = buildWorld(input([ses("$1", "s", [win("@1", {
      conversation: { sessionId: "c-1", transcriptPath: "/Users/me/.claude/projects/x/c-1.jsonl" },
      forkedFrom: "c-0",
      noteId: "11111111-2222-3333-4444-555555555555",
    })])]));
    expect(w.groups[0].sessions[0].windows[0].lineage).toEqual({
      conversation: "c-1", from: "c-0", note: "11111111-2222-3333-4444-555555555555",
    });
  });

  test("quota accounts come through in the panel's order", () => {
    const w = buildWorld(input([], {
      usage: [
        { id: "a", label: "personal", provider: "claude", windows: [{ kind: "session", percent: 10 }], state: "ok", checkedAt: T(0) },
        { id: "b", label: "codex", provider: "codex", windows: [], state: "ok", checkedAt: T(0) },
      ],
    }));
    expect(w.accounts.map((a) => [a.label, a.provider])).toEqual([["personal", "claude"], ["codex", "codex"]]);
  });
});

describe("buildWorld: agents", () => {
  const one = (a: AgentInfo, extra: Partial<WindowInfo> = {}) =>
    buildWorld(input([ses("$1", "s", [win("@1", { agent: a, ...extra })])])).groups[0].sessions[0].windows[0];

  test("states are named for views, and a working agent is dated from its turn", () => {
    const w = one(agent("running", T(9), { source: "hook", turnStartedAt: T(1), turnSource: "hook", profile: "work" }));
    expect(w.agent).toEqual({
      kind: "claude", account: "work", state: "working", source: "hook", since: T(1),
      turnStartedAt: T(1), turnSource: "hook",
    });
  });

  test("a waiting agent is dated from its wait", () => {
    const w = one(agent("input", T(9), { waitingSince: T(5), waitSource: "first-seen", turnStartedAt: T(1), turnSource: "hook" }));
    expect(w.agent).toMatchObject({ state: "waiting", since: T(5), waitingSince: T(5), waitSource: "first-seen" });
  });

  test("without boundaries the stamp's time stands in", () => {
    expect(one(agent("running", T(9))).agent).toMatchObject({ state: "working", since: T(9), source: "hook" });
  });

  test("how an idle agent's turn ended follows from how it was known", () => {
    expect(one(agent("done", T(9), { source: "hook" })).agent?.endedBy).toBe("finished");
    expect(one(agent("done", T(9), { source: "transcript" })).agent?.endedBy).toBe("interrupted");
    expect(one(agent("done", T(9), { source: "quiet" })).agent?.endedBy).toBe("stale");
    expect(one(agent("running", T(9))).agent?.endedBy).toBeUndefined();
  });

  test("an idle agent keeps its last turn's length when the hook saw it end", () => {
    const w = one(agent("done", T(9), { turnStartedAt: T(1), turnEndedAt: T(8), turnSource: "hook" }));
    expect(w.agent).toMatchObject({ turnStartedAt: T(1), turnEndedAt: T(8) });
  });

  test("a Codex home is a Codex agent", () => {
    expect(one(agent("done", T(9), { profile: "codex" })).agent?.kind).toBe("codex");
  });

  test("two live agents in one checkout point at each other, unless the marks are off", () => {
    const sessions = [
      ses("$1", "a", [win("@1", { agent: agent("running", T(1), { checkout: "/Users/me/repo" }) })]),
      ses("$2", "b", [win("@2", { agent: agent("input", T(1), { checkout: "/Users/me/repo" }) })]),
    ];
    const w = buildWorld(input(sessions));
    expect(w.groups[0].sessions[0].windows[0].sharedWith).toEqual([{ session: "$2", window: "@2" }]);
    expect(w.groups[1].sessions[0].windows[0].sharedWith).toEqual([{ session: "$1", window: "@1" }]);
    const off = buildWorld(input(sessions, { marksShown: false }));
    expect(off.groups[0].sessions[0].windows[0].sharedWith).toEqual([]);
  });
});

describe("buildWorld: attention", () => {
  const sessions = [
    ses("$1", "[Work] A", [
      win("@1", { agent: agent("input", T(9), { waitingSince: T(5) }) }),
      win("@2", { agent: agent("input", T(9), { waitingSince: T(2) }) }),
      win("@3", { unread: true }),
    ]),
    ses("$2", "[Work] B", [win("@4", { agent: agent("running", T(1)) })]),
    ses("$3", "Solo", [win("@5", { agent: agent("input", T(7)) })]),
  ];

  test("counts and the longest wait per session, group and overall -- folded groups too", () => {
    const w = buildWorld(input(sessions, { folded: new Set(["work"]) }));
    expect(w.groups[0].sessions[0].attention).toEqual({ waiting: 2, oldestWaitSince: T(2), unread: 1 });
    expect(w.groups[0].attention).toEqual({ waiting: 2, oldestWaitSince: T(2), unread: 1 });
    expect(w.attention).toEqual({ waiting: 3, oldestWaitSince: T(2), unread: 1 });
  });

  test("the queue holds every waiting window, longest wait first", () => {
    expect(buildWorld(input(sessions)).queue).toEqual([
      { session: "$1", window: "@2" },
      { session: "$1", window: "@1" },
      { session: "$3", window: "@5" },
    ]);
  });

  test("agrees with the sidebar's count of sessions that need you", () => {
    const w = buildWorld(input(sessions));
    const waitingSessions = w.groups.flatMap((g) => g.sessions).filter((s) => s.attention.waiting > 0).length;
    expect(waitingSessions).toBe(needsYouCount(sessions));
  });

  test("viewing changes nothing: the current session still waits", () => {
    const w = buildWorld(input(sessions, { current: "[Work] A" }));
    expect(w.groups[0].sessions[0].attention.waiting).toBe(2);
  });
});

describe("nextWaiting", () => {
  const sessions = [
    ses("$1", "[Work] A", [win("@1"), win("@2", { agent: agent("input", T(9), { waitingSince: T(6) }) }), win("@3", { agent: agent("input", T(9), { waitingSince: T(3) }) })]),
    ses("$2", "Solo", [win("@4", { unread: true })]),
  ];

  test("picks ⌘J's session, at its longest-waiting window", () => {
    const ref = nextWaiting(sessions, null);
    expect(ref).toEqual({ session: "$1", window: "@3" });
    expect(sessions.find((s) => s.id === ref!.session)!.name).toBe(nextAttention(visualOrder(sessions, sessionLabel), null)!);
  });

  test("with nothing waiting, an unread window", () => {
    expect(nextWaiting([sessions[1]], null)).toEqual({ session: "$2", window: "@4" });
  });

  test("nothing wants you: null", () => {
    expect(nextWaiting([ses("$9", "x", [win("@9")])], null)).toBeNull();
  });
});

describe("buildWorld: accounts", () => {
  test("an account says whether it is signed in", () => {
    const usage = [{ id: "a", label: "alpha", provider: "claude" as const, windows: [], state: "signed-out" as const, checkedAt: T(0) }];
    expect(buildWorld(input([], { usage })).accounts).toEqual([{ label: "alpha", provider: "claude", windows: [], state: "signed-out" }]);
  });
});
