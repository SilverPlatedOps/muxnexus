import { describe, expect, test } from "bun:test";
import { FirstSeen, parseTurn, parseWait, resolveTiming } from "../src/server/timing";

describe("parseTurn / parseWait", () => {
  test("read what the hook writes", () => {
    expect(parseTurn("100")).toEqual({ start: 100 });
    expect(parseTurn(" 100 160 ")).toEqual({ start: 100, end: 160 });
    expect(parseWait("42")).toBe(42);
  });

  test("anything else is nothing", () => {
    for (const raw of ["", "x", "100 x", "1 2 3", "-5"]) expect(parseTurn(raw)).toBeNull();
    for (const raw of ["", "x", "1 2"]) expect(parseWait(raw)).toBeNull();
  });
});

describe("FirstSeen", () => {
  test("a turn starts at its first sight and runs through a wait", () => {
    const seen = new FirstSeen();
    expect(seen.observe("%1", "running", 100)).toEqual({ turn: 100 });
    expect(seen.observe("%1", "running", 130)).toEqual({ turn: 100 });
    expect(seen.observe("%1", "input", 140)).toEqual({ turn: 100, wait: 140 });
    expect(seen.observe("%1", "input", 150)).toEqual({ turn: 100, wait: 140 });
    expect(seen.observe("%1", "running", 160)).toEqual({ turn: 100 });
  });

  test("done ends the turn and remembers when", () => {
    const seen = new FirstSeen();
    seen.observe("%1", "running", 100);
    expect(seen.observe("%1", "done", 170)).toEqual({ lastDone: 170 });
    expect(seen.observe("%1", "running", 200)).toEqual({ turn: 200, lastDone: 170 });
  });

  test("a new tmux server forgets everything: pane ids are handed out again", () => {
    const seen = new FirstSeen();
    seen.forgetIfNew("1-1");
    seen.observe("%1", "running", 100);
    seen.forgetIfNew("1-1");
    expect(seen.observe("%1", "running", 120)).toEqual({ turn: 100 });
    seen.forgetIfNew("2-2");
    expect(seen.observe("%1", "running", 130)).toEqual({ turn: 130 });
  });

  test("panes no longer live are dropped", () => {
    const seen = new FirstSeen();
    seen.observe("%1", "running", 100);
    seen.keep(new Set(["%2"]));
    expect(seen.observe("%1", "running", 150)).toEqual({ turn: 150 });
  });
});

describe("resolveTiming", () => {
  test("a running turn the hook marked", () => {
    expect(resolveTiming("running", 150, { start: 100 }, null, { turn: 140 }))
      .toEqual({ turnStartedAt: 100, turnSource: "hook" });
  });

  test("a turn that already ended is the previous one: fall back to first sight", () => {
    expect(resolveTiming("running", 300, { start: 100, end: 160 }, null, { turn: 290 }))
      .toEqual({ turnStartedAt: 290, turnSource: "first-seen" });
  });

  test("an unended turn from before the last done is stale (an interrupted turn)", () => {
    expect(resolveTiming("running", 300, { start: 100 }, null, { turn: 290, lastDone: 200 }))
      .toEqual({ turnStartedAt: 290, turnSource: "first-seen" });
  });

  test("no mark and no sight: nothing is claimed", () => {
    expect(resolveTiming("running", 300, null, null, {})).toEqual({});
  });

  test("a wait the hook marked, inside the current turn", () => {
    expect(resolveTiming("input", 180, { start: 100 }, 170, { turn: 100, wait: 175 }))
      .toEqual({ turnStartedAt: 100, turnSource: "hook", waitingSince: 170, waitSource: "hook" });
  });

  test("a wait mark from before this turn is stale", () => {
    expect(resolveTiming("input", 180, { start: 100 }, 90, { turn: 100, wait: 175 }))
      .toEqual({ turnStartedAt: 100, turnSource: "hook", waitingSince: 175, waitSource: "first-seen" });
  });

  test("idle reports the last turn, with its end when the hook saw one", () => {
    expect(resolveTiming("done", 170, { start: 100, end: 160 }, 120, {}))
      .toEqual({ turnStartedAt: 100, turnEndedAt: 160, turnSource: "hook" });
    expect(resolveTiming("done", 170, { start: 100 }, null, {}))
      .toEqual({ turnStartedAt: 100, turnSource: "hook" });
    expect(resolveTiming("done", 170, null, null, {})).toEqual({});
  });
});
