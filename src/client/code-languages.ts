/**
 * The languages a note's code block is coloured in, named by its fence
 * (```java). A short list, bundled whole: the page is one bundle, and every
 * language CodeMirror knows would double it.
 */
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";

const lang = (name: string, alias: string[], support: () => LanguageSupport) =>
  LanguageDescription.of({ name, alias, load: async () => support() });
const legacy = (parser: StreamParser<unknown>) => () => new LanguageSupport(StreamLanguage.define(parser));

export const codeLanguages = [
  lang("Java", ["java"], java),
  lang("JavaScript", ["js", "jsx", "mjs", "cjs"], () => javascript({ jsx: true })),
  lang("TypeScript", ["ts", "tsx"], () => javascript({ typescript: true, jsx: true })),
  lang("JSON", ["json", "jsonc"], json),
  lang("YAML", ["yml"], yaml),
  lang("SQL", ["psql", "postgres", "postgresql"], sql),
  lang("XML", ["pom", "svg"], xml),
  lang("HTML", ["htm", "vue"], html),
  lang("CSS", ["scss"], css),
  lang("Python", ["py"], python),
  lang("Shell", ["sh", "bash", "zsh", "console"], legacy(shell)),
  lang("Diff", ["patch"], legacy(diff)),
  lang("Properties", ["ini", "env"], legacy(properties)),
];
