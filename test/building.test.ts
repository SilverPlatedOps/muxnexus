import { describe, expect, test } from "bun:test";
import { deriveBuilding, span } from "../src/client/building/derive";
import type { World, WorldAgent, WorldGroup, WorldSession, WorldWindow, WorldAccount } from "../src/client/world";

const T = (m: number) => new Date(Date.UTC(2026, 9, 12, 10, m)).toISOString();
const NOW = Date.parse(T(60));
const agent = (state: WorldAgent["state"], m: number, extra: Partial<WorldAgent> = {}): WorldAgent =>
  ({ kind: "claude", account: "alpha", state, source: "hook", since: T(m), ...extra });
const win = (id: string, a?: WorldAgent, name = "claude"): WorldWindow =>
  ({ id, name, lineage: {}, unread: false, sharedWith: [], ...(a ? { agent: a } : {}) });
const ses = (id: string, label: string, windows: WorldWindow[], current = false): WorldSession =>
  ({ id, name: label, label, current, windows, attention: { waiting: 0, unread: 0 } });
const grp = (key: string | null, sessions: WorldSession[]): WorldGroup =>
  ({ key, name: key, folded: false, sessions, attention: { waiting: 0, unread: 0 } });
const acct = (label: string, percent: number | null, extra: Partial<WorldAccount> = {}): WorldAccount =>
  ({ label, provider: "claude", windows: percent === null ? [] : [{ kind: "session", percent, resetsAt: T(120) }], state: "ok", ...extra });
const world = (groups: WorldGroup[], over: Partial<World> = {}): World =>
  ({ tmuxServer: "1-1", groups, attention: { waiting: 0, unread: 0 }, queue: [], accounts: [acct("alpha", 40), acct("beta", 10)], ...over });

describe("span", () => {
  test("minutes, then hours; under a minute is <1m", () => {
    expect(span(30_000)).toBe("<1m");
    expect(span(12 * 60_000)).toBe("12m");
    expect(span(72 * 60_000)).toBe("1h12m");
    expect(span(-1)).toBe("<1m");
  });
});

describe("floors", () => {
  test("tagged groups in sidebar order, untagged sessions share a lobby, archived is the basement", () => {
    const b = deriveBuilding(world([
      grp("archived", [ses("$9", "Old", [win("@9")])]),
      grp("work", [ses("$1", "Alpha", [win("@1")])]),
      grp(null, [ses("$2", "Solo", [win("@2")])]),
      grp("home", [ses("$3", "Beta", [win("@3")])]),
      grp(null, [ses("$4", "Solo 2", [win("@4")])]),
    ]), NOW);
    expect(b.floors.map((f) => [f.key, f.kind, f.people.map((p) => p.id)])).toEqual([
      ["work", "group", ["$1"]],
      ["home", "group", ["$3"]],
      ["lobby", "lobby", ["$2", "$4"]],
      ["archived", "basement", ["$9"]],
    ]);
    expect(b.floors[2].name).toBe("Lobby");
  });

  test("no untagged sessions, no lobby; no archive, no basement", () => {
    const b = deriveBuilding(world([grp("work", [ses("$1", "Alpha", [win("@1")])])]), NOW);
    expect(b.floors.map((f) => f.kind)).toEqual(["group"]);
  });
});

describe("sheets", () => {
  const person = (windows: WorldWindow[], over: Partial<World> = {}) =>
    deriveBuilding(world([grp("g", [ses("$1", "Alpha", windows)])], over), NOW).floors[0].people[0];

  test("a window with no agent, or a quiet one, is inferred and dashed; reported ones are solid", () => {
    const p = person([win("@1"), win("@2", agent("idle", 50, { source: "quiet" })), win("@3", agent("idle", 50, { source: "transcript", endedBy: "interrupted" }))]);
    expect(p.sheets.map((s) => [s.state, s.dashed])).toEqual([["inferred", true], ["inferred", true], ["idle", false]]);
    expect(p.sheets.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  test("colour slot follows the badged accounts; an unknown or missing account has none", () => {
    const p = person([win("@1", agent("idle", 50)), win("@2", agent("idle", 50, { account: "beta" })),
      win("@3", agent("idle", 50, { account: "zeta" })), win("@4", agent("idle", 50, { account: null }))]);
    expect(p.sheets.map((s) => s.slot)).toEqual([0, 1, null, null]);
  });

  test("sheets on an account past 85 % are amber", () => {
    const p = person([win("@1", agent("working", 50)), win("@2", agent("working", 50, { account: "beta" }))],
      { accounts: [acct("alpha", 90), acct("beta", 10)] });
    expect(p.sheets.map((s) => s.amber)).toEqual([true, false]);
  });
});

describe("person state and pose", () => {
  const person = (windows: WorldWindow[]) =>
    deriveBuilding(world([grp("g", [ses("$1", "Alpha", windows)])]), NOW).floors[0].people[0];

  test("waiting wins; the flag is on the oldest wait, which Enter opens", () => {
    const p = person([win("@1", agent("working", 55)), win("@2", agent("waiting", 52)), win("@3", agent("waiting", 40))]);
    expect(p.state).toBe("waiting");
    expect(p.sheets.map((s) => s.flag)).toEqual([false, false, true]);
    expect(p.target).toEqual({ session: "$1", window: "@3" });
    expect(p.status).toBe("waiting 20m");
    expect(p.pose).toBe("calm"); // the hand comes down after 10 minutes; light and flag stay
  });

  test("a fresh wait raises a hand", () => {
    expect(person([win("@1", agent("waiting", 55))]).pose).toBe("hand-up");
  });

  test("working beats idle and inferred; Enter opens the first window", () => {
    const p = person([win("@1", agent("idle", 10)), win("@2"), win("@3", agent("working", 58))]);
    expect([p.state, p.pose, p.status]).toEqual(["working", "typing", "working"]);
    expect(p.target).toEqual({ session: "$1", window: "@1" });
  });

  test("a ghost only when every window is inferred", () => {
    expect(person([win("@1"), win("@2", agent("idle", 54, { source: "quiet" }))]).state).toBe("ghost");
    expect(person([win("@1"), win("@2", agent("idle", 54, { source: "quiet" }))]).status).toBe("quiet 6m · inferred");
    expect(person([win("@1")]).status).toBe("quiet · inferred");
    expect(person([win("@1"), win("@2", agent("idle", 54))]).state).toBe("idle");
  });

  test("idle is away from the desk, then dozing after 30 minutes since the last turn ended", () => {
    const recent = person([win("@1", agent("idle", 10, { turnEndedAt: T(48) })), win("@2", agent("idle", 20))]);
    expect([recent.state, recent.pose, recent.status]).toEqual(["idle", "away", "idle 12m"]);
    expect(person([win("@1", agent("idle", 10))]).pose).toBe("asleep");
  });

  test("no windows at all: idle, nothing to open", () => {
    const p = person([]);
    expect([p.state, p.target, p.jobs]).toEqual(["idle", null, "0 jobs"]);
  });

  test("alt text states the facts", () => {
    const p = person([win("@1", agent("waiting", 55))]);
    expect(p.alt).toBe("Alpha · waiting 5m · 1 job");
  });
});

describe("queue and fuel", () => {
  test("the queue follows world.queue, oldest first, with who and how long", () => {
    const b = deriveBuilding(world([grp("g", [
      ses("$1", "Alpha", [win("@1", agent("waiting", 50))]),
      ses("$2", "Beta", [win("@2", agent("waiting", 30))]),
    ])], { queue: [{ session: "$2", window: "@2" }, { session: "$1", window: "@1" }] }), NOW);
    expect(b.queue.map((q) => [q.label, q.wait, q.ref.window])).toEqual([["Beta", "30m", "@2"], ["Alpha", "10m", "@1"]]);
  });

  test("fuel: a window the provider says is exceeded is empty, below 100 too", () => {
    const b = deriveBuilding(world([], { accounts: [acct("alpha", 97, { windows: [{ kind: "session", percent: 97, severity: "exceeded", resetsAt: T(120) }] })] }), NOW);
    expect(b.fuel[0].level).toBe("empty");
  });

  test("fuel: the 5h window's percent, amber from 85, empty at 100, none without a reading, signed-out kept", () => {
    const b = deriveBuilding(world([], { accounts: [acct("alpha", 40), acct("beta", 85), acct("codex", 100, { provider: "codex" }),
      acct("delta", null, { state: "signed-out" })] }), NOW);
    expect(b.fuel.map((f) => [f.label, f.percent, f.level, f.slot, f.signedOut])).toEqual([
      ["alpha", 40, "ok", 0, false], ["beta", 85, "amber", 1, false], ["codex", 100, "empty", 2, false], ["delta", null, "none", 3, true],
    ]);
  });
});

describe("rooms", () => {
  const groups = () => [
    grp("work", [ses("$1", "A", [win("@1")])]),
    grp("personal", [ses("$2", "B", [win("@2")])]),
    grp(null, [ses("$3", "C", [win("@3")])]),
    grp("archived", [ses("$4", "D", [win("@4")])]),
  ];

  test("defaults: open office, personal is a study, the lobby a lounge, the basement storage", () => {
    expect(deriveBuilding(world(groups()), NOW).floors.map((f) => f.room)).toEqual(["office", "study", "lounge", "storage"]);
  });

  test("a chosen room wins, except in the basement", () => {
    const b = deriveBuilding(world(groups()), NOW, { work: "war", lobby: "study", archived: "office" });
    expect(b.floors.map((f) => f.room)).toEqual(["war", "study", "study", "storage"]);
  });
});

describe("the dog", () => {
  test("sits with whoever has waited longest; nobody waiting, nobody", () => {
    const g = grp("g", [ses("$1", "A", [win("@1", agent("waiting", 50))]), ses("$2", "B", [win("@2", agent("waiting", 30))])]);
    expect(deriveBuilding(world([g], { queue: [{ session: "$2", window: "@2" }, { session: "$1", window: "@1" }] }), NOW).longestWait).toBe("$2");
    expect(deriveBuilding(world([g]), NOW).longestWait).toBeNull();
  });
});
