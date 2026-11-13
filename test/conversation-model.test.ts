import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deviceView, setDeviceView, type Store } from "../src/client/display";
import {
  CARD_ARM_MS, cardArmedAt, cardButtons, cardTitle, clipAround, composedAs, conversationWindow, linkRows, mergeItems, readForShown, sendAs, stepLine, stuckToBottom, TERMINAL_MESSAGES,
  withLocalActive, wordsOptional, workingLine, writtenElsewhere,
} from "../src/client/conversation/model";
import { adapterFor } from "../src/server/conversation/adapter";
import type { AgentKind } from "../src/shared/chat";
import type { Card, ConvItem, StepResult } from "../src/shared/conversation";
import type { SessionInfo, WindowInfo } from "../src/shared/protocol";

const memory = (): Store => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

test("touch devices default to conversation, others to terminal, a choice wins", () => {
  const s = memory();
  expect(deviceView(s, 0)).toBe("terminal");
  expect(deviceView(s, 5)).toBe("conversation");
  setDeviceView("terminal", s);
  expect(deviceView(s, 5)).toBe("terminal");
  setDeviceView("conversation", s);
  expect(deviceView(s, 0)).toBe("conversation");
});

test("a store that throws falls back to the default", () => {
  const broken: Store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(deviceView(broken, 3)).toBe("conversation");
  expect(deviceView(broken, 0)).toBe("terminal");
  expect(() => setDeviceView("terminal", broken)).not.toThrow();
});

const win = (id: string, over: Partial<WindowInfo> = {}): WindowInfo => ({ id, index: 0, name: "sh", active: false, panes: 1, ...over });

test("the window shown is the asked one, else a waiting one, else tmux's active, else the first", () => {
  const ws = [win("@1"), win("@2", { active: true }), win("@3", { agent: { state: "input" } as WindowInfo["agent"] })];
  expect(conversationWindow(ws, "@1")).toBe("@1");
  expect(conversationWindow(ws, "@9")).toBe("@3");
  expect(conversationWindow(ws, null)).toBe("@3");
  expect(conversationWindow([win("@1"), win("@2", { active: true })], null)).toBe("@2");
  expect(conversationWindow([win("@1"), win("@2")], null)).toBe("@1");
  expect(conversationWindow([], null)).toBeNull();
});

test("a conversation page sends nothing that attaches, sizes or types into a terminal", () => {
  // The note's ⌘Enter pastes into the tab's prompt at the desk: in conversation mode it goes to the composer instead.
  expect([...TERMINAL_MESSAGES].sort()).toEqual(["attach", "attach-view", "paste-to-window", "resize", "scroll", "select-window"]);
});

test("withLocalActive marks only the chosen window of the chosen session active", () => {
  const sessions = [
    { name: "a", windows: [win("@1", { active: true }), win("@2")] },
    { name: "b", windows: [win("@3", { active: true })] },
  ] as SessionInfo[];
  const out = withLocalActive(sessions, "a", "@2");
  expect(out[0]!.windows.map((w) => w.active)).toEqual([false, true]);
  expect(out[1]).toBe(sessions[1]);
  expect(withLocalActive(sessions, null, null)).toBe(sessions);
});

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const you = (id: string, s = 0): ConvItem => ({ id, kind: "you", at: at(s), text: id });
const said = (id: string, s = 0): ConvItem => ({ id, kind: "agent", at: at(s), text: id });
const step = (id: string, summary = "Ran mvn -q test", s = 0): ConvItem => ({ id, kind: "step", at: at(s), tool: "Bash", summary, input: "{}" });
const result = (id: string, ok = true, output = "done", s = 1): StepResult => ({ id, kind: "step-result", ok, output, at: at(s) });
const ids = (list: ConvItem[]) => list.map((i) => i.id);
const resultOf = (list: ConvItem[], id: string) => {
  const it = list.find((i) => i.id === id);
  return it?.kind === "step" ? it.result : undefined;
};

test("merging appends, prepends, dedupes and applies a step's late result", () => {
  let list = mergeItems([], [you("u1"), step("s1")], "append");
  expect(ids(list)).toEqual(["u1", "s1"]);
  expect(resultOf(list, "s1")).toBeUndefined();

  // The result arrives with the next poll: the step shown takes it, nothing new is listed.
  const before = list;
  list = mergeItems(list, [result("s1", false, "1 test failed"), said("a1")], "append");
  expect(ids(list)).toEqual(["u1", "s1", "a1"]);
  expect(resultOf(list, "s1")).toEqual({ ok: false, output: "1 test failed", at: at(1) });
  expect(resultOf(before, "s1")).toBeUndefined();

  // An older page goes on top; what is already listed is not listed twice.
  list = mergeItems(list, [you("u0"), you("u1")], "prepend");
  expect(ids(list)).toEqual(["u0", "u1", "s1", "a1"]);
  list = mergeItems(list, [said("a1"), you("u2")], "append");
  expect(ids(list)).toEqual(["u0", "u1", "s1", "a1", "u2"]);

  // A result in the same batch as its step, and one for a step the older page brings.
  expect(resultOf(mergeItems([], [step("s2"), result("s2")], "append"), "s2")?.ok).toBe(true);
  const older = mergeItems([said("a9")], [step("s9"), result("s9", true, "ok")], "prepend");
  expect(ids(older)).toEqual(["s9", "a9"]);
  expect(resultOf(older, "s9")?.output).toBe("ok");
  // A result with no step to apply to is not an item.
  expect(ids(mergeItems([said("a1")], [result("gone")], "append"))).toEqual(["a1"]);
});

test("the working line names the step still running", () => {
  const items = [you("u1"), step("s0", "Ran ls"), said("a1"), step("s1", "Ran mvn -q test")];
  const done = mergeItems([], [...items.slice(0, 2), result("s0")], "append").concat(items.slice(2));
  expect(workingLine(done, T0 + 125_000)).toBe("Running mvn -q test · 2m");
  // Under a minute there is no time to give.
  expect(workingLine(done, T0 + 30_000)).toBe("Running mvn -q test");
  expect(workingLine([step("e1", "Edited Banner.java")], T0 + 60_000)).toBe("Editing Banner.java · 1m");
  // Once it has its result, nothing is running.
  expect(workingLine(mergeItems(done, [result("s1")], "append"), T0 + 125_000)).toBeNull();
  // A step that never got a result, with the agent writing after it, is not what runs now.
  expect(workingLine([step("old"), said("a2")], T0 + 125_000)).toBeNull();
  expect(workingLine([], T0)).toBeNull();
});

test("new items don't move a reader who scrolled up", () => {
  // scrollTop, scrollHeight, clientHeight
  expect(stuckToBottom(600, 1000, 400)).toBe(true);
  expect(stuckToBottom(560, 1000, 400)).toBe(true);
  expect(stuckToBottom(559, 1000, 400)).toBe(false);
  expect(stuckToBottom(0, 1000, 400)).toBe(false);
  // Less than a screenful is always at its end.
  expect(stuckToBottom(0, 300, 400)).toBe(true);
});

/** The card a real agent's pane reads as (Task 3's captures). */
const paneCard = (kind: AgentKind, name: string): Card => {
  const ansi = readFileSync(new URL(`./fixtures/conversation/pane-${kind}-${name}.ansi`, import.meta.url), "utf8");
  const card = adapterFor(kind).readPane(ansi).dialog;
  if (!card) throw new Error(`no card in pane-${kind}-${name}`);
  return card;
};
const indexes = (options: { index: number }[]) => options.map((o) => o.index);

test("don't-ask-again options are never the primary button", () => {
  // Bash: 2 always allows a folder, 3 switches to auto mode.
  const bash = cardButtons(paneCard("claude", "bash-permission"));
  expect(bash.primary[0]).toEqual({ index: 1, label: "Yes" });
  expect(indexes(bash.primary)).toEqual([1, 4]);
  expect(indexes(bash.secondary)).toEqual([2, 3]);
  // Codex: 2 stops asking for commands like this one.
  const codex = cardButtons(paneCard("codex", "approval"));
  expect(codex.primary[0]).toEqual({ index: 1, label: "Yes, proceed" });
  expect(indexes(codex.primary)).toEqual([1, 3]);
  expect(indexes(codex.secondary)).toEqual([2]);
  // A plan's first row switches to auto mode: the main button is the first row that doesn't.
  const plan = cardButtons(paneCard("claude", "plan"));
  expect(plan.primary[0]).toEqual({ index: 2, label: "Yes, manually approve edits" });
  expect(indexes(plan.secondary)).toEqual([1]);
  for (const b of [bash, codex, plan]) {
    expect(b.primary.some((o) => o.secondary)).toBe(false);
    expect(b.secondary.every((o) => o.secondary)).toBe(true);
  }
});

test("a card's title says what it asks in plain words", () => {
  expect(cardTitle(paneCard("claude", "bash-permission"))).toBe("Allow Bash command: touch probe.txt && sleep 20?");
  expect(cardTitle(paneCard("claude", "write-permission"))).toBe("Allow Create file: notes.txt?");
  // An Edit's first line is the file; the diff stays in the detail.
  expect(cardTitle(paneCard("claude", "edit-permission"))).toBe("Allow Edit file: notes.txt?");
  expect(cardTitle(paneCard("codex", "approval"))).toBe("Would you like to run the following command?");
  expect(cardTitle(paneCard("claude", "question"))).toBe("Pick a colour");
  const bash = paneCard("claude", "bash-permission");
  expect(cardTitle({ ...bash, detail: undefined })).toBe("Allow Bash command?");
  // A long command is cut in the title; the detail holds it whole.
  const long = cardTitle({ ...bash, detail: `echo ${"x".repeat(200)}\nls` });
  expect(long.length).toBeLessThan(110);
  expect(long).toEndWith("…?");
});

test("a No that takes words may go without them; a question's or plan's field may not", () => {
  // The permission's No and Codex's decline say No outright; the others are no answer blank (the server's keysFor).
  expect(wordsOptional(paneCard("claude", "bash-permission"))).toBe(true);
  expect(wordsOptional(paneCard("codex", "approval"))).toBe(true);
  expect(wordsOptional(paneCard("claude", "plan"))).toBe(false);
  expect(wordsOptional(paneCard("claude", "question"))).toBe(false);
});

test("a dialog not shown before takes taps only after a moment", () => {
  // Q1 answered and Q2 drawn in its place, its options where Q1's were: a second tap meant for Q1 must not answer Q2.
  const q1 = cardArmedAt(null, "q1", T0);
  expect(q1).toBe(T0 + CARD_ARM_MS);
  const q2 = cardArmedAt({ fingerprint: "q1", at: q1 }, "q2", T0 + 1000);
  expect(q2).toBe(T0 + 1000 + CARD_ARM_MS);
  expect(T0 + 1000 + 150 < q2).toBe(true);
  // The same dialog again (its highlight moved, the agent's state changed) keeps the time it had.
  expect(cardArmedAt({ fingerprint: "q2", at: q2 }, "q2", T0 + 1100)).toBe(q2);
  expect(CARD_ARM_MS).toBeGreaterThanOrEqual(300);
});

test("PR links read as owner/repo#number", () => {
  const rows = linkRows([
    { url: "https://github.com/o/r/pull/12", pr: true },
    { url: "https://github.com/o/r/pull/12/files#diff", pr: true },
    { url: "https://gitlab.example.com/g/p/-/merge_requests/3", pr: true },
    { url: "https://example.com/", pr: false },
    { url: "https://docs.example.com/a/very/long/path/that/keeps/going/and/going/forever/index.html?q=1", pr: false },
    { url: "not a url", pr: false },
  ]);
  expect(rows[0]).toEqual({ url: "https://github.com/o/r/pull/12", label: "o/r#12", pr: true });
  expect(rows[1]!.label).toBe("o/r#12");
  expect(rows[2]!.label).toBe("gitlab.example.com/g/p/-/merge_requests/3");
  expect(rows[3]!.label).toBe("example.com");
  expect(rows[4]!.label.length).toBe(48);
  expect(rows[4]!.label.endsWith("…")).toBe(true);
  expect(rows[5]!.label).toBe("not a url");
});

test("a step that failed or was denied reads as what was tried, not as done", () => {
  const step = (summary: string, ok?: boolean): Extract<ConvItem, { kind: "step" }> => ({
    id: "s", kind: "step", at: "2026-01-01T10:00:00.000Z", tool: "Write", summary, input: "",
    ...(ok === undefined ? {} : { result: { ok, output: "", at: "2026-01-01T10:00:01.000Z" } }),
  });
  expect(stepLine(step("Wrote note.txt", false))).toBe("Write note.txt");
  expect(stepLine(step("Ran mvn -q test", false))).toBe("Run mvn -q test");
  expect(stepLine(step("Edited a.ts", false))).toBe("Edit a.ts");
  expect(stepLine(step("Searched foo", false))).toBe("Search foo");
  expect(stepLine(step("WebFetch", false))).toBe("WebFetch");
  // Done, or not done yet: as the server words it.
  expect(stepLine(step("Wrote note.txt", true))).toBe("Wrote note.txt");
  expect(stepLine(step("Wrote note.txt"))).toBe("Wrote note.txt");
});

test("the text box's words are bound to the conversation they were begun for", () => {
  const none = { text: "", for: null };
  // Begun (empty to some text) while A shows: for A.
  const a = composedAs(none, "fix the", "A");
  expect(a).toEqual({ text: "fix the", for: "A" });
  // More words, even once B shows (a /clear at the desk): still for A.
  expect(composedAs(a, "fix the tests", "B")).toEqual({ text: "fix the tests", for: "A" });
  // Emptied: for nothing, and the next words are for whatever shows then.
  const emptied = composedAs(a, "  ", "B");
  expect(emptied).toEqual({ text: "  ", for: null });
  expect(composedAs(emptied, "new", "B")).toEqual({ text: "new", for: "B" });
});

test("Send goes to the conversation the words were written for, and asks first when the tab now holds another", () => {
  const forA = { text: "fix the tests", for: "A" };
  expect(sendAs(forA, "A")).toEqual({ send: "A" });
  expect(writtenElsewhere(forA, "A")).toBe(false);
  // B in the tab now: ask, and only a yes rebinds (the caller sends with { ...c, for: "B" }).
  expect(sendAs(forA, "B")).toEqual({ ask: true });
  expect(writtenElsewhere(forA, "B")).toBe(true);
  expect(sendAs({ ...forA, for: "B" }, "B")).toEqual({ send: "B" });
  // Words with no conversation to them are asked about too; nothing to send, or nothing to send to, is no send.
  expect(sendAs({ text: "x", for: null }, "B")).toEqual({ ask: true });
  expect(sendAs({ text: " ", for: "A" }, "A")).toBeNull();
  expect(sendAs(forA, null)).toBeNull();
  // While the tab's conversation isn't known yet (opening), the words aren't said to be for another.
  expect(writtenElsewhere(forA, null)).toBe(false);
  expect(writtenElsewhere({ text: "", for: "A" }, "B")).toBe(false);
});

test("a page, search or links answer counts only for the tab and conversation shown now", () => {
  const shown = { windowId: "@1", conversation: "A" };
  expect(readForShown({ windowId: "@1", conversation: "A" }, shown)).toBe(true);
  // Read before a /clear (the tab holds B now), or for the tab shown before: dropped.
  expect(readForShown({ windowId: "@1", conversation: "A" }, { windowId: "@1", conversation: "B" })).toBe(false);
  expect(readForShown({ windowId: "@2", conversation: "A" }, shown)).toBe(false);
  expect(readForShown({ windowId: "@1", conversation: null }, shown)).toBe(false);
  // A tab with no conversation yet: an answer read for none is its own.
  expect(readForShown({ windowId: "@1", conversation: null }, { windowId: "@1", conversation: null })).toBe(true);
});

test("a step's text is cut to the clip, or, for a search match past it, to a window around the match", () => {
  const long = `${"a".repeat(5000)}NEEDLE${"b".repeat(5000)}`;
  // Short, or the match inside the clip: from the start, as always, the match where it is.
  expect(clipAround("short needle text", 4000, "needle")).toEqual({ text: "short needle text", at: 6 });
  expect(clipAround(`x needle ${"c".repeat(5000)}`, 4000, "NEEDLE")).toEqual({ text: `x needle ${"c".repeat(3991)}\n… 1009 more characters`, at: 2 });
  // No query, or none found: the clip from the start.
  expect(clipAround(long, 4000)).toEqual({ text: `${"a".repeat(4000)}\n… 6006 more characters` });
  expect(clipAround(long, 4000, "missing")).toEqual({ text: `${"a".repeat(4000)}\n… 6006 more characters` });
  // Past the clip: a window of the clip's length around the match, each cut end marked.
  const w = clipAround(long, 4000, "needle");
  expect(w.text.startsWith("… 3003 characters before\n")).toBe(true);
  expect(w.text.endsWith("\n… 3003 more characters")).toBe(true);
  expect(w.text.slice(w.at!, w.at! + 6)).toBe("NEEDLE");
  expect(w.text.length - "… 3003 characters before\n".length - "\n… 3003 more characters".length).toBe(4000);
  // Near the end: the window ends with the text, unmarked there.
  const tail = clipAround(`${"a".repeat(9000)}NEEDLE`, 4000, "needle");
  expect(tail.text).toBe(`… 5006 characters before\n${"a".repeat(3994)}NEEDLE`);
  expect(tail.text.slice(tail.at!, tail.at! + 6)).toBe("NEEDLE");
});
