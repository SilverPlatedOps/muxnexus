import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { adapterFor } from "../src/server/conversation/adapter";
import { fingerprint, paneLines } from "../src/server/conversation/pane";

// Captured with `capture-pane -p -e` from real agents on a scratch tmux (Claude Code 2.1.322, Codex 0.167.1).
const raw = (name: string) => readFileSync(new URL(`./fixtures/conversation/pane-${name}.ansi`, import.meta.url), "utf8");
const claude = (name: string) => adapterFor("claude").readPane(raw(`claude-${name}`));
const codex = (name: string) => adapterFor("codex").readPane(raw(`codex-${name}`));
const anyPrint = expect.stringMatching(/^[0-9a-f]{40}$/);

test("escapes are stripped; a colour argument of 2 is not dim, SGR 2 is until 22 or a reset", () => {
  const [line] = paneLines("\x1b[38;2;2;2;2mA\x1b[2mB\x1b[22mC\x1b[1;2mD\x1b[0mE\x1b]8;id=x;file:///tmp/f\x1b\\F\x1b]8;;\x1b\\");
  expect(line!.text).toBe("ABCDEF");
  expect(line!.dim).toEqual([false, true, false, true, false, false]);
});

test("each character's style: dim, bold, reverse and both colours, a blank only what shows on it", () => {
  const [line] = paneLines("\x1b[1;38;5;153mA\x1b[22m \x1b[2;7mB\x1b[0;31;48;2;1;2;3m C\x1b[38:2::9:8:7mD\x1b[0m");
  expect(line!.text).toBe("A B CD");
  expect(line!.style).toEqual(["Bf5;153", "", "drf5;153", "b2;1;2;3", "f31b2;1;2;3", "f2;9;8;7b2;1;2;3"]);
});

test("dim and highlight carry from one row to the next, as tmux writes them", () => {
  const lines = paneLines("\x1b[2ma\nb\x1b[0m\n\x1b[48;2;1;2;3mc\x1b[49md");
  expect(lines.map((l) => l.text)).toEqual(["a", "b", "cd"]);
  expect(lines[1]!.dim).toEqual([true]);
  expect(lines[2]!.highlight).toEqual([true, false]);
});

test("a Bash prompt is a permission card with the command and the pane's own options", () => {
  expect(claude("bash-permission")).toEqual({
    dialog: {
      kind: "permission",
      title: "Bash command",
      detail: "touch probe.txt && sleep 20",
      options: [
        { index: 1, label: "Yes" },
        { index: 2, label: "Yes, and always allow access to /private/tmp/claude-501/cvt3 from this project", secondary: true },
        { index: 3, label: "Yes, and switch to auto mode · auto mode handles these prompts for you", secondary: true },
        { index: 4, label: "No", takesText: true },
      ],
      fingerprint: anyPrint,
      selected: 1,
    },
    unrecognised: false,
    draft: "unknown",
    working: false,
  });
});

test("a Write prompt names the file and its content; an Edit prompt the file and the diff", () => {
  const write = claude("write-permission").dialog;
  expect(write).toEqual({
    kind: "permission",
    title: "Create file",
    // The content as the pane numbers it.
    detail: "notes.txt\n 1 alpha\n 2 beta",
    options: [
      { index: 1, label: "Yes" },
      { index: 2, label: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", secondary: true },
      { index: 3, label: "No", takesText: true },
    ],
    fingerprint: anyPrint,
    selected: 1,
  });
  const edit = claude("edit-permission").dialog;
  expect(edit).toMatchObject({ kind: "permission", title: "Edit file", detail: "notes.txt\n1  alpha\n2 -beta\n2 +gamma" });
  expect(edit!.options.map((o) => o.index)).toEqual([1, 2, 3]);
  expect(edit!.options[2]).toEqual({ index: 3, label: "No", takesText: true });
});

test("a plan approval carries the plan; its last row takes the user's words", () => {
  const r = claude("plan");
  expect(r.unrecognised).toBe(false);
  expect(r.dialog).toEqual({
    kind: "plan",
    title: "Ready to code?",
    detail: [
      'Plan: create hello.txt containing "hi"', "", "Context", "",
      "The user wants a file named hello.txt whose content is hi. No exploration is needed.", "", "Steps", "",
      "1. Choose the location: /private/tmp/claude-501/cvt3/hello.txt (the working directory).",
      "2. Create the file with the Write tool, with content hi followed by a newline.",
      "3. Verify the file exists and contains exactly hi (e.g. read it back).", "", "Verification", "",
      "Reading hello.txt returns the single line hi.",
    ].join("\n"),
    options: [
      { index: 1, label: "Yes, and use auto mode", secondary: true },
      { index: 2, label: "Yes, manually approve edits" },
      { index: 3, label: "Tell Claude what to change", takesText: true },
    ],
    fingerprint: anyPrint,
    selected: 1,
  });
});

test("single-select questions are cards, numbered by the highlighted tab", () => {
  expect(claude("question")).toEqual({
    dialog: {
      kind: "question",
      title: "Pick a colour",
      // Each answer's description, from the row under it.
      options: [
        { index: 1, label: "red", description: "Red" },
        { index: 2, label: "green", description: "Green" },
        { index: 3, label: "blue", description: "Blue" },
        { index: 4, label: "Type something.", takesText: true },
        { index: 5, label: "Chat about this", secondary: true },
      ],
      fingerprint: anyPrint,
      selected: 1,
      question: { at: 1, of: 2 },
    },
    unrecognised: false,
    draft: "unknown",
    working: false,
  });
  expect(claude("question-2").dialog).toMatchObject({ title: "Pick a size", question: { at: 2, of: 2 } });
  expect(claude("question-2").dialog!.options.map((o) => o.label)).toEqual(["small", "large", "Type something.", "Chat about this"]);
});

test("a call with one single-select question has no tab bar: its header chip and the arrow footer make the same card", () => {
  // Claude Code 2.1.323: ` ☐ Fruit` highlighted where the tab bar would be, and `↑/↓ to navigate`; a digit submits at once.
  expect(claude("question-single")).toEqual({
    dialog: {
      kind: "question",
      title: "Pick a fruit",
      options: [
        { index: 1, label: "Apple", description: "Apple" },
        { index: 2, label: "Pear", description: "Pear" },
        { index: 3, label: "Type something.", takesText: true },
        { index: 4, label: "Chat about this", secondary: true },
      ],
      fingerprint: anyPrint,
      selected: 1,
      question: { at: 1, of: 1 },
    },
    unrecognised: false,
    draft: "unknown",
    working: false,
  });
  // In plan mode, under the plan file's name: the same dialog.
  expect(claude("question-single-plan").dialog!.fingerprint).toBe(claude("question-single").dialog!.fingerprint);
});

test("an answer's description is on its card and in its fingerprint: wrapped rows joined, a changed one a new card", () => {
  const read = (ansi: string) => adapterFor("claude").readPane(ansi).dialog!;
  // The first answer's description row, as captured (grey, indented to the label).
  for (const [name, row, desc] of [
    ["claude-question", "     \x1b[38;2;153;153;153mRed\x1b[39m", "Red"],
    ["claude-question-single", "     \x1b[38;5;246mApple\x1b[39m", "Apple"],
  ] as const) {
    const ansi = raw(name);
    expect(ansi).toContain(row);
    // Another description, the labels the same: another prompt, so a tap read off the old one is refused.
    const changed = read(ansi.replace(row, row.replace(desc, "Not this one")));
    expect(changed.options[0]).toMatchObject({ index: 1, description: "Not this one" });
    expect(changed.fingerprint).not.toBe(read(ansi).fingerprint);
    // A description too long for the pane wraps onto rows indented under the label: one line on the card.
    const wrapped = read(ansi.replace(row, `${row.replace(desc, `${desc} and more`)}\n     words below`));
    expect(wrapped.options[0]!.description).toBe(`${desc} and more words below`);
    expect(wrapped.options.map((o) => o.index)).toEqual(read(ansi).options.map((o) => o.index));
  }
  // The field focused, the descriptions are the card's still: the same fingerprint.
  expect(claude("question-other-field").field!.fingerprint).toBe(claude("question").dialog!.fingerprint);
});

test("a header chip is one highlighted header under a rule, with the one-question footer", () => {
  const read = (ansi: string) => adapterFor("claude").readPane(ansi);
  const single = raw("claude-question-single");
  expect(read(single.replace("\x1b[48;5;153m ☐ Fruit ", "\x1b[49m ☐ Fruit ")).dialog).toBeNull();
  expect(read(single.replace(" ☐ Fruit ", " ☐ Fruit ☐ Size ")).dialog).toBeNull();
  expect(read(withFooter(single, QUESTION_FOOTER)).dialog).toBeNull();
  // And the tab bar keeps its own footer.
  expect(read(withFooter(raw("claude-question"), ONE_QUESTION_FOOTER)).dialog).toBeNull();
});

test("the review step is a card of its own, with the answers as detail", () => {
  expect(claude("question-review").dialog).toEqual({
    kind: "question",
    title: "Review your answers",
    detail: "● Pick a colour\n  → green\n● Pick a size\n  → medium",
    options: [{ index: 1, label: "Submit answers" }, { index: 2, label: "Cancel" }],
    fingerprint: anyPrint,
    selected: 1,
  });
});

/** The capture with its last row replaced. */
const withFooter = (ansi: string, footer: string) => {
  const rows = ansi.split("\n");
  let i = rows.length - 1;
  while (i > 0 && rows[i]!.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") i--;
  rows[i] = footer;
  return rows.join("\n");
};
const QUESTION_FOOTER = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
const ONE_QUESTION_FOOTER = "Enter to select · ↑/↓ to navigate · Esc to cancel";

test("a multi-select question is not a card", () => {
  expect(claude("question-multi")).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
  // Not even under the single-select footer: its rows carry checkboxes.
  expect(adapterFor("claude").readPane(withFooter(raw("claude-question-multi"), QUESTION_FOOTER))).toMatchObject({ dialog: null, unrecognised: true });
});

test("a dialog whose text box has focus is not a card: a digit would be typed, not chosen", () => {
  expect(claude("question-typing")).toMatchObject({ dialog: null, unrecognised: true });
  expect(adapterFor("claude").readPane(withFooter(raw("claude-question-typing"), QUESTION_FOOTER))).toMatchObject({ dialog: null, unrecognised: true });
  expect(adapterFor("claude").readPane(withFooter(raw("claude-question-2"), QUESTION_FOOTER)).dialog).not.toBeNull();
  // The plan's feedback row keeps the same footer: only the selection shows the field has focus.
  expect(claude("plan-feedback")).toMatchObject({ dialog: null, unrecognised: true });
});

test("a focused field is read as the dialog it belongs to, before and after the user's words go in", () => {
  const card = (name: string) => claude(name).dialog!.fingerprint;
  // Each set was captured from one dialog: its card, the field focused, the field holding words that wrap and run over two lines.
  for (const [cardName, fields] of [
    ["bash-no-card", ["bash-no-field", "bash-no-text"]],
    ["plan-change-card", ["plan-change-field", "plan-change-text"]],
    ["question", ["question-other-field", "question-other-text"]],
    ["question-2", ["question-typing"]],
    ["question-single-plan", ["question-single-field", "question-single-text"]],
    ["plan", ["plan-feedback"]],
  ] as const) {
    for (const name of fields) expect(claude(name)).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false, field: { fingerprint: card(cardName) } });
  }
  // Words with a numbered line, a blank line, a rule or the dialog's own hint in them: all of it the field's, read to the
  // dialog's own end (the permission's footer, the plan's hint, the rule over "Chat about this"), never as options.
  const short = card("plan-short");
  expect(claude("plan-short-field").field).toEqual({ fingerprint: short });
  // The words' extra rows scrolled the dialog's heading off the top: no longer the whole dialog, so no field.
  expect(claude("plan-short-text-lines")).not.toHaveProperty("field");
  // With the rows above put back (from the same dialog's card): the field.
  const card_ = raw("claude-plan-short").split("\n");
  const typed = raw("claude-plan-short-text-lines").split("\n");
  const top = card_.slice(0, card_.findIndex((r) => r.includes("Here is Claude")));
  expect(adapterFor("claude").readPane([...top, ...typed].join("\n")).field).toEqual({ fingerprint: short });
  expect(claude("question-single-text-lines").field).toEqual({ fingerprint: card("question-single") });
  const ruled = raw("claude-question-single-text-lines").replace("     thanks", "     ────────────\n     4. Chat about this");
  expect(adapterFor("claude").readPane(ruled).field).toEqual({ fingerprint: card("question-single") });
  for (const name of ["write-no-lines", "write-no-blank"]) expect(claude(name)).toMatchObject({ dialog: null, unrecognised: true, field: { fingerprint: anyPrint } });
  // A row under the field that isn't indented to it is not the user's: no field.
  expect(adapterFor("claude").readPane(raw("claude-write-no-lines").replace("          1. do not create", "  1. do not create"))).not.toHaveProperty("field");

  // A card is not a field, and a screen that isn't a dialog has none.
  for (const name of ["bash-no-card", "plan", "question", "question-review", "trust", "question-multi", "idle-empty"]) expect(claude(name)).not.toHaveProperty("field");

  // Tab on another row amends that row: not the No field.
  const yes = raw("claude-bash-no-field")
    .replace(/ \x1b\[[0-9;]*m❯\x1b\[[0-9;]*m (\x1b\[[0-9;]*m)?4\./, "   $14.")
    .replace(/   (\x1b\[[0-9;]*m)?1\./, " ❯ $11.");
  expect(yes).not.toBe(raw("claude-bash-no-field"));
  expect(adapterFor("claude").readPane(yes)).not.toHaveProperty("field");
  // The dialog changed under the field: its fingerprint is another one.
  const other = raw("claude-bash-no-text").replace("m touch probe.txt && sleep 20\n", "m touch probe.txt && sleep 30\n");
  expect(other).not.toBe(raw("claude-bash-no-text"));
  expect(adapterFor("claude").readPane(other).field!.fingerprint).not.toBe(card("bash-no-card"));
});

test("a Codex approval is a card with the command; its decline row takes the user's words", () => {
  expect(codex("approval")).toEqual({
    dialog: {
      kind: "approval",
      title: "Would you like to run the following command?",
      detail: "$ touch probe2.txt && sleep 20",
      options: [
        { index: 1, label: "Yes, proceed" },
        { index: 2, label: "Yes, and don't ask again for commands that start with `touch probe2.txt`", secondary: true },
        { index: 3, label: "No, and tell Codex what to do differently", takesText: true },
      ],
      fingerprint: anyPrint,
      selected: 1,
    },
    unrecognised: false,
    draft: "unknown",
    working: false,
  });
});

test("a stamp that says waiting proves nothing: an idle pane has no card", () => {
  for (const name of ["idle-empty", "idle-draft", "idle-multiline-draft", "idle-pasted", "idle-suggestion", "idle-list", "working", "queued"]) {
    expect({ name, ...claude(name) }).toMatchObject({ name, dialog: null, unrecognised: false });
  }
  for (const name of ["idle-empty", "idle-draft", "idle-multiline-draft", "working"]) {
    expect({ name, ...codex(name) }).toMatchObject({ name, dialog: null, unrecognised: false });
  }
});

test("only the prompt's own glyph marks Claude's box: `❯` and a no-break space", () => {
  const rule = "─".repeat(40);
  expect(adapterFor("claude").readPane(`${rule}\n❯\u00a0hi\n${rule}\n`)).toMatchObject({ unrecognised: false, draft: "text", draftText: "hi" });
  // A submitted prompt or a dialog's selected row has a plain space.
  expect(adapterFor("claude").readPane(`${rule}\n❯ hi\n${rule}\n`)).toMatchObject({ dialog: null, unrecognised: true, draft: "unknown" });
});

test("an unknown Codex dialog is never read as the composer", () => {
  // A hotkey the reader hasn't seen, and no row selected: the last `›` left is a submitted prompt's.
  const pane = raw("codex-approval").replace("(\x1b[1mesc\x1b[0m)", "(\x1b[1mn\x1b[0m)").replace("\x1b[1;7m› 1.", "  1.");
  expect(pane).not.toBe(raw("codex-approval"));
  expect(adapterFor("codex").readPane(pane)).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
});

test("a wrapped dialog fails closed", () => {
  expect(claude("bash-permission-60col")).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
});

test("dialogs no adapter knows, and panes that aren't an agent's, fail closed", () => {
  expect(claude("trust")).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
  expect(codex("update")).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
  for (const kind of ["claude", "codex"] as const) {
    expect(adapterFor(kind).readPane("")).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false });
    expect(adapterFor(kind).readPane("$ ls\nfile.txt\n$ ")).toMatchObject({ dialog: null, unrecognised: true });
  }
});

test("Claude's prompt: dim text is a placeholder, anything else is the user's draft", () => {
  expect(claude("idle-empty")).toMatchObject({ draft: "empty" });
  expect(claude("idle-empty")).not.toHaveProperty("draftText");
  expect(claude("idle-suggestion")).toMatchObject({ draft: "empty" });
  expect(claude("working")).toMatchObject({ draft: "empty" });
  expect(claude("idle-draft")).toMatchObject({ draft: "text", draftText: "hello draft" });
  expect(claude("idle-multiline-draft")).toMatchObject({ draft: "text", draftText: "draft one\ndraft two" });
  expect(claude("idle-pasted")).toMatchObject({ draft: "text", draftText: "[Pasted text #1 +39 lines]" });
  // Dim, but it stands for messages waiting to be sent: never treated as an empty prompt.
  expect(claude("queued")).toMatchObject({ draft: "text", draftText: "Press up to edit queued messages" });
  expect(claude("bash-permission")).toMatchObject({ draft: "unknown" });
  expect(claude("trust")).toMatchObject({ draft: "unknown" });
});

test("Codex's composer: the dim placeholder is empty, typed or pasted text is a draft", () => {
  expect(codex("idle-empty")).toMatchObject({ draft: "empty" });
  expect(codex("working")).toMatchObject({ draft: "empty" });
  expect(codex("idle-draft")).toMatchObject({ draft: "text", draftText: "hello draft" });
  expect(codex("idle-multiline-draft")).toMatchObject({ draft: "text", draftText: "line one\nline two" });
  expect(codex("approval")).toMatchObject({ draft: "unknown" });
});

test("working: Claude's spinner and Codex's Working line; idle panes are not working", () => {
  expect(claude("working").working).toBe(true);
  expect(claude("queued").working).toBe(true);
  expect(codex("working").working).toBe(true);
  for (const name of ["idle-empty", "idle-draft", "idle-list"]) expect(claude(name).working).toBe(false);
  for (const name of ["idle-empty", "idle-draft"]) expect(codex(name).working).toBe(false);
  // A command left running in the background adds to the line.
  const background = raw("codex-working").replace("to interrupt)\x1b[0m", "to interrupt)\x1b[0m · 1 background terminal running · /ps to view · /stop to close");
  expect(background).not.toBe(raw("codex-working"));
  expect(adapterFor("codex").readPane(background).working).toBe(true);
});

test("the fingerprint is sha1 of its parts joined by newlines", () => {
  expect(fingerprint(["Bash command", "ls"])).toBe(createHash("sha1").update("Bash command\nls").digest("hex"));
});

test("the fingerprint changes when the command changes and only then", () => {
  const pane = raw("claude-bash-permission");
  const print = (ansi: string) => adapterFor("claude").readPane(ansi).dialog?.fingerprint;
  const base = print(pane);
  expect(base).toEqual(anyPrint);

  // The desk moved the selection to "No": a digit still means the same option.
  const moved = pane
    .replace("\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1.")
    .replace("   \x1b[38;2;153;153;153m4.", " \x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m4.");
  expect(moved).not.toBe(pane);
  expect(adapterFor("claude").readPane(moved).dialog!.options.map((o) => o.label)).toEqual(["Yes", expect.any(String), expect.any(String), "No"]);
  expect(adapterFor("claude").readPane(moved).dialog!.selected).toBe(4);
  expect(print(moved)).toBe(base);

  // The tip comes and goes; the conversation above the dialog scrolls.
  const tip = pane.replace(/\n \x1b\[1mTip: [^\n]*/, "");
  expect(tip).not.toBe(pane);
  expect(print(tip)).toBe(base);
  const above = pane.replace("Use the Bash tool once", "Use the shell once");
  expect(above).not.toBe(pane);
  expect(print(above)).toBe(base);

  // A different command is a different prompt.
  const other = pane.replace("m touch probe.txt && sleep 20\n", "m touch probe.txt && sleep 30\n");
  expect(other).not.toBe(pane);
  expect(adapterFor("claude").readPane(other).dialog!.detail).toBe("touch probe.txt && sleep 30");
  expect(print(other)).not.toBe(base);
});

test("Codex's fingerprint follows the command, not the highlighted row", () => {
  const pane = raw("codex-approval");
  const print = (ansi: string) => adapterFor("codex").readPane(ansi).dialog?.fingerprint;
  const base = print(pane);
  const moved = pane.replace("\x1b[1;7m› 1. Yes, proceed (y)\n\x1b[0m  2.", "  1. Yes, proceed (y)\n\x1b[1;7m› 2.");
  expect(moved).not.toBe(pane);
  expect(print(moved)).toBe(base);
  const other = pane.replace(/\$ (\x1b\[[0-9;]*m)touch/, "$ $1rm");
  expect(other).not.toBe(pane);
  expect(print(other)).not.toBe(base);
});

/** `ansi` with `from` replaced by `to`; the test fails if `from` isn't there. */
const edit = (ansi: string, from: string, to: string) => {
  expect(ansi).toContain(from);
  return ansi.replace(from, to);
};
const claudeCard = (ansi: string) => adapterFor("claude").readPane(ansi).dialog;

test("plan, question, review and file cards: the fingerprint changes when their text changes and only then", () => {
  const plan = raw("claude-plan");
  const p = claudeCard(plan)!;
  const planMoved = edit(
    edit(plan, "\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1."),
    "   \x1b[38;2;153;153;153m2.",
    " \x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m2.",
  );
  expect(claudeCard(planMoved)!.fingerprint).toBe(p.fingerprint);
  const planReworded = claudeCard(edit(plan, "single line \x1b[38;2;153;204;255mhi", "single line \x1b[38;2;153;204;255mho"))!;
  expect(planReworded.detail).toEndWith("returns the single line ho.");
  expect(planReworded.fingerprint).not.toBe(p.fingerprint);

  const question = raw("claude-question");
  const q = claudeCard(question)!;
  const questionMoved = edit(
    edit(question, "\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m1.", "  \x1b[38;2;153;153;153m1."),
    "  \x1b[38;2;153;153;153m2.",
    "\x1b[38;2;153;204;255m❯\x1b[39m \x1b[38;2;153;153;153m2.",
  );
  expect(claudeCard(questionMoved)!.fingerprint).toBe(q.fingerprint);
  const relabelled = claudeCard(edit(question, "m2.\x1b[39m green", "m2.\x1b[39m grey"))!;
  expect(relabelled.options[1]!.label).toBe("grey");
  expect(relabelled.fingerprint).not.toBe(q.fingerprint);

  const review = raw("claude-question-review");
  const changed = claudeCard(edit(review, "m→ medium", "m→ large"))!;
  expect(changed.detail).toEndWith("→ large");
  expect(changed.fingerprint).not.toBe(claudeCard(review)!.fingerprint);

  // A file card shows the path and the content, and its fingerprint covers both.
  const write = raw("claude-write-permission");
  const rewritten = claudeCard(edit(write, "\x1b[38;2;248;248;242mbeta", "\x1b[38;2;248;248;242mbetter"))!;
  expect(rewritten.detail).toBe("notes.txt\n 1 alpha\n 2 better");
  expect(rewritten.fingerprint).not.toBe(claudeCard(write)!.fingerprint);
  const editPane = raw("claude-edit-permission");
  const reedited = claudeCard(edit(editPane, "\x1b[38;2;248;248;242mgamma", "\x1b[38;2;248;248;242mdelta"))!;
  expect(reedited.detail).toEndWith("2 +delta");
  expect(reedited.fingerprint).not.toBe(claudeCard(editPane)!.fingerprint);
});

test("rows a Claude layout doesn't expect, between its content and its options, fail closed", () => {
  const bash = raw("claude-bash-permission");
  const unread = { dialog: null, unrecognised: true };
  const warned = edit(bash, " Do you want to proceed?\n", " Do you want to proceed?\n Warning: this command touches files outside the project. Continue?\n");
  expect(adapterFor("claude").readPane(warned)).toMatchObject(unread);
  const twice = edit(bash, " Do you want to proceed?\n", " Do you want to proceed? Do you want to proceed?\n");
  expect(adapterFor("claude").readPane(twice)).toMatchObject(unread);

  const plan = raw("claude-plan");
  const ask = "\x1b[39m \x1b[38;2;153;153;153mClaude\x1b[39m \x1b[38;2;153;153;153mhas";
  const extra = edit(plan, ask, "\x1b[39m Anything at all here, no question.\n \x1b[38;2;153;153;153mClaude\x1b[39m \x1b[38;2;153;153;153mhas");
  expect(adapterFor("claude").readPane(extra)).toMatchObject(unread);
  // A third dashed rule: the plan would be cut short there, and what follows left out of the fingerprint.
  const cut = edit(plan, " \x1b[1mVerification", `${"╌".repeat(40)}\n \x1b[1mVerification`);
  expect(adapterFor("claude").readPane(cut)).toMatchObject(unread);
});

test("a Codex approval is read from its own block only", () => {
  const pane = raw("codex-approval");
  const unread = { dialog: null, unrecognised: true };
  // Another kind of dialog, with the approval's header text further up in the history.
  const header = edit(pane, "\x1b[1mWould you like to run the following command?", "\x1b[1mWould you like to make the following edits?");
  expect(adapterFor("codex").readPane(`  Would you like to run the following command?\n${header}`)).toMatchObject(unread);
  // A second `$ ` row above the real command.
  const shown = edit(pane, "\n  $ \x1b[38;2;137;180;250mtouch", "\n  $ echo shown-instead\n  $ \x1b[38;2;137;180;250mtouch");
  expect(adapterFor("codex").readPane(shown)).toMatchObject(unread);
  // A row the reader doesn't know, between the command and the options.
  const unknown = edit(pane, "\x1b[1;7m› 1.", "  Something else\n\x1b[1;7m› 1.");
  expect(adapterFor("codex").readPane(unknown)).toMatchObject(unread);
});
