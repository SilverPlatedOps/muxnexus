import { expect, test } from "bun:test";
import type { SessionInfo, WindowInfo } from "../src/shared/protocol";
import { findSessions, folderOf } from "../src/client/find";

const win = (id: string, name: string, checkout?: string): WindowInfo => ({
  id, index: 0, name, active: false, panes: 1,
  ...(checkout ? { agent: { state: "done", since: "", checkout } } : {}),
});
const sess = (name: string, windows: WindowInfo[]): SessionInfo => ({ name, id: `$${name}`, attached: 0, windows });

const all = [
  sess("[Work] Refactor", [win("@1", "/api/assets", "/Users/me/github/cms-backend"), win("@2", "Explore", "/Users/me/github")]),
  sess("[Work] cms-ui", [win("@3", "claude", "/Users/me/github/cms-ui")]),
  sess("Chores", [win("@4", "zsh")]),
];
const names = (q: string) => findSessions(all, q).map((h) => [h.session.name, h.windows.map((w) => w.id)]);

test("a window's folder is the last part of its checkout", () => {
  expect(folderOf(all[0].windows[0])).toBe("cms-backend");
  expect(folderOf(all[2].windows[0])).toBe("");
});

test("an empty search keeps everything, with no window rows", () => {
  expect(names("  ")).toEqual([["[Work] Refactor", []], ["[Work] cms-ui", []], ["Chores", []]]);
});

test("a session found by its own name brings no window rows", () => {
  expect(names("refactor")).toEqual([["[Work] Refactor", []]]);
  expect(names("CHORES")).toEqual([["Chores", []]]);
});

test("windows are found by their name or folder, and words may span session and window", () => {
  expect(names("cms")).toEqual([["[Work] Refactor", ["@1"]], ["[Work] cms-ui", ["@3"]]]);
  expect(names("refactor explore")).toEqual([["[Work] Refactor", ["@2"]]]);
  expect(names("assets")).toEqual([["[Work] Refactor", ["@1"]]]);
  expect(names("refactor voucher")).toEqual([]);
});
