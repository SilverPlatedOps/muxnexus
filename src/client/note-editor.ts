/**
 * A note's editor: CodeMirror with markdown styled as it is typed
 * (live-markdown.ts), shaped like the textarea it replaced for the two places
 * that hold one, the window's note and the note opened from "All notes".
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { codeLanguages } from "./code-languages";
import { classHighlighter } from "@lezer/highlight";
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { livePreview, setFocus } from "./live-markdown";

export interface NoteEditorHooks {
  /** Aria label of the text. */
  label: string;
  /** The text was typed in: not on a load or a remote change. */
  onEdit(): void;
  onBlur(): void;
}

export interface NoteEditor {
  readonly el: HTMLElement;
  readonly value: string;
  readonly focused: boolean;
  /** A different note: its text, with an undo history of its own. */
  load(text: string): void;
  /** The same note, changed elsewhere: not undoable here, and not an edit. */
  replace(text: string): void;
  setReadOnly(on: boolean): void;
  setPlaceholder(text: string): void;
  focus(): void;
  /** Select `from`..`to` and bring it into view. */
  select(from: number, to: number): void;
}

/** Changes the code made, as opposed to the keyboard. */
const fromCode = Annotation.define<true>();

export function createNoteEditor(hooks: NoteEditorHooks): NoteEditor {
  const readOnly = new Compartment();
  const hint = new Compartment();
  let isReadOnly = false;
  let hintText = "";

  const extensions = () => [
    history(),
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    // A fenced block's language loads when one first appears; its tokens get
    // `tok-*` classes, coloured only inside code blocks (style.css).
    markdown({ base: markdownLanguage, codeLanguages }),
    syntaxHighlighting(classHighlighter),
    livePreview,
    EditorView.lineWrapping,
    // CodeMirror owns its root's class list: a class added by hand is dropped on the next update.
    EditorView.editorAttributes.of({ class: "note-editor" }),
    EditorView.contentAttributes.of({ "aria-label": hooks.label, spellcheck: "false" }),
    readOnly.of(EditorState.readOnly.of(isReadOnly)),
    hint.of(placeholderText(hintText)),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && u.transactions.some((t) => t.docChanged && !t.annotation(fromCode))) hooks.onEdit();
      if (u.focusChanged && !u.view.hasFocus) hooks.onBlur();
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ extensions: extensions() }) });

  return {
    el: view.dom,
    get value() { return view.state.doc.toString(); },
    get focused() { return view.hasFocus; },
    load(text) {
      view.setState(EditorState.create({ doc: text, extensions: extensions() }));
      // A new state starts unfocused; the editor may well have the keys.
      if (view.hasFocus) view.dispatch({ effects: setFocus.of(true) });
    },
    replace(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [fromCode.of(true), Transaction.addToHistory.of(false)],
      });
    },
    setReadOnly(on) {
      isReadOnly = on;
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(on)) });
    },
    setPlaceholder(text) {
      hintText = text;
      view.dispatch({ effects: hint.reconfigure(placeholderText(text)) });
    },
    focus: () => view.focus(),
    select(from, to) {
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    },
  };
}
