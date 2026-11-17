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
      // The row between the title and the command, saying what it does.
      description: "Create probe.txt then sleep 20 seconds",
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

test("a Bash prompt's description is on its card and in its fingerprint; any other row over the command is Screen's", () => {
  // Claude Code 2.1.323: the title, a tip, a description of the command, then the command between dashed rules.
  const tip = raw("claude-bash-permission-tip");
  const description = "\x1b[38;5;246mCreate empty file made.txt\x1b[39m";
  const card = adapterFor("claude").readPane(tip).dialog!;
  // Another description is another prompt: what the user agreed to is what it says.
  for (const other of ["Delete everything in home", "Warning: this command writes outside the project"]) {
    const read = adapterFor("claude").readPane(tip.replace(description, other)).dialog;
    expect(read!.fingerprint).not.toBe(card.fingerprint);
    expect(read).toMatchObject({ description: other });
  }
  expect(card).toMatchObject({ kind: "permission", title: "Bash command", description: "Create empty file made.txt", detail: "touch made.txt" });
  // The tip and blank rows alone, no description: still a card.
  expect(adapterFor("claude").readPane(tip.replace(` ${description}\n`, "")).dialog).toMatchObject({ kind: "permission", detail: "touch made.txt" });
  // A second row besides the tip, or another tip: no layout this reader was written against, so Screen.
  for (const extra of [` ${description}\n Warning: this command writes outside the project`, " Tip: something else entirely"]) {
    const read = adapterFor("claude").readPane(tip.replace(` ${description}`, extra));
    expect(read).toMatchObject({ dialog: null, unrecognised: true });
  }
  // "This command requires approval" over the question, as 2.1.323 sometimes draws it: Screen too.
  const approval = tip.replace(" Do you want to proceed?", " This command requires approval\n\n Do you want to proceed?");
  expect(adapterFor("claude").readPane(approval)).toMatchObject({ dialog: null, unrecognised: true });
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
  // The field holds the user's words as drawn (wrapped rows as rows), or "" while it shows its dim placeholder.
  for (const [cardName, fields] of [
    ["bash-no-card", [["bash-no-field", ""], ["bash-no-text", "instead of touching the file, list the directory with ls -la and then tell me how many entries it has, and\nalso say why\nsecond line of the note"]]],
    ["plan-change-card", [["plan-change-field", ""], ["plan-change-text", "use the word bye instead of hi everywhere, and also add a third step that prints the file contents afterwards\nsecond line"]]],
    ["question", [["question-other-field", ""], ["question-other-text", "a deep purple close to violet, like the evening sky just after sunset, not quite blue and not quite red either\nsecond line"]]],
    ["question-2", [["question-typing", ""]]],
    ["question-single-plan", [["question-single-field", ""], ["question-single-text", "kiwi"]]],
    ["plan", [["plan-feedback", ""]]],
  ] as const) {
    for (const [name, text] of fields) expect(claude(name)).toEqual({ dialog: null, unrecognised: true, draft: "unknown", working: false, field: { fingerprint: card(cardName), text } });
  }
  // Words with a numbered line, a blank line, a rule or the dialog's own hint in them: all of it the field's, read to the
  // dialog's own end (the permission's footer, the plan's hint, the rule over "Chat about this"), never as options.
  const short = card("plan-short");
  expect(claude("plan-short-field").field).toEqual({ fingerprint: short, text: "" });
  // The words' extra rows scrolled the dialog's heading off the top: no longer the whole dialog, so no field.
  expect(claude("plan-short-text-lines")).not.toHaveProperty("field");
  // With the rows above put back (from the same dialog's card): the field.
  const card_ = raw("claude-plan-short").split("\n");
  const typed = raw("claude-plan-short-text-lines").split("\n");
  const top = card_.slice(0, card_.findIndex((r) => r.includes("Here is Claude")));
  // The words quote the hint: the field's own hint is its last row, and not the words'.
  expect(adapterFor("claude").readPane([...top, ...typed].join("\n")).field).toEqual({
    fingerprint: short, text: "Two things:\n\n1. keep five steps\n────────────\nshift+tab to approve with this feedback",
  });
  expect(claude("question-single-text-lines").field).toEqual({ fingerprint: card("question-single"), text: "kiwi\n\n1. ripe one\nthanks" });
  const ruled = raw("claude-question-single-text-lines").replace("     thanks", "     ────────────\n     4. Chat about this");
  expect(adapterFor("claude").readPane(ruled).field).toEqual({ fingerprint: card("question-single"), text: "kiwi\n\n1. ripe one\n────────────\n4. Chat about this" });
  expect(claude("write-no-lines")).toMatchObject({ dialog: null, unrecognised: true, field: { fingerprint: anyPrint, text: "Two things:\n1. do not create the file\nThen reply with just the word skipped2." } });
  expect(claude("write-no-blank")).toMatchObject({ dialog: null, unrecognised: true, field: { fingerprint: anyPrint, text: "Do not create the file.\n\nReply with just the word skipped3." } });
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
      detail: "Environment: local\nReason: Create a probe file\n$ touch probe2.txt && sleep 20",
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

test("a Codex approval's Reason and Environment are part of the prompt: either changed is another one", () => {
  const print = codex("approval").dialog!.fingerprint;
  const rows = [
    ["Reason: \x1b[3mCreate a probe file", "Reason: \x1b[3mDelete the backups", "Reason: Delete the backups"],
    ["Environment: \x1b[1mlocal", "Environment: \x1b[1mremote", "Environment: remote"],
  ];
  for (const [from, to, shown] of rows) {
    const pane = raw("codex-approval").replace(from!, to!);
    expect(pane).not.toBe(raw("codex-approval"));
    const read = adapterFor("codex").readPane(pane);
    expect(read.dialog!.detail).toContain(shown!);
    expect(read.dialog!.fingerprint).not.toBe(print);
  }
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

test("a dialog wrapped in a 60-column pane (2.1.322): its tip over three rows and an option's label over two are read", () => {
  const card = claude("bash-permission-60col").dialog!;
  expect(card).toMatchObject({ kind: "permission", title: "Bash command", description: "Create empty file narrow.txt", detail: "touch narrow.txt", selected: 1 });
  expect(card.options.map((o) => [o.index, o.label])).toEqual([
    [1, "Yes"],
    [2, "Yes, and always allow access to /private/tmp/claude-501/cvt3 from this project"],
    [3, "Yes, and switch to auto mode · auto mode handles these prompts for you"],
    [4, "No"],
  ]);
});

test("dialogs no adapter knows, and panes that aren't an agent's, fail closed", () => {
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
  // Dim, and it stands for messages waiting to be sent: the prompt itself is empty (a message typed now is queued too).
  expect(claude("queued")).toMatchObject({ draft: "empty", queued: true });
  expect(claude("queued")).not.toHaveProperty("draftText");
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

test("a prompt holds the words, then exactly the images pasted after them, as the agents show those", () => {
  // As measured on Claude Code 2.1.325 and Codex 0.167.1: a path pasted on its own shows as `[Image #N]`, N counting
  // the session's pastes; a leading space is dropped, and a fold of the words comes first.
  const shows = (kind: "claude" | "codex", shown: string, words: string, images: number) => adapterFor(kind).shows(shown, words, images);
  for (const kind of ["claude", "codex"] as const) {
    expect(shows(kind, "look at this [Image #3] [Image #4]", "look at this ", 2)).toBe(true);
    expect(shows(kind, "look at this[Image #2]", "look at this", 1)).toBe(true);
    expect(shows(kind, "[Image #1]", "", 1)).toBe(true);
    expect(shows(kind, "[Image #1] [Image #2]", "", 2)).toBe(true);
    // Before the image's token: the words alone (the path still showing as text is not yet the image).
    expect(shows(kind, "look at this", "look at this ", 0)).toBe(true);
    expect(shows(kind, "look at this /tmp/p/1-a.png", "look at this ", 1)).toBe(false);
    // One token too many (an image pasted at the desk meanwhile), or too few, and it isn't what the phone sent.
    expect(shows(kind, "look at this [Image #3] [Image #4]", "look at this ", 1)).toBe(false);
    expect(shows(kind, "look at this [Image #3]", "look at this ", 2)).toBe(false);
    expect(shows(kind, "[Image #1] [Image #2]", "", 1)).toBe(false);
    expect(shows(kind, "x [Image #1]", "", 1)).toBe(false);
    // Other words, and nothing at all, are never the phone's.
    expect(shows(kind, "look at that [Image #3]", "look at this ", 1)).toBe(false);
    expect(shows(kind, "", "", 1)).toBe(false);
  }
  // Words long enough to fold, then an image: Claude's fold counts the words' line breaks; Codex's their characters.
  expect(shows("claude", "[Pasted text #14 +3 lines][Image #15]", "line one\nline two\nline three\nline four ", 1)).toBe(true);
  expect(shows("codex", `[Pasted Content 1201 chars] [Image #1]`, `${"w".repeat(1200)} `, 1)).toBe(true);
  // And as the prompt reads on screen: the words and the token as typed text.
  const draft = (kind: "claude" | "codex", text: string) => adapterFor(kind).readPane(raw(`${kind}-idle-draft`).replace("hello draft", text));
  expect(adapterFor("claude").owns(draft("claude", "hello draft [Image #1]"), "hello draft ", 1)).toBe(true);
  expect(adapterFor("claude").owns(draft("claude", "hello draft [Image #1]"), "hello draft ", 0)).toBe(false);
  expect(adapterFor("codex").owns(draft("codex", "hello draft [Image #1]"), "hello draft ", 1)).toBe(true);
});

// Claude Code 2.1.322 and Codex 0.167.1, each started in a folder it hadn't been told to trust (2.1.325's screen is the same).
test("Claude's first screen in a folder not trusted yet is a trust card, answered with the arrows and Enter", () => {
  const r = claude("trust");
  expect(r.unrecognised).toBe(false);
  const card = r.dialog!;
  expect(card).toMatchObject({ kind: "trust", title: "Trust this folder?", detail: "/private/tmp/claude-501/cvt3", selected: 1, fingerprint: anyPrint });
  // Yes leads the card; each keeps the row it is on screen (No is first there, highlighted).
  expect(card.options.map((o) => [o.index, o.label])).toEqual([[2, "Yes, I trust this folder"], [1, "No, exit"]]);
  const keys = (c: typeof card, o: number) => adapterFor("claude").keysFor(c, o, false)?.keys;
  // No digit chooses here: a 2 typed on this screen did nothing.
  expect(keys(card, 2)).toEqual(["Down", "Enter"]);
  expect(keys(card, 1)).toEqual(["Enter"]);
  expect(keys({ ...card, selected: 2 }, 1)).toEqual(["Up", "Enter"]);
  expect(keys(card, 3)).toBeUndefined();
  expect(keys({ ...card, selected: undefined }, 2)).toBeUndefined();
});

test("Codex's trust question is a trust card; the update notice before it, and its prompt after, are not", () => {
  const r = codex("trust");
  const card = r.dialog!;
  expect(card).toMatchObject({ kind: "trust", title: "Trust this folder?", detail: "/private/tmp/claude-501/shop-api", selected: 1, fingerprint: anyPrint });
  expect(card.options.map((o) => [o.index, o.label, !!o.secondary])).toEqual([[1, "Trust and continue", false], [2, "Back to Agent Command Center", true]]);
  expect(adapterFor("codex").keysFor(card, 1, false)?.keys).toEqual(["Enter"]);
  expect(adapterFor("codex").keysFor(card, 2, false)?.keys).toEqual(["Down", "Enter"]);
  // The update notice is Screen's to answer.
  expect(codex("update")).toMatchObject({ dialog: null, unrecognised: true });
  // Trusted, it waits at its empty prompt.
  expect(codex("fresh")).toMatchObject({ dialog: null, unrecognised: false, draft: "empty", working: false });
});

// --- Narrow panes ---
//
// Measured on Claude Code 2.1.326 at 80 and 46 columns and Codex 0.167.1 at 80, in a scratch tmux. The agents wrap their own
// rows (`capture-pane -J` joins nothing: the rows are written separately, only padded). A label too long for the pane
// carries on in the rows under it, indented to the label; a Bash command's tip and description, a plan's question and a
// dialog's footer wrap at the spaces; a wrapped description or question title wears a `│ ` on each row.

const claudeKeys = (c: Parameters<ReturnType<typeof adapterFor>["keysFor"]>[0], o: number) => adapterFor("claude").keysFor(c, o, false)?.keys;
const mangled = (name: string, from: string, to: string) => {
  const text = raw(name);
  expect(text).toContain(from);
  return text.replace(from, to);
};
const screenOf = (kind: "claude" | "codex", ansi: string) => expect(adapterFor(kind).readPane(ansi)).toMatchObject({ dialog: null, unrecognised: true });
const choices = (c: { options: { index: number; label: string }[] }) => c.options.map((o) => [o.index, o.label]);

test("80 columns: a Bash prompt with a wrapped tip, description and option is a card; each option keeps its row's number", () => {
  const r = claude("bash-permission-80col");
  expect(r.unrecognised).toBe(false);
  const card = r.dialog!;
  expect(card).toMatchObject({
    kind: "permission", title: "Bash command", detail: "touch zz1.txt", selected: 1, fingerprint: anyPrint,
    description: "Create an empty marker file called zz1.txt in the current folder so that later experiments can confirm the file exists",
  });
  expect(choices(card)).toEqual([
    [1, "Yes"],
    [2, "Yes, and always allow access to /private/tmp/claude-501/shop-n80 from this project"],
    [3, "Yes, and switch to auto mode · auto mode handles these prompts for you"],
    [4, "No"],
  ]);
  expect(card.options.map((o) => !!o.secondary)).toEqual([false, true, true, false]);
  // The digit is the row's own, wrapped or not: the wrapped option 2 is not option 3.
  for (const o of [1, 2, 3, 4]) expect(claudeKeys(card, o)).toEqual([String(o)]);
  // Only a tip and a one-row description: the same layout, the tip alone wrapped.
  const short = claude("bash-permission-80col-short").dialog!;
  expect(short).toMatchObject({ kind: "permission", description: "Create empty file narrow.txt", detail: "touch narrow.txt" });
  expect(choices(short)[1]).toEqual([2, "Yes, and always allow access to /private/tmp/claude-501/shop-api from this project"]);
});

test("80 columns: a wrapped option that is not exactly a wrap is Screen's, never another option", () => {
  const cont = "      this project";
  const bash = "claude-bash-permission-80col";
  // Indented one short, or after a blank row: not the label's rows.
  screenOf("claude", mangled(bash, cont, "     this project"));
  screenOf("claude", mangled(bash, cont, "\n" + cont));
  // Looks like an option, numbered from another column: a wrapped label must never become the next choice.
  screenOf("claude", mangled(bash, cont, "      3. this project"));
  screenOf("claude", mangled(bash, cont, "   3. this project"));
  // A row under the label that is not at its indent.
  screenOf("claude", mangled(bash, cont, cont + "\n       always allow everything"));
  screenOf("claude", mangled(bash, cont, cont + "\n always allow everything"));
  // A tip that is not the tip, a description row without its `│`, or a row more than the description.
  screenOf("claude", mangled(bash, " \x1b[1mbelow\x1b[0m\n", " \x1b[1mbelow and more\x1b[0m\n"));
  screenOf("claude", mangled(bash, "\x1b[2m│\x1b[0m \x1b[38;5;246mlater", " \x1b[38;5;246mlater"));
  screenOf("claude", mangled(bash, " \x1b[1mbelow\x1b[0m\n", " \x1b[1mbelow\x1b[0m\n Warning: this command writes outside the project\n"));
  // The footer with a row more under it.
  screenOf("claude", mangled(bash, "Tab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mamend", "Tab\x1b[39m \x1b[38;5;246mto\x1b[39m \x1b[38;5;246mamend\n Something else"));
});

test("80 columns: Write and Edit prompts read their wrapped second option; the field of a No after Tab is the dialog's", () => {
  for (const [name, title] of [["write-permission-80col", "Create file"], ["edit-permission-80col", "Edit file"]] as const) {
    const card = claude(name).dialog!;
    expect(card).toMatchObject({ kind: "permission", title, selected: 1 });
    expect(choices(card)).toEqual([[1, "Yes"], [2, "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)"], [3, "No"]]);
    expect(card.options.map((o) => !!o.takesText)).toEqual([false, false, true]);
    expect(claudeKeys(card, 3)).toEqual(["3"]);
  }
  expect(claude("write-permission-80col").dialog!.detail).toBe("notes.txt\n 1 hello");
  // A wrapped label and a No row holding the user's words, Tab pressed: the same dialog read as a field.
  const field = claude("bash-permission-80col-field");
  expect(field).toMatchObject({ dialog: null, unrecognised: true, field: { text: "not now", fingerprint: anyPrint } });
  screenOf("claude", mangled("claude-bash-permission-80col-field", "      project", "     project"));
});

test("80 columns: a plan approval with its question wrapped is a card; its feedback row focused is its field", () => {
  const r = claude("plan-80col");
  expect(r.unrecognised).toBe(false);
  const card = r.dialog!;
  expect(card).toMatchObject({ kind: "plan", title: "Ready to code?", selected: 1 });
  expect(choices(card)).toEqual([[1, "Yes, and use auto mode"], [2, "Yes, manually approve edits"], [3, "Tell Claude what to change"]]);
  expect(card.detail).toContain("- Use the Write tool to create hello.txt in the working directory with the\n  single line");
  expect(claudeKeys(card, 2)).toEqual(["2"]);
  expect(claude("plan-80col-field").field).toEqual({ fingerprint: card.fingerprint, text: "" });
  // The question's second row changed, or the footer not the plan's: another dialog.
  screenOf("claude", mangled("claude-plan-80col", "\x1b[38;5;246mproceed?", "\x1b[38;5;246mcontinue?"));
  screenOf("claude", mangled("claude-plan-80col", "\x1b[38;5;246mctrl+g", "\x1b[38;5;246mctrl+h"));
  // A row under the footer that isn't its wrapped path: not the dialog.
  screenOf("claude", mangled("claude-plan-80col", "engelbart.md", "engelbart.md\n Something unrelated"));
  // The path itself wrapped onto a second row still is.
  expect(claude("plan-80col").dialog!.fingerprint).toBe(card.fingerprint);
  const wrapped = mangled("claude-plan-80col", "zany-swimming-engelbart.md", "zany-swimming-\n engelbart.md");
  expect(adapterFor("claude").readPane(wrapped).dialog?.kind).toBe("plan");
});

test("80 columns: a question with its title and descriptions wrapped is a card without the title's `│`; multi-select is Screen's, as it is wide", () => {
  const card = claude("question-80col").dialog!;
  expect(card).toMatchObject({ kind: "question", question: { at: 1, of: 2 }, selected: 1 });
  expect(card.title).toBe("Which database engine should the shop-api service use for its order history\ntables in production?");
  expect(card.options[0]).toEqual({
    index: 1, label: "PostgreSQL",
    description: "Mature relational database with strong transactional guarantees, JSON support and a very large ecosystem of tooling for migrations",
  });
  expect(card.options.map((o) => o.index)).toEqual([1, 2, 3, 4]);
  expect(claudeKeys(card, 2)).toEqual(["2"]);
  // A label that wraps is cut at its first row and the rest read as its description: shown so, but the digit is the row's.
  const single = claude("question-single-80col").dialog!;
  expect(single.options.map((o) => o.index)).toEqual([1, 2, 3, 4]);
  expect(claudeKeys(single, 1)).toEqual(["1"]);
  expect(claude("question-multi-80col")).toMatchObject({ dialog: null, unrecognised: true });
});

test("46 columns: Bash, Write and question dialogs wrap a path across rows and a footer over two; options keep their numbers", () => {
  const bash = claude("bash-permission-46col").dialog!;
  expect(bash).toMatchObject({ kind: "permission", detail: "touch zz1.txt", description: "Create an empty marker file called zz1.txt" });
  expect(choices(bash)).toEqual([
    [1, "Yes"],
    [2, "Yes, and always allow access to /private/tmp/claude-501/shop-n81/services/orders-service/src/main/java/com/example/shop/infrastructure from this project"],
    [3, "Yes, and switch to auto mode · auto mode handles these prompts for you"],
    [4, "No"],
  ]);
  for (const o of [1, 2, 3, 4]) expect(claudeKeys(bash, o)).toEqual([String(o)]);
  expect(choices(claude("write-permission-46col").dialog!).map(([i]) => i)).toEqual([1, 2, 3]);
  const question = claude("question-46col").dialog!;
  expect(question).toMatchObject({ kind: "question", title: "Pick a deployment strategy for the orders\nservice", question: { at: 1, of: 1 } });
  expect(choices(question).map(([i]) => i)).toEqual([1, 2, 3, 4]);
  // The footer's rows must still read as the footer.
  screenOf("claude", mangled("claude-question-46col", "cancel", "cancel it"));
  screenOf("claude", mangled("claude-bash-permission-46col", "amend", "amend now"));
});

test("80x24: a plan taller than the pane has lost its heading off the top, so it is Screen's", () => {
  screenOf("claude", raw("claude-plan-24rows"));
});

test("a trust question whose folder wraps across rows is a card with the whole path", () => {
  const card = claude("trust-80col").dialog!;
  expect(card).toMatchObject({ kind: "trust", detail: "/private/tmp/claude-501/shop-n81/services/orders-service/src/main/java/com/example/shop/infrastructure", selected: 1 });
  expect(choices(card)).toEqual([[2, "Yes, I trust this folder"], [1, "No, exit"]]);
});

test("Codex at 80 columns: an approval whose reason, command and option label wrap is a card; hotkeys still pick by row", () => {
  const short = codex("approval-80col").dialog!;
  expect(short).toMatchObject({ kind: "approval", selected: 1 });
  expect(short.detail).toBe("Environment: local\nReason: Do you want to allow creating the empty probe file here so later\nexperiments can confirm it exists in this folder?\n$ touch probe.txt");
  const card = codex("approval-80col-long").dialog!;
  expect(card).toMatchObject({ kind: "approval", selected: 1, fingerprint: anyPrint });
  expect(choices(card)).toEqual([
    [1, "Yes, proceed"],
    [2, "Yes, and don't ask again for commands that start with `touch probe-with-a-very-long-file-name-number-one.txt probe-with-a-very-long-file-name-number-two.txt probe-three.txt`"],
    [3, "No, and tell Codex what to do differently"],
  ]);
  expect(card.options.map((o) => !!o.secondary)).toEqual([false, true, false]);
  const keys = (o: number) => adapterFor("codex").keysFor(card, o, false)?.keys;
  expect([keys(1), keys(2), keys(3)]).toEqual([["y"], ["p"], ["Escape"]]);
});

test("Codex at 80 columns: rows that are not exactly a wrap are Screen's", () => {
  const long = "codex-approval-80col-long";
  const label = "     two.txt probe-three.txt`";
  const cmd = "  \x1b[38;2;205;214;244mprobe-with-a-very-long-file-name-number-two.txt probe-three.txt\x1b[39m";
  // A wrapped option label with its row indented one short, after a blank row, or without its hotkey.
  screenOf("codex", mangled(long, label, "    two.txt probe-three.txt`"));
  screenOf("codex", mangled(long, label, "\n" + label));
  screenOf("codex", mangled(long, "` (", "` ["));
  // A row that looks like an option, numbered from another column.
  screenOf("codex", mangled(long, label, "     3. two.txt probe-three.txt`"));
  // The command's wrapped row after a blank row, or a second command, or a wrapped row right under the header.
  screenOf("codex", mangled(long, cmd, "\n" + cmd));
  screenOf("codex", mangled(long, cmd, "  $ rm -rf x"));
  screenOf("codex", mangled("codex-approval-80col", "  Environment:", "  stray words\n  Environment:"));
  screenOf("codex", mangled("codex-approval-80col", "  \x1b[3mexperiments", "\n  \x1b[3mexperiments"));
});

test("a Codex trust question whose folder and question wrap at 80 columns is still a card", () => {
  // Codex asked for trust only in the 110-column lab; its 80-column wrap could not be produced, so this is that screen
  // rewrapped by hand (a long folder over two rows, the question over more).
  const text = raw("codex-trust").replace("/private/tmp/claude-501/shop-api", "/private/tmp/claude-501/shop-api/services/orders-service/src/main/java/com/example/shop/infrastruc\n  ture");
  const card = adapterFor("codex").readPane(text).dialog!;
  expect(card).toMatchObject({ kind: "trust", detail: "/private/tmp/claude-501/shop-api/services/orders-service/src/main/java/com/example/shop/infrastructure", selected: 1 });
  expect(choices(card)).toEqual([[1, "Trust and continue"], [2, "Back to Agent Command Center"]]);
});
