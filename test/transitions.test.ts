import { describe, expect, test } from "bun:test";
import { buildWorld, type World } from "../src/client/world";
import { diffWorlds } from "../src/client/transitions";
import type { AgentInfo, SessionInfo, WindowInfo } from "../src/shared/protocol";

const T = "2026-10-12T10:00:00.000Z";
const win = (id: string, extra: Partial<WindowInfo> = {}): WindowInfo =>
  ({ id, index: 0, name: "zsh", active: true, panes: 1, ...extra });
const world = (windows: WindowInfo[], tmuxServer = "1-1"): World =>
  buildWorld({ sessions: [{ id: "$1", name: "s", attached: 0, windows } as SessionInfo], tmuxServer, usage: [], folded: new Set(), current: null, marksShown: true });
const a = (state: AgentInfo["state"], extra: Partial<AgentInfo> = {}): AgentInfo => ({ state, since: T, ...extra });
const kinds = (prev: World | null, next: World) => diffWorlds(prev, next, 1000).map((e) => e.kind);
const ref = { session: "$1", window: "@1" };

describe("diffWorlds", () => {
  test("nothing on the first world, or after tmux itself restarted", () => {
    const w = world([win("@1", { agent: a("input") })]);
    expect(diffWorlds(null, w, 1000)).toEqual([]);
    expect(diffWorlds(world([win("@1", { agent: a("running") })], "1-1"), world([win("@1", { agent: a("input") })], "2-2"), 1000)).toEqual([]);
  });

  test("each change fires once, and an unchanged world fires nothing", () => {
    const working = world([win("@1", { agent: a("running") })]);
    const waiting = world([win("@1", { agent: a("input") })]);
    expect(diffWorlds(working, waiting, 1000)).toEqual([{ kind: "began-waiting", ref, at: 1000 }]);
    expect(diffWorlds(waiting, waiting, 2000)).toEqual([]);
  });

  test("answering resumes the turn rather than starting one", () => {
    expect(kinds(world([win("@1", { agent: a("input") })]), world([win("@1", { agent: a("running") })]))).toEqual(["resumed"]);
  });

  test("a turn starting from idle or from no agent", () => {
    expect(kinds(world([win("@1", { agent: a("done") })]), world([win("@1", { agent: a("running") })]))).toEqual(["began-working"]);
    expect(kinds(world([win("@1")]), world([win("@1", { agent: a("running") })]))).toEqual(["began-working"]);
  });

  test("a turn ending says how", () => {
    const working = world([win("@1", { agent: a("running") })]);
    expect(diffWorlds(working, world([win("@1", { agent: a("done", { source: "hook" }) })]), 1000))
      .toEqual([{ kind: "finished", ref, at: 1000, source: "hook" }]);
    expect(kinds(working, world([win("@1", { agent: a("done", { source: "transcript" }) })]))).toEqual(["interrupted"]);
    expect(diffWorlds(working, world([win("@1", { agent: a("done", { source: "quiet" }) })]), 1000))
      .toEqual([{ kind: "finished", ref, at: 1000, source: "quiet" }]);
  });

  test("a bell rings, and is seen", () => {
    expect(kinds(world([win("@1")]), world([win("@1", { unread: true })]))).toEqual(["rang"]);
    expect(kinds(world([win("@1", { unread: true })]), world([win("@1")]))).toEqual(["seen"]);
  });

  test("a move to another account", () => {
    const events = diffWorlds(world([win("@1", { agent: a("done", { profile: "personal" }) })]), world([win("@1", { agent: a("done", { profile: "work" }) })]), 1000);
    expect(events).toEqual([{ kind: "account-changed", ref, at: 1000, from: "personal", to: "work" }]);
  });

  test("windows appear and vanish", () => {
    expect(kinds(world([win("@1")]), world([win("@1"), win("@2")]))).toEqual(["appeared"]);
    expect(kinds(world([win("@1"), win("@2")]), world([win("@1")]))).toEqual(["vanished"]);
  });

  test("a window carrying on another's conversation, fork or note replaces it", () => {
    const conv = (id: string) => ({ sessionId: id, transcriptPath: `/Users/me/.claude/projects/x/${id}.jsonl` });
    const cases: [Partial<WindowInfo>, Partial<WindowInfo>][] = [
      [{ conversation: conv("c-1") }, { conversation: conv("c-1") }],
      [{ conversation: conv("c-1") }, { conversation: conv("c-2"), forkedFrom: "c-1" }],
      [{ noteId: "11111111-2222-3333-4444-555555555555" }, { noteId: "11111111-2222-3333-4444-555555555555" }],
    ];
    for (const [before, after] of cases) {
      const events = diffWorlds(world([win("@1", before)]), world([win("@2", after)]), 1000);
      expect(events).toEqual([{ kind: "replaced", ref: { session: "$1", window: "@2" }, previous: { session: "$1", window: "@1" }, at: 1000 }]);
    }
  });
});
