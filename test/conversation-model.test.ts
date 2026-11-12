import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deviceView, setDeviceView, type Store } from "../src/client/display";
import { cardButtons, cardTitle, conversationWindow, mergeItems, stuckToBottom, withLocalActive, wordsOptional, workingLine } from "../src/client/conversation/model";
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
