import { describe, expect, test } from "bun:test";
import {
  canOpen,
  chatsAsking,
  parseCap,
  chatRows,
  composerState,
  headerSummary,
  heldCount,
  memberColour,
  memberStatus,
  mentionChoices,
  messageRows,
  knownFolders,
  nearAgent,
  pickerGroups,
  prefill,
  prefillChips,
  retryStaged,
  shutdownList,
  sideTab,
  stagedFolder,
  stagedProfile,
  tabChats,
} from "../src/client/chat/model";
import { addMember, leave, newChat, post } from "../src/server/chat/model";
import type { Chat, ChatSummary } from "../src/shared/chat";
import type { ChatMemberLive, SessionInfo } from "../src/shared/protocol";

const T = "2026-10-26T12:00:00.000Z";

function chat(): Chat {
  const c = newChat("c1", "shop review", T);
  addMember(c, { kind: "claude", windowId: "@1", session: "shop", role: "driver" }, T);
  addMember(c, { kind: "codex", windowId: "@2", session: "shop", role: "reviewer" }, T);
  return c;
}
const summary = (over: Partial<ChatSummary>): ChatSummary => ({ id: "x", name: "x", archived: false, glyph: "seen", members: 2, windows: [], ...over });

describe("the sidebar", () => {
  test("the tab defaults to workspaces and is remembered", () => {
    expect(sideTab(null)).toBe("workspaces");
    expect(sideTab("chats")).toBe("chats");
    expect(sideTab("nonsense")).toBe("workspaces");
  });

  test("archived chats fold to the bottom, and search filters by name", () => {
    const rows = chatRows([summary({ id: "a", name: "plan review" }), summary({ id: "b", name: "old", archived: true }), summary({ id: "c", name: "api contract" })], "");
    expect(rows.active.map((r) => r.id)).toEqual(["a", "c"]);
    expect(rows.archived.map((r) => r.id)).toEqual(["b"]);
    expect(chatRows([summary({ id: "a", name: "plan review" }), summary({ id: "c", name: "api contract" })], "API").active.map((r) => r.id)).toEqual(["c"]);
  });

  test("chats asking the user, not counting the one on screen", () => {
    const chats = [summary({ id: "a", glyph: "input" }), summary({ id: "b", glyph: "input" }), summary({ id: "c", glyph: "running" })];
    expect(chatsAsking(chats, "a").map((c) => c.id)).toEqual(["b"]);
    expect(chatsAsking(chats, null).map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("a tab knows the chats it is in", () => {
    const m = tabChats([summary({ id: "a", windows: ["@1", "@2"] }), summary({ id: "b", windows: ["@2"] }), summary({ id: "z", windows: ["@2"], archived: true })]);
    expect(m.get("@1")!.map((c) => c.id)).toEqual(["a"]);
    expect(m.get("@2")!.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("the conversation", () => {
  test("rows carry shape and colour, and the user's rows are marked me", () => {
    const c = chat();
    post(c, "user", "@claude1 go", T);
    post(c, "claude1", "@codex1 look", T);
    const rows = messageRows(c).filter((r) => r.kind === "msg");
    expect(rows.map((r) => [r.from, r.shape, r.me])).toEqual([["user", "›", true], ["claude1", "◆", false]]);
    expect(rows[1]!.colour).toBe("oklch(82% .11 155)");
    expect(memberColour(c.members[0]!)).toBeNull();
  });

  test("mentions are parts of their own, for drawing", () => {
    const c = chat();
    post(c, "user", "hi @claude1, look", T);
    expect(messageRows(c).at(-1)!.parts).toEqual([{ text: "hi " }, { text: "@claude1", mention: true }, { text: ", look" }]);
  });

  test("✓ only when every recipient has it, ◷ while any waits, nothing for context", () => {
    const c = chat();
    const both = post(c, "user", "@claude1 @codex1 go", T);
    const none = post(c, "user", "just saying", T);
    both.deliveries.claude1 = { state: "delivered", at: T };
    expect(messageRows(c).find((r) => r.id === both.id)!.tick).toBe("◷");
    both.deliveries.codex1 = { state: "delivered", at: T };
    expect(messageRows(c).find((r) => r.id === both.id)!.tick).toBe("✓");
    expect(messageRows(c).find((r) => r.id === none.id)!.tick).toBeNull();
  });

  test("what an agent said in its tab rides on its line, with a line count, for posts and system lines", () => {
    const c = chat();
    const p = post(c, "claude1", "sub looks wrong", T);
    const plain = post(c, "codex1", "agreed", T);
    const sys = post(c, "claude1", "claude1 finished without replying", T, { system: true });
    p.tabText = "Two problems.\n\nPosted my review.";
    sys.tabText = "Nothing to report.";
    const rows = messageRows(c);
    expect(rows.find((r) => r.id === p.id)!.tab).toEqual({ text: "Two problems.\n\nPosted my review.", lines: 3 });
    expect(rows.find((r) => r.id === plain.id)!.tab).toBeNull();
    expect(rows.find((r) => r.id === sys.id)!.tab).toEqual({ text: "Nothing to report.", lines: 1 });
  });

  test("a delivery that went wrong adds one line under its message", () => {
    const c = chat();
    const m = post(c, "user", "@claude1 @codex1 go", T);
    m.deliveries.claude1 = { state: "queued", reason: "offline", at: T };
    m.deliveries.codex1 = { state: "queued", reason: "no conversation yet", at: T };
    expect(messageRows(c).find((r) => r.id === m.id)!.exceptions).toEqual([
      "✕ not delivered to claude1 · offline, it gets it when its tab is back",
      "◷ queued for codex1 · it hasn't started a conversation yet",
    ]);
    m.deliveries.claude1 = { state: "failed", reason: "unavailable: no such thread", at: T };
    expect(messageRows(c).find((r) => r.id === m.id)!.exceptions[0]).toBe("✕ not delivered to claude1 · unavailable: no such thread");
    m.deliveries.claude1 = { state: "failed", reason: "not confirmed: its agent went away before reading it", at: T };
    expect(messageRows(c).find((r) => r.id === m.id)!.exceptions[0]).toBe("✕ not confirmed for claude1 · its agent went away before reading it");
  });

  test("turnStart marks a change of speaker only", () => {
    const c = chat();
    post(c, "claude1", "one", T);
    post(c, "claude1", "two", T);
    post(c, "codex1", "three", T);
    expect(messageRows(c).filter((r) => r.kind === "msg").map((r) => r.turnStart)).toEqual([true, false, true]);
  });

  test("the room's own lines are system rows", () => {
    const c = chat();
    leave(c, "codex1", T);
    expect(messageRows(c).at(-1)).toMatchObject({ kind: "system", text: "codex1 left" });
  });
});

describe("the message box", () => {
  test("it shows who will hear, and says so when nobody will", () => {
    const c = chat();
    expect(composerState(c, "@claude1 go")).toEqual({ to: ["claude1"], helper: null });
    expect(composerState(c, "nice work")).toEqual({ to: [], helper: "No agents notified" });
    expect(composerState(c, "")).toEqual({ to: [], helper: null });
  });

  test("prefill is the agent who last spoke to the user, while it is still in the chat", () => {
    const c = chat();
    post(c, "claude1", "@user which one?", T);
    expect(prefill(c)).toBe("claude1");
    leave(c, "claude1", T);
    expect(prefill(c)).toBeNull();
  });

  test("a chip the user removed stays removed until another agent speaks to them, or they send", () => {
    const c = chat();
    post(c, "claude1", "@user which one?", T);
    let s = prefillChips({ chips: [], draft: "", offered: "claude1" }, c);
    expect(s.chips).toEqual([]);
    post(c, "codex1", "@user and me?", T);
    s = prefillChips(s, c);
    expect(s).toEqual({ chips: ["codex1"], draft: "", offered: "codex1" });
    expect(prefillChips({ chips: [], draft: "", offered: null }, c).chips).toEqual(["codex1"]);
    // Not offered while the user types: it is offered once the box is empty again.
    expect(prefillChips({ chips: [], draft: "typing", offered: null }, c)).toEqual({ chips: [], draft: "typing", offered: null });
  });

  test("held messages are counted for the pause strip", () => {
    const c = chat();
    c.cap = 1;
    post(c, "claude1", "@codex1 look", T);
    expect(heldCount(c)).toBe(1);
  });

  test("mention choices show kind, workspace, role and state", () => {
    const c = chat();
    const agents: Record<string, ChatMemberLive> = { claude1: { online: true, state: "running", session: "shop" }, codex1: { online: true, state: "done", session: "shop" } };
    expect(mentionChoices(c, agents, "co")).toEqual([{ handle: "codex1", meta: "Codex · shop · reviewer · idle" }]);
    expect(mentionChoices(c, agents, "").map((x) => x.handle)).toEqual(["claude1", "codex1"]);
  });
});

describe("members", () => {
  test("each state has its one fix", () => {
    const c = chat();
    const m = post(c, "user", "@codex1 go", T);
    m.deliveries.codex1 = { state: "queued", reason: "offline", at: T };
    const [claude, codex] = [c.members[1]!, c.members[2]!];
    expect(memberStatus(c, claude, { online: true, state: "input" })).toEqual({ text: "needs attention", fix: "open", alarm: true });
    expect(memberStatus(c, claude, { online: true, state: "running" })).toEqual({ text: "working" });
    expect(memberStatus(c, codex, { online: false })).toEqual({ text: "offline · 1 waiting", fix: "reconnect" });
    expect(memberStatus(c, { ...codex, windowId: undefined, spawn: "failed", spawnError: "no such folder" }, { online: false })).toEqual({ text: "didn't start: no such folder", fix: "retry", alarm: true });
    expect(memberStatus(c, { ...codex, spawn: "failed", spawnError: "it may be waiting on a prompt in its tab" }, { online: false })).toEqual({ text: "hasn't started: it may be waiting on a prompt in its tab", fix: "open", alarm: true });
    expect(memberStatus(c, { ...codex, spawn: "pending" }, { online: false })).toEqual({ text: "starting…", fix: "open" });
    expect(memberStatus(c, codex, { online: false, replaced: true })).toEqual({ text: "another agent runs in its tab · 1 waiting", fix: "reconnect" });
  });

  test("the header warns once: someone needs you, and how many are offline", () => {
    const c = chat();
    expect(headerSummary(c, { claude1: { online: true, state: "input" }, codex1: { online: false } })).toEqual({ members: 2, needsYou: true, offline: 1 });
  });
});

describe("the new chat picker", () => {
  const sessions: SessionInfo[] = [
    { name: "shop", id: "$1", attached: 0, windows: [
      { id: "@1", index: 0, name: "claude", active: true, panes: 1, agent: { state: "done", since: T, profile: "personal", checkout: "/Users/me/shop" } },
      { id: "@2", index: 1, name: "codex", active: false, panes: 1, agent: { state: "running", since: T, profile: "codex", checkout: "/Users/me/shop" } },
      { id: "@3", index: 2, name: "zsh", active: false, panes: 1 },
    ] },
    { name: "notes", id: "$2", attached: 0, windows: [{ id: "@4", index: 0, name: "codex", active: true, panes: 1 }] },
  ];

  test("agents are grouped by workspace, with kind, profile and folder; shells are left out", () => {
    const groups = pickerGroups(sessions, new Set());
    expect(groups.map((g) => [g.session, g.agents.map((a) => [a.windowId, a.kind, a.profile ?? null, a.folder ?? null, a.waiting])])).toEqual([
      ["shop", [["@1", "claude", "personal", "/Users/me/shop", false], ["@2", "codex", "codex", "/Users/me/shop", false]]],
      ["notes", [["@4", "codex", null, null, true]]],
    ]);
  });

  test("a new agent starts beside the agent picked in its workspace, else in ~, belonging to no project", () => {
    const picked = pickerGroups(sessions, new Set())[0]!.agents[0]!;
    expect(stagedFolder("shop", picked)).toBe("/Users/me/shop");
    expect(stagedFolder("shop")).toBe("~");
    expect(stagedFolder("notes", picked)).toBe("~");
  });

  test("a new Claude runs as the profile its box shows: its workspace's when named for one, else the picked agent's beside it, else the first", () => {
    const profiles = ["personal", "work"];
    expect(stagedProfile("[Work] Shop orders", profiles)).toBe("work");
    expect(stagedProfile("[Personal] Notes", profiles, { session: "[Personal] Notes", profile: "work" })).toBe("personal");
    expect(stagedProfile("[Archived] Old shop", profiles, { session: "[Archived] Old shop", profile: "work" })).toBe("work");
    expect(stagedProfile("notes", profiles, { session: "[Archived] Old shop", profile: "work" })).toBe("personal");
    expect(stagedProfile("notes", profiles, { session: "notes", profile: "codex" })).toBe("personal");
  });

  test("with one profile there is no box, and the workspace decides", () => {
    expect(stagedProfile("[Personal] Notes", ["personal"])).toBeUndefined();
  });

  test("the folder list offers each folder an agent works in, once", () => {
    expect(knownFolders(sessions)).toEqual(["/Users/me/shop"]);
  });

  test("agents already in the chat are left out", () => {
    expect(pickerGroups(sessions, new Set(["@1", "@2"])).map((g) => g.session)).toEqual(["notes"]);
  });
});

describe("the cap field", () => {
  test("takes a whole number from 0, no cap, to 50; a blank is nothing, never no cap", () => {
    expect(["0", " 3 ", "50"].map(parseCap)).toEqual([0, 3, 50]);
    expect(["", "  ", "51", "2.5", "-1", "x"].map(parseCap)).toEqual([null, null, null, null, null, null]);
  });
});

describe("a member's terminal", () => {
  test("opens for an agent online, and for one still starting in the tab the chat opened for it", () => {
    const c = chat();
    const [joined] = c.members.filter((m) => m.kind === "claude");
    const pending = addMember(c, { kind: "claude", windowId: "@8", session: "shop", spawn: "pending" }, T);
    const stuck = addMember(c, { kind: "claude", windowId: "@9", session: "shop", spawn: "failed", spawnError: "nothing has started in its tab yet" }, T);
    const never = addMember(c, { kind: "codex", session: "shop", spawn: "failed", spawnError: "not a folder" }, T);
    expect(canOpen(joined!, { online: true })).toBe(true);
    expect(canOpen(joined!, { online: false })).toBe(false);
    expect(canOpen(pending, { online: false })).toBe(true);
    expect(canOpen(stuck, { online: false })).toBe(true);
    expect(canOpen(never, { online: false })).toBe(false);
    leave(c, joined!.handle, T);
    expect(canOpen(joined!, { online: true })).toBe(false);
  });
});

describe("adding to a chat", () => {
  const sessions: SessionInfo[] = [
    { name: "shop", id: "$1", attached: 0, windows: [{ id: "@1", index: 0, name: "claude", active: true, panes: 1, agent: { state: "done", since: T, profile: "work", checkout: "/Users/me/shop" } }] },
    { name: "api", id: "$2", attached: 0, windows: [{ id: "@2", index: 0, name: "codex", active: true, panes: 1, agent: { state: "done", since: T, profile: "codex", checkout: "/Users/me/api" } }] },
    { name: "notes", id: "$3", attached: 0, windows: [] },
  ];
  const twoAgents = () => {
    const c = newChat("c1", "shop review", T);
    addMember(c, { kind: "claude", windowId: "@1", session: "shop", folder: "/Users/me/shop", profile: "work" }, T);
    addMember(c, { kind: "codex", windowId: "@2", session: "shop", folder: "/Users/me/api" }, T);
    return c;
  };

  test("a new agent starts beside the agent you are talking to, in the workspace its tab is in now", () => {
    const c = twoAgents();
    post(c, "codex1", "@user which option?", T);
    expect(nearAgent(c, sessions)).toEqual({ session: "api", folder: "/Users/me/api" });
  });

  test("else beside the chat's first agent still in it, with its profile", () => {
    const c = twoAgents();
    expect(nearAgent(c, sessions)).toEqual({ session: "shop", folder: "/Users/me/shop", profile: "work" });
    leave(c, "claude1", T);
    expect(nearAgent(c, sessions)?.session).toBe("api");
    leave(c, "codex1", T);
    expect(nearAgent(c, sessions)).toBeNull();
  });

  test("Retry stages the same agent again, keeping its folder only when it was a path", () => {
    const c = twoAgents();
    const bad = addMember(c, { kind: "codex", session: "shop", folder: "Shop orders", spawn: "failed", spawnError: "no such folder: Shop orders", role: "reviewer" }, T);
    expect(retryStaged(bad, sessions, "notes")).toEqual({ kind: "codex", session: "shop", folder: "~", role: "reviewer" });
    const typo = addMember(c, { kind: "claude", session: "gone", folder: "~/github/shop-ordres", profile: "work", spawn: "failed" }, T);
    expect(retryStaged(typo, sessions, "notes")).toEqual({ kind: "claude", session: "notes", folder: "~/github/shop-ordres", profile: "work", role: "" });
  });

  test("Delete offers to shut down the agents running now, except those also in another open chat", () => {
    const c = twoAgents();
    addMember(c, { kind: "claude", windowId: "@3", session: "shop" }, T);
    addMember(c, { kind: "claude", windowId: "@4", session: "shop", spawn: "pending" }, T);
    addMember(c, { kind: "claude", windowId: "@5", session: "shop", spawn: "failed", spawnError: "nothing has started in its tab yet" }, T);
    const live = { claude1: { online: true }, codex1: { online: true }, claude2: { online: false }, claude3: { online: false }, claude4: { online: false } };
    const others = [summary({ id: "c2", windows: ["@2"] }), summary({ id: "c3", archived: true, windows: ["@1"] })];
    expect(shutdownList(c, [summary({ id: "c1", windows: ["@1", "@2", "@3"] }), ...others], live)).toEqual({ down: ["claude1", "claude3", "claude4"], kept: ["codex1"] });
  });
});
