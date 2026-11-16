import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterFor } from "../src/server/conversation/adapter";
import { afterStop, answer, draftFingerprint, pressKey, screenNow, sendText, stop, stoppedSince } from "../src/server/conversation/actions";
import type { WindowAgentInfo } from "../src/server/tmux";

// Every write from the phone goes through one guard: right before it, the tab is looked up again and the pane read,
// and the write goes only to the same pane, in the same conversation, in the input state it expects.

const raw = (name: string) => readFileSync(new URL(`./fixtures/conversation/pane-${name}.ansi`, import.meta.url), "utf8");

const dir = mkdtempSync(join(tmpdir(), "conv-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// A conversation with no interrupt in it: a `running` stamp over it is believed.
const TRANSCRIPT = join(dir, "turns.jsonl");
writeFileSync(TRANSCRIPT, JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-13T10:00:00.500Z", message: { role: "user", content: "count to fifty" } }) + "\n");
const SINCE = Date.parse("2026-11-13T10:00:00Z") / 1000;

const claude: WindowAgentInfo = { paneId: "%1", kind: "claude", state: "done", conversation: { sessionId: "sess-A", transcriptPath: TRANSCRIPT } };
const codex: WindowAgentInfo = { paneId: "%2", kind: "codex", state: "done", thread: { id: "thread-A", path: TRANSCRIPT } };

/**
 * The same tab, changed: another conversation in the same pane (`/clear`, a resume), the agent in another pane, a
 * desk edit, or the same conversation's turn moved on (`stamp`: a new turn begun, or the one going ended).
 */
type Change = "conversation" | "pane" | "desk" | "stamp";
function changed(agent: WindowAgentInfo, how: Change, stamp?: Pick<WindowAgentInfo, "state" | "since">): WindowAgentInfo {
  if (how === "pane") return { ...agent, paneId: "%7" };
  if (how === "stamp") return { ...agent, ...stamp };
  if (how === "conversation") {
    return agent.kind === "claude"
      ? { ...agent, conversation: { sessionId: "sess-B", transcriptPath: TRANSCRIPT } }
      : { ...agent, thread: { id: "thread-B", path: TRANSCRIPT } };
  }
  return agent;
}

/**
 * A tab that behaves like one: the agent and its screen are state. Each write moves the screen on, as the agent
 * would redraw it (`screens`, in turn), and `change` alters the tab for good as call `at` begins (every tmux call
 * counts), or once `afterWrite` writes have landed: the conversation or pane behind the window, or the screen
 * (`foreign`, drawn at the desk).
 */
function liveTab(
  agent: WindowAgentInfo, screens: string[],
  change?: { at?: number; afterWrite?: number; how: Change; foreign?: string; stamp?: Pick<WindowAgentInfo, "state" | "since"> },
) {
  let me = agent;
  let screen = screens[0]!;
  let step = 1;
  let n = 0;
  let done = false;
  let written = 0;
  const calls: { at: number; name: string; args: unknown[] }[] = [];
  const apply = () => {
    done = true;
    me = changed(me, change!.how, change!.stamp);
    if (change!.how === "desk") screen = change!.foreign!;
  };
  const begin = (name: string, ...args: unknown[]) => {
    if (change && n === change.at && !done) apply();
    calls.push({ at: n++, name, args });
  };
  const moveOn = () => {
    if (!done) screen = screens[step++] ?? screen;
    if (change && ++written === change.afterWrite && !done) apply();
  };
  return {
    calls,
    writes: () => calls.filter((c) => c.name === "pasteInto" || c.name === "sendKeys"),
    async agentOfWindow(windowId: string) { begin("agentOfWindow", windowId); return me; },
    async activePane(windowId: string) { begin("activePane", windowId); return me.paneId; },
    async capturePane(paneId: string) { begin("capturePane", paneId); return screen; },
    async snapshot(windowId: string, paneId: string) { begin("snapshot", windowId, paneId); return { agent: me, active: me.paneId, ansi: screen }; },
    async paneSize(paneId: string) { begin("paneSize", paneId); return { cols: 120, rows: 40 }; },
    async pasteInto(paneId: string, text: string) { begin("pasteInto", paneId, text); moveOn(); },
    async sendKeys(paneId: string, keys: string[]) { begin("sendKeys", paneId, keys); moveOn(); },
  };
}
type Tab = ReturnType<typeof liveTab>;

let windows = 100;
/** A window id never used before: Stop and Replace keep a per-window memory of their last key. */
const fresh = () => `@${++windows}`;

/** The words `claude-bash-no-text`'s field holds. */
const NOTE = "instead of touching the file, list the directory with ls -la and then tell me how many entries it has, and also say why\nsecond line of the note";

/** The desk's own words in the prompt, not the phone's. */
const DESK = {
  claude: raw("claude-idle-draft").replace("hello draft", "from the desk"),
  codex: raw("codex-idle-draft").replace("hello draft", "from the desk"),
};

const shown = (kind: "claude" | "codex", name: string) => draftFingerprint(adapterFor(kind).readPane(raw(name)));
const card = (kind: "claude" | "codex", name: string) => adapterFor(kind).readPane(raw(name)).dialog!.fingerprint;

interface Action {
  name: string;
  agent: WindowAgentInfo;
  /** The screen first, then the screen after each write. */
  screens: string[];
  /** Screens drawn at the desk that no write may follow: a dialog, or the desk's own words in the prompt. */
  foreign: string[];
  run(tab: Tab): Promise<{ ok: boolean }>;
}

const ACTIONS: Action[] = [
  {
    name: "send",
    agent: claude,
    screens: [raw("claude-idle-empty"), raw("claude-idle-draft"), raw("claude-idle-empty")],
    foreign: [raw("claude-bash-permission"), DESK.claude],
    run: (tab) => sendText(tab, fresh(), "sess-A", "hello draft", null),
  },
  {
    name: "send to Codex",
    agent: codex,
    screens: [raw("codex-idle-empty"), raw("codex-idle-draft"), raw("codex-idle-empty")],
    foreign: [raw("codex-approval"), DESK.codex],
    run: (tab) => sendText(tab, fresh(), "thread-A", "hello draft", null),
  },
  {
    name: "send, replacing the desk's draft",
    agent: claude,
    screens: [raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), raw("claude-idle-draft"), raw("claude-idle-empty")],
    foreign: [raw("claude-bash-permission"), DESK.claude],
    run: (tab) => sendText(tab, fresh(), "sess-A", "hello draft", shown("claude", "claude-idle-multiline-draft")),
  },
  {
    name: "answer by key",
    agent: claude,
    screens: [raw("claude-bash-permission"), raw("claude-working")],
    foreign: [raw("claude-write-permission"), DESK.claude],
    run: (tab) => answer(tab, fresh(), "sess-A", card("claude", "claude-bash-permission"), 1),
  },
  {
    name: "answer with words",
    agent: claude,
    screens: [raw("claude-bash-no-card"), raw("claude-bash-no-field"), raw("claude-bash-no-text"), raw("claude-working")],
    // Another dialog, the prompt back with the desk's words, or the desk's own note in the field.
    foreign: [raw("claude-write-permission"), DESK.claude, raw("claude-bash-no-text").replace("instead of touching", "rather than touching")],
    run: (tab) => answer(tab, fresh(), "sess-A", card("claude", "claude-bash-no-card"), 4, NOTE),
  },
  {
    name: "a Codex decline, then the words as the next message",
    agent: codex,
    screens: [raw("codex-approval"), raw("codex-idle-empty"), raw("codex-idle-draft"), raw("codex-working")],
    // Another approval, for another command.
    foreign: [raw("codex-approval").replaceAll("probe2.txt", "other.txt"), DESK.codex],
    run: (tab) => answer(tab, fresh(), "thread-A", card("codex", "codex-approval"), 3, "hello draft"),
  },
  {
    name: "stop",
    agent: { ...claude, state: "running", since: SINCE },
    screens: [raw("claude-working"), raw("claude-idle-empty")],
    foreign: [raw("claude-bash-permission")],
    run: async (tab) => {
      const r = await stop(tab, fresh(), "sess-A");
      // Stop is ok with nothing to stop: only an Escape sent counts as the happy path's.
      return { ok: r.ok && tab.writes().length > 0 };
    },
  },
  {
    name: "a Screen key",
    agent: claude,
    screens: [raw("claude-bash-permission-tip"), raw("claude-working")],
    foreign: [raw("claude-idle-empty")],
    run: async (tab) => {
      const windowId = fresh();
      const seen = await screenNow(liveTab(claude, [raw("claude-bash-permission-tip")]), windowId);
      const r = await pressKey(tab, windowId, seen.token, "1");
      return { ok: !r.error };
    },
  },
];

describe("every write is guarded", () => {
  for (const action of ACTIONS) {
    test(`${action.name}: a change before any boundary, and nothing is written after it`, async () => {
      const happy = liveTab(action.agent, action.screens);
      expect(await action.run(happy)).toMatchObject({ ok: true });
      const writes = happy.writes();
      expect(writes.length).toBeGreaterThan(0);
      // Each look before a write is a boundary a change can come at. (A change while the write itself is on its way
      // is the round trip no read can close: the write is the next thing tmux does.)
      const reads = happy.calls.filter((c) => c.at < writes.at(-1)!.at && c.name !== "pasteInto" && c.name !== "sendKeys").map((c) => c.at);
      expect(reads.length).toBeGreaterThan(0);
      const late: string[] = [];
      const changes: { how: Change; foreign?: string }[] = [{ how: "conversation" }, { how: "pane" }, ...action.foreign.map((foreign) => ({ how: "desk" as const, foreign }))];
      for (const [k, { how, foreign }] of changes.entries()) {
        // The first look-up is where the action learns its pane: a pane changed before it is the one it is for.
        const boundaries = how === "pane" ? reads.filter((at) => at > 0) : reads;
        await Promise.all(boundaries.map(async (at) => {
          const tab = liveTab(action.agent, action.screens, { at, how, foreign });
          const r = await action.run(tab);
          const after = tab.writes().filter((w) => w.at > at);
          if (r.ok || after.length > 0) late.push(`${how}${how === "desk" ? ` ${k - 2}` : ""} before call ${at} (${happy.calls[at]!.name}): ${r.ok ? "ok, " : ""}${JSON.stringify(after.map((w) => [w.name, w.args[1]]))}`);
        }));
      }
      expect(late).toEqual([]);
    }, 30_000);
  }
});

// Codex reproduced both on 0edbcf7: the words went into conversation B, and the call said `unsent` only afterwards.
describe("a conversation changed while an action waits gets none of its words", () => {
  test("Replace: the tab is cleared at the desk while the clear is waited on", async () => {
    const tab = liveTab(claude, [raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), raw("claude-idle-draft")], { afterWrite: 1, how: "conversation" });
    expect(await sendText(tab, fresh(), "sess-A", "hello draft", shown("claude", "claude-idle-multiline-draft"))).toEqual({ ok: false, error: "another-conversation" });
    // The clear, and nothing after it.
    expect(tab.writes().map((w) => w.args[1])).toEqual([["C-c"]]);
  });

  test("a card's words: the conversation changes once the keys that open its field are in", async () => {
    const tab = liveTab(claude, [raw("claude-bash-no-card"), raw("claude-bash-no-field"), raw("claude-bash-no-text")], { afterWrite: 1, how: "conversation" });
    expect(await answer(tab, fresh(), "sess-A", card("claude", "claude-bash-no-card"), 4, "instead list the directory")).toEqual({ ok: false, error: "another-conversation" });
    expect(tab.writes().map((w) => w.args[1])).toEqual([["Down", "Down", "Down", "Tab"]]);
  });

  test("Replace reads the pane again after the transcript, right before the clear", async () => {
    // The draft changes at the desk while the transcript is read: the clear doesn't go.
    const tab = liveTab(claude, [raw("claude-idle-multiline-draft")], { at: 2, how: "desk", foreign: raw("claude-idle-draft") });
    expect(await sendText(tab, fresh(), "sess-A", "hello draft", shown("claude", "claude-idle-multiline-draft"))).toEqual({ ok: false, error: "prompt-changed" });
    expect(tab.writes()).toEqual([]);
  });
});

// Codex reproduced both on 828c26c: the decision was taken on the stamp read before the snapshot the write went on.
describe("a write that depends on the turn goes by the turn the snapshot shows", () => {
  /** Every look before the action's last write: a boundary a change can come at. */
  const boundaries = (happy: Tab) => {
    const last = happy.writes().at(-1)!.at;
    return happy.calls.filter((c) => c.at < last && c.name !== "pasteInto" && c.name !== "sendKeys").map((c) => c.at);
  };

  test("Replace: a new turn begun at any boundary before the clear, and no C-c goes", async () => {
    const run = (tab: Tab) => sendText(tab, fresh(), "sess-A", "hello draft", shown("claude", "claude-idle-multiline-draft"));
    const screens = [raw("claude-idle-multiline-draft"), raw("claude-idle-empty"), raw("claude-idle-draft"), raw("claude-idle-empty")];
    const happy = liveTab({ ...claude, since: SINCE }, screens);
    expect(await run(happy)).toEqual({ ok: true });
    const clearAt = happy.writes()[0]!.at;
    const late: number[] = [];
    for (const at of boundaries(happy).filter((at) => at < clearAt)) {
      const tab = liveTab({ ...claude, since: SINCE }, screens, { at, how: "stamp", stamp: { state: "running", since: SINCE + 5 } });
      await run(tab);
      if (tab.writes().some((w) => JSON.stringify(w.args[1]) === JSON.stringify(["C-c"]))) late.push(at);
    }
    expect(late).toEqual([]);
  });

  test("Stop: the turn ended at any boundary before the Escape, and no Escape goes to the idle prompt", async () => {
    // Nothing on the pane says Claude works (text streaming under an empty prompt shows nothing): the stamp decides.
    const agent: WindowAgentInfo = { ...claude, state: "running", since: SINCE };
    const screens = [raw("claude-idle-empty")];
    const happy = liveTab(agent, screens);
    expect(await stop(happy, fresh(), "sess-A")).toEqual({ ok: true });
    expect(happy.writes().map((w) => w.args[1])).toEqual([["Escape"]]);
    const late: number[] = [];
    for (const at of boundaries(happy)) {
      const tab = liveTab(agent, screens, { at, how: "stamp", stamp: { state: "done", since: SINCE + 5 } });
      await stop(tab, fresh(), "sess-A");
      if (tab.writes().length > 0) late.push(at);
    }
    expect(late).toEqual([]);
  });
});

describe("a Stop is matched to the turn it ended, not to the second it was sent in", () => {
  test("a Stop in the stamp's own second still ends that turn, and a later stamp is a new turn", async () => {
    const agent: WindowAgentInfo = { ...claude, state: "running", since: Math.floor(Date.now() / 1000) };
    const windowId = fresh();
    const tab = liveTab(agent, [raw("claude-idle-empty")]);
    expect(await stop(tab, windowId, "sess-A")).toEqual({ ok: true });
    expect(tab.writes().map((w) => w.args[1])).toEqual([["Escape"]]);
    const idle = adapterFor("claude").readPane(raw("claude-idle-empty"));
    // That turn is over: the Working line clears, and no later Stop sends a second Escape into the idle prompt.
    expect(stoppedSince(windowId, agent)).toBe(true);
    expect(afterStop(windowId, agent, "running", idle)).toBe("done");
    // The next prompt's stamp is another turn, whatever second it lands in.
    expect(stoppedSince(windowId, { ...agent, since: agent.since! + 1 })).toBe(false);
  });
});

describe("Stop with no conversation is for a Codex that hasn't begun one", () => {
  test("a fresh Codex can be stopped; a daemon Codex, whose conversation is unknown, can't be by a null", async () => {
    const screens = [raw("codex-working"), raw("codex-idle-empty")];
    const freshTab = liveTab({ paneId: "%2", kind: "codex", fresh: true, state: "running", since: SINCE }, screens);
    expect(await stop(freshTab, fresh(), null)).toEqual({ ok: true });
    const daemon = liveTab({ paneId: "%2", kind: "codex", daemon: true }, screens);
    expect(await stop(daemon, fresh(), null)).toEqual({ ok: false, error: "another-conversation" });
    expect(daemon.writes()).toEqual([]);
  });
});

describe("the guard is the only way in", () => {
  test("no pasteInto or sendKeys in src/server/conversation/ but the guard's", () => {
    const root = new URL("../src/server/conversation/", import.meta.url);
    const sites: string[] = [];
    for (const file of readdirSync(root)) {
      const text = readFileSync(new URL(file, root), "utf8");
      const guard = /\nasync function guarded\b[\s\S]*?\n}\n/.exec(text);
      for (const m of text.matchAll(/\.(pasteInto|sendKeys)\(/g)) {
        const inGuard = !!guard && m.index! > guard.index && m.index! < guard.index + guard[0].length;
        if (!inGuard) sites.push(`${file}:${text.slice(0, m.index).split("\n").length} ${m[1]}`);
      }
    }
    expect(sites).toEqual([]);
  });
});
