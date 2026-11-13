import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationHub } from "../src/server/conversation/hub";
import { createServer, type RunningServer } from "../src/server/server";
import { Tmux, type WindowAgentInfo } from "../src/server/tmux";
import type { ServerMessage } from "../src/shared/protocol";
import { sleep, waitFor } from "./helpers";

// Pane captures from real agents on a scratch tmux (Task 3's fixtures).
const fixture = (name: string) => new URL(`./fixtures/conversation/${name}`, import.meta.url);
const pane = (name: string) => readFileSync(fixture(`pane-${name}.ansi`), "utf8");

const dir = mkdtempSync(join(tmpdir(), "conv-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let copies = 0;
/** A copy of a fixture transcript, free to append to. */
function transcript(name = "claude-turns.jsonl"): string {
  const path = join(dir, `${++copies}-${name}`);
  copyFileSync(fixture(name), path);
  return path;
}

/** A Claude transcript waiting on one AskUserQuestion call. */
function asking(multiSelect: boolean): string {
  const path = join(dir, `${++copies}-asking.jsonl`);
  const q = (question: string, multi: boolean) => ({ question, header: "Pick", multiSelect: multi, options: [{ label: "a" }, { label: "b" }] });
  const rows = [
    { type: "user", uuid: "u1", timestamp: "2026-11-13T10:00:00.000Z", message: { role: "user", content: "Ask me two things" } },
    { type: "assistant", uuid: "a1", timestamp: "2026-11-13T10:00:01.000Z", message: { content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input: { questions: [q("Pick a colour", false), q("Pick fruits", multiSelect)] } }] } },
  ];
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

const reply = (uuid: string, text: string) =>
  JSON.stringify({ type: "assistant", uuid, timestamp: "2026-11-13T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

type Msg = ServerMessage;
type Of<T extends Msg["t"]> = Extract<Msg, { t: T }>;
const all = <T extends Msg["t"]>(msgs: Msg[], t: T) => msgs.filter((m) => m.t === t) as Of<T>[];

/** A socket as the hub sees one, keeping what it was sent. */
function socket() {
  const sent: Msg[] = [];
  return {
    sent,
    readyState: 1,
    sendText(s: string) { sent.push(JSON.parse(s)); },
    all<T extends Msg["t"]>(t: T) { return all(sent, t); },
    last<T extends Msg["t"]>(t: T) { return all(sent, t).at(-1); },
  };
}

/** A tmux holding one agent tab (pane %1) whose stamp and screen the test sets. */
function fakeTmux(agent: Partial<WindowAgentInfo> | null, screen: string) {
  /**
   * `pasted`, `entered`: the screen after a paste (a prompt holding "hello draft", which then reads as the words
   * pasted) and after Enter (the prompt empty again), when set.
   */
  const state = { agent, screen, captures: 0, lookups: 0, writes: [] as string[], slowPaste: 0, pasted: null as string | null, entered: null as string | null };
  const tmux = {
    async agentOfWindow(_windowId: string) {
      state.lookups++;
      return state.agent ? ({ paneId: "%1", kind: "claude", ...state.agent } as WindowAgentInfo) : null;
    },
    async activePane(_windowId: string) { return "%1"; },
    async capturePane(_paneId: string) { state.captures++; return state.screen; },
    async snapshot(windowId: string, paneId: string) { return { agent: await tmux.agentOfWindow(windowId), active: "%1", ansi: await tmux.capturePane(paneId) }; },
    async pasteInto(paneId: string, text: string) {
      state.writes.push(`paste ${paneId} ${text}`);
      await sleep(state.slowPaste);
      if (state.pasted !== null) state.screen = state.pasted.replace("hello draft", text);
    },
    async sendKeys(paneId: string, keys: string[]) {
      state.writes.push(`keys ${paneId} ${keys.join(" ")}`);
      if (state.entered !== null && keys.join(" ") === "Enter") state.screen = state.entered;
    },
    async paneSize(_paneId: string) { return { cols: 80, rows: 24 }; },
  };
  return { state, tmux };
}

const claude = (path: string, state: "input" | "running" | "done" = "input", sessionId = "sess-1"): Partial<WindowAgentInfo> =>
  ({ kind: "claude", state, conversation: { sessionId, transcriptPath: path } });

describe("the conversation hub", () => {
  test("a waiting tab gets a card, an unreadable wait gets screen:true", async () => {
    const { state, tmux } = fakeTmux(claude(transcript()), pane("claude-bash-permission"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      const card = ws.last("conv-card")!;
      expect(card).toMatchObject({ windowId: "@1", screen: false, working: false });
      expect(card.card?.kind).toBe("permission");

      /** The next `conv-card` after the pane changes to `screen`: what it offers. */
      const shows = async (screen: string, label: string) => {
        const n = ws.all("conv-card").length;
        state.screen = pane(screen);
        const next = await waitFor(() => ws.all("conv-card")[n], 1000, `a card for ${screen}`);
        expect(next.card?.kind ?? (next.screen ? "screen" : "none")).toBe(label);
        return next;
      };
      // A dialog no layout matches; a field taking words: Screen, no card.
      expect((await shows("claude-trust", "screen")).card).toBeNull();
      await shows("claude-bash-permission", "permission");
      await shows("claude-bash-no-field", "screen");
      await shows("claude-plan", "plan");
      // A waiting stamp over the plain prompt box is stale (an interrupted turn fires no hook): the text box, not Screen.
      expect(await shows("claude-idle-empty", "none")).toMatchObject({ card: null, screen: false, working: false });
      // Waiting, by the stamp, over an agent at work (an answer the hook hasn't caught up with): no Screen, Stop instead.
      expect(await shows("claude-working", "none")).toMatchObject({ card: null, screen: false, working: true });
      await shows("codex-approval", "screen"); // a Codex dialog on a Claude tab is nothing Claude's reader knows
    } finally {
      hub.stop();
    }
  });

  test("a waiting stamp over a readable idle prompt shows the text box, not Screen", async () => {
    // Esc or a plain No ends the turn with no hook, so the stamp stays "input" over the prompt box.
    for (const [agent, fixture, expected] of [
      [claude(transcript()), "claude-idle-empty", { card: null, screen: false, working: false }],
      [claude(transcript()), "claude-idle-draft", { card: null, screen: false, working: false }],
      [{ kind: "codex", state: "input", thread: { id: "thread-1", path: transcript("codex-turns.jsonl") } }, "codex-idle-empty", { card: null, screen: false, working: false }],
      // A dialog is still a card, and a screen no reader knows still Screen.
      [claude(transcript()), "claude-bash-permission", { screen: false, card: expect.objectContaining({ kind: "permission" }) }],
      [claude(transcript()), "claude-trust", { card: null, screen: true }],
      [claude(transcript()), "claude-question-multi", { card: null, screen: true }],
    ] as const) {
      const { tmux } = fakeTmux(agent as Partial<WindowAgentInfo>, pane(fixture));
      const hub = createConversationHub({ tmux, pollMs: 1000 });
      const ws = socket();
      try {
        await hub.open(ws, "@1");
        expect({ fixture, ...ws.last("conv-card") }).toMatchObject({ fixture, ...expected });
      } finally {
        hub.stop();
      }
    }
  });

  test("a Codex tab stamped waiting over its working or idle composer shows no Screen", async () => {
    const { state, tmux } = fakeTmux({ kind: "codex", state: "input", thread: { id: "thread-1", path: transcript("codex-turns.jsonl") } }, pane("codex-working"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      expect(ws.last("conv-card")).toEqual({ t: "conv-card", windowId: "@1", card: null, screen: false, working: true });
      state.screen = pane("codex-idle-empty");
      await waitFor(() => ws.all("conv-card").length === 2, 1000, "the idle composer");
      expect(ws.last("conv-card")).toMatchObject({ card: null, screen: false, working: false });
      state.screen = pane("codex-approval");
      await waitFor(() => ws.all("conv-card").length === 3, 1000, "the approval");
      expect(ws.last("conv-card")!.card?.kind).toBe("approval");
    } finally {
      hub.stop();
    }
  });

  test("a question with a multi-select part shows Screen, a single-select one a card", async () => {
    for (const [multi, want] of [[true, "screen"], [false, "question"]] as const) {
      const { tmux } = fakeTmux(claude(asking(multi)), pane("claude-question"));
      const hub = createConversationHub({ tmux, pollMs: 30 });
      const ws = socket();
      try {
        await hub.open(ws, "@1");
        const c = ws.last("conv-card")!;
        expect(c.card?.kind ?? (c.screen ? "screen" : "none")).toBe(want);
      } finally {
        hub.stop();
      }
    }
  });

  test("an interrupt fires no hook: the transcript says the turn is over, so no working line, no Stop, no card", async () => {
    // The fixture transcripts end with an interrupt (Claude's line, Codex's turn_aborted) on 2026-01-01; the stamps are older.
    const since = Date.parse("2026-01-01T09:00:00Z") / 1000;
    for (const [agent, fixture] of [
      [{ ...claude(transcript(), "running"), since }, "claude-idle-draft"],
      // Esc on a permission prompt: the stamp stays `input`, and the pane would still read as the prompt for a moment.
      [{ ...claude(transcript(), "input"), since }, "claude-bash-permission"],
      [{ kind: "codex", state: "running", since, thread: { id: "thread-1", path: transcript("codex-turns.jsonl") } }, "codex-idle-empty"],
    ] as const) {
      const { state, tmux } = fakeTmux(agent as Partial<WindowAgentInfo>, pane(fixture));
      const hub = createConversationHub({ tmux, pollMs: 1000 });
      const ws = socket();
      try {
        await hub.open(ws, "@1");
        expect({ fixture, ...ws.last("conv-card") }).toEqual({ fixture, t: "conv-card", windowId: "@1", card: null, screen: false, working: false });
        expect(state.captures).toBe(0);
      } finally {
        hub.stop();
      }
    }
    // A stamp set after the interrupt is a new turn: it runs.
    const { tmux } = fakeTmux({ ...claude(transcript(), "running"), since: Date.parse("2026-01-02T00:00:00Z") / 1000 }, pane("claude-idle-draft"));
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      expect(ws.last("conv-card")).toMatchObject({ card: null, screen: false, working: true });
    } finally {
      hub.stop();
    }
  });

  test("pages, links and search are answered even when the tab can't be looked up", async () => {
    const { tmux } = fakeTmux(null, "");
    tmux.agentOfWindow = async () => { throw new Error("no server running"); };
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.links(ws, "r1", "@9");
      await hub.search(ws, "r2", "@9", "x");
      await hub.more(ws, "@9", 100);
      await hub.around(ws, "@9", 100);
      expect(ws.last("conv-links-result")).toEqual({ t: "conv-links-result", req: "r1", windowId: "@9", conversation: null, links: [] });
      expect(ws.last("conv-search-result")).toEqual({ t: "conv-search-result", req: "r2", windowId: "@9", conversation: null, hits: [] });
      expect(ws.all("conv-page")).toEqual([0, 1].map(() => ({ t: "conv-page", windowId: "@9", conversation: null, items: [], start: 0, end: 0 })));
    } finally {
      hub.stop();
    }
  });

  test("pages, links and search name the conversation they were read for", async () => {
    const path = transcript();
    const { state, tmux } = fakeTmux(claude(path, "done"), pane("claude-idle-empty"));
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      const { end } = ws.last("conv")!;
      await hub.more(ws, "@1", end);
      await hub.around(ws, "@1", 0);
      await hub.search(ws, "s1", "@1", "the");
      await hub.links(ws, "l1", "@1");
      for (const m of [...ws.all("conv-page"), ws.last("conv-search-result")!, ws.last("conv-links-result")!]) {
        expect(m).toMatchObject({ windowId: "@1", conversation: "sess-1" });
      }
      // The open conversation is what's read while it is open, whatever the tab holds by then: the client, which
      // still shows it, keeps the answer; the next poll sends the new conversation, and the client drops what follows for the old one.
      state.agent = claude(transcript(), "done", "sess-2");
      await hub.search(ws, "s2", "@1", "the");
      expect(ws.last("conv-search-result")).toMatchObject({ req: "s2", conversation: "sess-1" });
      // Another tab, not open on this socket: read for its own conversation.
      await hub.links(ws, "l2", "@2");
      expect(ws.last("conv-links-result")).toMatchObject({ req: "l2", windowId: "@2", conversation: "sess-2" });
    } finally {
      hub.stop();
    }
  });

  test("the pane is read only while the stamp says waiting", async () => {
    const { state, tmux } = fakeTmux(claude(transcript(), "running"), pane("claude-bash-permission"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      expect(ws.last("conv-card")).toEqual({ t: "conv-card", windowId: "@1", card: null, screen: false, working: true });
      state.agent = claude(transcript(), "done");
      await waitFor(() => ws.last("conv-card")?.working === false, 1000, "idle");
      expect(ws.last("conv-card")).toMatchObject({ card: null, screen: false });
      expect(state.captures).toBe(0);
    } finally {
      hub.stop();
    }
  });

  test("a card goes out again only when it changes, a moved highlight included", async () => {
    const { state, tmux } = fakeTmux(claude(transcript()), pane("claude-bash-no-card"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      await waitFor(() => state.captures >= 6, 1000, "several polls");
      expect(ws.all("conv-card")).toHaveLength(1);
      const first = ws.all("conv-card")[0]!.card!;
      expect(first.selected).toBe(1);
      // A key at the desk moved the highlight to row 2: the same dialog (and fingerprint), a new row a move starts from.
      state.screen = pane("claude-bash-no-card")
        .replace("\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1.")
        .replace("   \x1b[38;2;153;153;153m2.", " \x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m2.");
      const moved = await waitFor(() => ws.all("conv-card")[1], 1000, "the moved highlight");
      expect(moved.card).toMatchObject({ fingerprint: first.fingerprint, selected: 2 });
      state.screen = pane("claude-write-permission");
      await waitFor(() => ws.all("conv-card").length === 3, 1000, "the next card");
      expect(ws.last("conv-card")!.card?.fingerprint).not.toBe(first.fingerprint);
    } finally {
      hub.stop();
    }
  });

  test("opening sends the last page, and what is appended follows as items", async () => {
    const path = transcript();
    const { tmux } = fakeTmux(claude(path, "done"), pane("claude-idle-empty"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      const conv = ws.last("conv")!;
      expect(conv).toMatchObject({ windowId: "@1", agent: "claude", conversation: "sess-1", start: 0, end: statSync(path).size });
      expect(conv.items.map((i) => i.id)).toContain("s1:1");
      appendFileSync(path, reply("n1", "All green."));
      const more = await waitFor(() => ws.last("conv-items"), 1000, "the appended row");
      expect(more.items).toEqual([expect.objectContaining({ kind: "agent", text: "All green." })]);
      // A row still being written waits until it is whole.
      const half = reply("n2", "Half then whole.");
      appendFileSync(path, half.slice(0, 20));
      await sleep(150);
      expect(ws.all("conv-items")).toHaveLength(1);
      appendFileSync(path, half.slice(20));
      await waitFor(() => ws.all("conv-items").length === 2, 1000, "the finished row");
      expect(ws.last("conv-items")!.items).toEqual([expect.objectContaining({ text: "Half then whole." })]);
      expect(ws.all("conv")).toHaveLength(1);
    } finally {
      hub.stop();
    }
  });

  test("another conversation in the tab, or a rewritten file, is sent afresh and never appended", async () => {
    const first = transcript();
    const { state, tmux } = fakeTmux(claude(first, "done"), pane("claude-idle-empty"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      const second = transcript("claude-turns.jsonl");
      appendFileSync(second, reply("n9", "In the new one."));
      state.agent = claude(second, "done", "sess-2");
      const fresh = await waitFor(() => ws.all("conv").length === 2 ? ws.last("conv") : undefined, 1000, "a fresh conv");
      expect(fresh).toMatchObject({ conversation: "sess-2", start: 0, end: statSync(second).size });
      expect(fresh.items.at(-1)).toMatchObject({ text: "In the new one." });
      // The same conversation's file, shorter than what was read: replaced, so read again from its last page.
      writeFileSync(second, reply("n10", "Rewritten."));
      const again = await waitFor(() => ws.all("conv").length === 3 ? ws.last("conv") : undefined, 1000, "a conv for the rewritten file");
      expect(again.items).toEqual([expect.objectContaining({ text: "Rewritten." })]);
      expect(ws.all("conv-items")).toHaveLength(0);
      // The agent gone from the tab: a conv saying so.
      state.agent = null;
      const gone = await waitFor(() => ws.all("conv").length === 4 ? ws.last("conv") : undefined, 1000, "no agent");
      expect(gone).toEqual({ t: "conv", windowId: "@1", agent: null, conversation: null, items: [], start: 0, end: 0 });
    } finally {
      hub.stop();
    }
  });

  test("a file not written yet is read once it is", async () => {
    const path = join(dir, "later.jsonl");
    const { tmux } = fakeTmux(claude(path, "done"), pane("claude-idle-empty"));
    const hub = createConversationHub({ tmux, pollMs: 30 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      expect(ws.last("conv")).toMatchObject({ agent: "claude", conversation: "sess-1", items: [], start: 0, end: 0 });
      writeFileSync(path, reply("l1", "First words."));
      const conv = await waitFor(() => ws.all("conv").length === 2 ? ws.last("conv") : undefined, 1000, "the file's page");
      expect(conv.items).toEqual([expect.objectContaining({ text: "First words." })]);
    } finally {
      hub.stop();
    }
  });

  test("a double tap answers once, and one tab's actions run one at a time", async () => {
    const { state, tmux } = fakeTmux(claude(transcript()), pane("claude-bash-permission"));
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.open(ws, "@1");
      const { fingerprint } = ws.last("conv-card")!.card!;
      await Promise.all([hub.answer(ws, "a", "@1", "sess-1", fingerprint, 1), hub.answer(ws, "b", "@1", "sess-1", fingerprint, 1)]);
      const results = ws.all("conv-result");
      expect(results.find((r) => r.req === "a")).toEqual({ t: "conv-result", req: "a", ok: true });
      expect(results.find((r) => r.req === "b")).toEqual({ t: "conv-result", req: "b", ok: false, error: "prompt-changed" });
      expect(state.writes).toEqual(["keys %1 1"]);

      state.writes = [];
      state.screen = state.entered = pane("claude-idle-empty");
      state.pasted = pane("claude-idle-draft");
      state.slowPaste = 50;
      await Promise.all([hub.send(ws, "s1", "@1", "sess-1", "one", null), hub.send(ws, "s2", "@1", "sess-1", "two", null)]);
      expect(state.writes).toEqual(["paste %1 one", "keys %1 Enter", "paste %1 two", "keys %1 Enter"]);
      expect(ws.all("conv-result").filter((r) => r.req.startsWith("s"))).toEqual([
        { t: "conv-result", req: "s1", ok: true },
        { t: "conv-result", req: "s2", ok: true },
      ]);
    } finally {
      hub.stop();
    }
  });

  test("a Screen key carries the screen's token back: pressed while it matches, refused with the screen as it is once it doesn't", async () => {
    const { state, tmux } = fakeTmux(claude(transcript()), pane("claude-bash-permission-tip"));
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.screen(ws, "p1", "@1");
      const seen = ws.last("conv-screen-result")!;
      expect(seen).toMatchObject({ req: "p1", ansi: pane("claude-bash-permission-tip"), cols: 80, rows: 24 });
      expect(seen.token).toMatch(/^[0-9a-f]{40}$/);
      await hub.key(ws, "k1", "@1", seen.token, "Down");
      expect(state.writes).toEqual(["keys %1 Down"]);
      expect(ws.last("conv-screen-result")).toEqual({ ...seen, req: "k1" });
      // Answered at the desk meanwhile: the key is not pressed, and the screen as it is now comes back.
      state.screen = pane("claude-idle-empty");
      await hub.key(ws, "k2", "@1", seen.token, "Enter");
      expect(state.writes).toEqual(["keys %1 Down"]);
      const refused = ws.last("conv-screen-result")!;
      expect(refused).toMatchObject({ req: "k2", ansi: pane("claude-idle-empty"), error: "prompt-changed" });
      expect(refused.token).not.toBe(seen.token);
      // A screen that can't be read is answered empty, with no token to press a key on.
      tmux.capturePane = async () => { throw new Error("no such pane"); };
      await hub.key(ws, "k3", "@1", refused.token, "Enter");
      expect(ws.last("conv-screen-result")).toEqual({ t: "conv-screen-result", req: "k3", ansi: "", cols: 0, rows: 0, token: "" });
      expect(ws.last("error")).toEqual({ t: "error", message: "no such pane" });
    } finally {
      hub.stop();
    }
  });

  test("Stop answers with a result", async () => {
    const { tmux } = fakeTmux(claude(transcript()), pane("claude-bash-permission"));
    const hub = createConversationHub({ tmux, pollMs: 1000 });
    const ws = socket();
    try {
      await hub.interrupt(ws, "x", "@1", "sess-1");
      await hub.interrupt(ws, "", "@1", "sess-1");
      await hub.interrupt(ws, "y", "@1", "sess-0");
      expect(ws.all("conv-result")).toEqual([
        { t: "conv-result", req: "x", ok: false, error: "waiting" },
        { t: "conv-result", req: "", ok: false, error: "waiting" },
        { t: "conv-result", req: "y", ok: false, error: "another-conversation" },
      ]);
    } finally {
      hub.stop();
    }
  });

  test("the timer runs only while some socket has a conversation open", async () => {
    // Every interval the hub starts and clears, watched through the globals it calls.
    const running = new Set<unknown>();
    const { setInterval: realSet, clearInterval: realClear } = globalThis;
    globalThis.setInterval = ((fn: () => void, ms?: number) => { const id = realSet(fn, ms); running.add(id); return id; }) as typeof setInterval;
    globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => { running.delete(id); realClear(id); }) as typeof clearInterval;
    const { state, tmux } = fakeTmux(claude(transcript(), "done"), pane("claude-idle-empty"));
    const hub = createConversationHub({ tmux, pollMs: 20 });
    const a = socket();
    const b = socket();
    try {
      await sleep(80);
      expect(running.size).toBe(0);
      expect(state.lookups).toBe(0);
      await hub.open(a, "@1");
      await hub.open(b, "@1");
      expect(running.size).toBe(1);
      hub.close(a);
      const before = state.lookups;
      await waitFor(() => state.lookups >= before + 3, 1000, "b still polled");
      expect(running.size).toBe(1);
      hub.close(b);
      expect(running.size).toBe(0);
      await sleep(30);
      const after = state.lookups;
      await sleep(100);
      expect(state.lookups).toBe(after);
    } finally {
      hub.stop();
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});

const SOCKET = "mxn-conv-server-test";

describe("conversations over the socket", () => {
  const tmux = new Tmux(SOCKET);
  let server: RunningServer;

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Origin: `http://127.0.0.1:${server.port}` } } as any);
    const messages: Msg[] = [];
    ws.onmessage = (e) => { if (typeof e.data === "string") messages.push(JSON.parse(e.data)); };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
    const send = (m: object) => ws.send(JSON.stringify(m));
    const last = <T extends Msg["t"]>(t: T) => all(messages, t).at(-1);
    return { ws, messages, send, last };
  }

  /** A detached 100×30 tab running `cat`, stamped as a Claude agent holding `path`. */
  async function agentTab(path: string, state: "input" | "done" = "done") {
    await tmux.run(["new-session", "-d", "-s", "conv", "-x", "100", "-y", "30", "cat"]);
    const [paneId, windowId] = (await tmux.run(["display-message", "-p", "-t", "=conv:", "#{pane_id} #{window_id}"])).trim().split(" ");
    await tmux.run(["set-option", "-p", "-t", paneId!, "@muxnexus_agent", `${state} ${Math.floor(Date.now() / 1000)} ${process.pid} /Users/me/.claude`]);
    await tmux.run(["set-option", "-p", "-t", paneId!, "@muxnexus_session", `sess-1 ${path}`]);
    return { paneId: paneId!, windowId: windowId! };
  }

  beforeAll(() => {
    server = createServer({ hosts: ["127.0.0.1"], port: 0, socketName: SOCKET, pollMs: 200, notesDir: join(dir, "notes") });
  });
  afterAll(() => server.stop());
  beforeEach(async () => { await tmux.killServer(); });
  afterEach(async () => { await tmux.killServer(); });

  test("opening a tab's conversation sends its last page", async () => {
    const path = transcript();
    const tab = await agentTab(path);
    await tmux.run(["new-window", "-t", "=conv:", "cat"]);
    const [codexPane, codexWindow] = (await tmux.run(["display-message", "-p", "-t", "=conv:1", "#{pane_id} #{window_id}"])).trim().split(" ");
    const rollout = transcript("codex-turns.jsonl");
    await tmux.run(["set-option", "-p", "-t", codexPane!, "@muxnexus_agent", `done ${Math.floor(Date.now() / 1000)} ${process.pid} /Users/me/.codex`]);
    await tmux.run(["set-option", "-p", "-t", codexPane!, "@muxnexus_thread", `thread-1 ${rollout}`]);
    const c = await connect();
    c.send({ t: "conv-open", windowId: tab.windowId });
    const conv = await waitFor(() => c.last("conv"), 3000, "conv");
    expect(conv).toMatchObject({ windowId: tab.windowId, agent: "claude", conversation: "sess-1", start: 0, end: statSync(path).size });
    expect(conv.items.map((i) => i.kind)).toEqual(["you", "you", "you", "peer", "peer", "agent", "step", "step-result", "step-result", "step-result", "notice", "notice"]);
    expect(await waitFor(() => c.last("conv-card"), 3000, "conv-card")).toEqual({ t: "conv-card", windowId: tab.windowId, card: null, screen: false, working: false });
    // One conversation per socket: opening another tab's replaces it.
    c.send({ t: "conv-open", windowId: codexWindow });
    const codex = await waitFor(() => c.last("conv")?.windowId === codexWindow ? c.last("conv") : undefined, 3000, "the Codex tab's conv");
    expect(codex).toMatchObject({ agent: "codex", conversation: "thread-1", end: statSync(rollout).size });
    expect(codex.items.map((i) => i.kind)).toContain("agent");
    c.ws.close();
  });

  test("what the agent writes next arrives within two polls", async () => {
    const path = transcript();
    const tab = await agentTab(path);
    const c = await connect();
    c.send({ t: "conv-open", windowId: tab.windowId });
    await waitFor(() => c.last("conv"), 3000, "conv");
    appendFileSync(path, reply("n1", "Tests pass."));
    const items = await waitFor(() => c.last("conv-items"), 2500, "conv-items");
    expect(items).toEqual({ t: "conv-items", windowId: tab.windowId, items: [expect.objectContaining({ kind: "agent", text: "Tests pass." })] });
    c.ws.close();
  });

  test("no attach or resize is ever sent", async () => {
    const path = transcript();
    const tab = await agentTab(path, "input");
    const size = () => tmux.run(["display-message", "-p", "-t", tab.windowId, "#{window_width}x#{window_height}"]);
    const before = await size();
    const c = await connect();
    c.send({ t: "conv-open", windowId: tab.windowId });
    // `cat` is no agent's screen: the wait is one only Screen can show.
    expect(await waitFor(() => c.last("conv-card"), 3000, "conv-card")).toMatchObject({ card: null, screen: true });
    c.send({ t: "conv-send", req: "s", windowId: tab.windowId, conversation: "sess-1", text: "# hi" });
    c.send({ t: "conv-answer", req: "a", windowId: tab.windowId, conversation: "sess-1", fingerprint: "0".repeat(40), option: 1 });
    c.send({ t: "conv-screen", req: "p", windowId: tab.windowId });
    const results = await waitFor(() => { const r = all(c.messages, "conv-result"); return r.length === 2 ? r : undefined; }, 3000, "both results");
    expect(results.find((r) => r.req === "s")).toMatchObject({ ok: false, error: "waiting" });
    expect(results.find((r) => r.req === "a")).toMatchObject({ ok: false, error: "prompt-changed" });
    const screen = await waitFor(() => c.last("conv-screen-result"), 3000, "conv-screen-result");
    expect(screen).toMatchObject({ req: "p", cols: 100, rows: 30 });
    // A key on that screen: pressed, answered with the screen after it, and nothing attached or resized.
    c.send({ t: "conv-key", req: "k", windowId: tab.windowId, token: screen.token, key: "Enter" });
    expect(await waitFor(() => all(c.messages, "conv-screen-result").find((r) => r.req === "k"), 3000, "the key's screen")).toMatchObject({ cols: 100, rows: 30 });
    expect(typeof screen.ansi).toBe("string");
    expect((await tmux.run(["list-clients"])).trim()).toBe("");
    expect(await size()).toBe(before);
    c.ws.close();
  });

  test("invalid messages get an error", async () => {
    const c = await connect();
    const refused = async (m: object, message: string) => {
      const n = all(c.messages, "error").length;
      c.send(m);
      expect((await waitFor(() => all(c.messages, "error")[n], 2000, message)).message).toBe(message);
    };
    await refused({ t: "conv-open" }, "invalid conv-open");
    await refused({ t: "conv-open", windowId: "1" }, "invalid conv-open");
    await refused({ t: "conv-key", req: "k", windowId: "@1", token: "f", key: "C-c" }, "invalid conv-key");
    // A key with no token (no screen it was pressed on), or no request to answer.
    await refused({ t: "conv-key", req: "k", windowId: "@1", key: "Enter" }, "invalid conv-key");
    await refused({ t: "conv-key", windowId: "@1", token: "f", key: "Enter" }, "invalid conv-key");
    await refused({ t: "conv-answer", req: "r", windowId: "@1", conversation: "sess-1", fingerprint: "f", option: 1.5 }, "invalid conv-answer");
    await refused({ t: "conv-send", req: "r", windowId: "@1", conversation: "sess-1", text: "x".repeat(100_001) }, "invalid conv-send");
    // Replace names the draft it clears (the fingerprint it was shown with), not just yes.
    await refused({ t: "conv-send", req: "r", windowId: "@1", conversation: "sess-1", text: "x", replace: true }, "invalid conv-send");
    await refused({ t: "conv-more", windowId: "@1", before: -1 }, "invalid conv-more");
    // A Stop names the conversation it was meant for.
    await refused({ t: "conv-stop", req: "s", windowId: "@1" }, "invalid conv-stop");
    await refused({ t: "conv-search", windowId: "@1", query: "x" }, "invalid conv-search");
    c.ws.close();
  });
});
