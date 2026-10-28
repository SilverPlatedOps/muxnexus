import { describe, expect, test } from "bun:test";
import type { Chat } from "../src/shared/chat";
import type { ChatMemberLive } from "../src/shared/protocol";
import { activityLabel, workingMembers } from "../src/client/chat/activity";

const members: Chat["members"] = [
  { handle: "user", kind: "user", shape: "›", colour: -1, joinedAt: "" },
  { handle: "claude1", kind: "claude", shape: "◆", colour: 0, joinedAt: "" },
  { handle: "codex1", kind: "codex", shape: "▲", colour: 1, joinedAt: "" },
  { handle: "claude2", kind: "claude", shape: "■", colour: 2, joinedAt: "", left: true },
];
const running: ChatMemberLive = { state: "running", online: true };

describe("chat activity", () => {
  test("only active online members with a running session appear", () => {
    expect(workingMembers({ members }, { user: running, claude1: running, codex1: running, claude2: running, stranger: running })).toEqual(["claude1", "codex1"]);
    expect(workingMembers(null, { claude1: running })).toEqual([]);
  });

  test("waiting, done, offline, replaced and missing sessions don't look busy", () => {
    for (const state of ["input", "done", undefined] as const) {
      expect(workingMembers({ members }, { claude1: { state, online: true } })).toEqual([]);
    }
    expect(workingMembers({ members }, { claude1: { state: "running", online: false }, codex1: { state: "running", online: true, replaced: true } })).toEqual([]);
  });

  test("working changes stop immediately without using awaiting-message state", () => {
    const chat = { members: members.map((m) => ({ ...m, awaiting: 42 })) };
    expect(workingMembers(chat, { claude1: running })).toEqual(["claude1"]);
    expect(workingMembers(chat, { claude1: { online: true, state: "done" } })).toEqual([]);
  });

  test("labels name who is working without claiming to observe typing or reasoning", () => {
    expect(activityLabel([])).toBe("");
    expect(activityLabel(["codex1"])).toBe("codex1 is working");
    expect(activityLabel(["claude1", "codex1"])).toBe("claude1 and codex1 are working");
    expect(activityLabel(["claude1", "codex1", "claude2"])).toBe("claude1, codex1 and claude2 are working");
  });
});
