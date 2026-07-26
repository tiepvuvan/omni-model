/*
 * The editor API only — never `"monaco-editor"`, which is the package root and
 * pulls in the TypeScript, CSS, HTML and JSON language services with their four
 * web workers. CEL is a custom language with no language *service*, so none of
 * that is reachable code; importing the root took the bundle from 1MB to 14MB.
 * Types come from the root as a type-only import, which emits nothing.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { complete, diagnose, FUNCTIONS, KEYWORDS, NAMESPACES, ROOTS } from "./cel";

/**
 * Monaco, taught CEL.
 *
 * Registered once for the page rather than per editor instance: Monaco's language
 * registry is global, and registering a tokenizer or a completion provider twice
 * means every token is coloured twice and every completion appears twice.
 *
 * Everything language-specific comes from `cel.ts`, which is also what the tests
 * and the fact-parity check use — so the editor, the diagnostics and the
 * completion menu cannot disagree about what CEL is or what the router exposes.
 */
export const CEL_LANGUAGE = "omni-cel";

/** The dashboard's two Monaco themes, built from the design tokens. */
export const CEL_THEME_LIGHT = "omni-cel-light";
export const CEL_THEME_DARK = "omni-cel-dark";

let registered = false;

/**
 * Point Monaco at its worker.
 *
 * Only the base editor worker is needed — CEL is a custom language with no
 * language *service*, so none of the TypeScript, JSON or CSS workers are pulled
 * in. Setting this before the first `create` call avoids Monaco falling back to
 * loading a worker from a CDN path that does not exist here.
 */
function installWorker(): void {
  const scope = self as typeof self & { MonacoEnvironment?: monaco.Environment };
  scope.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
}

/** Token colours, keyed to the same names `cel.ts` produces. */
const TOKENS_LIGHT = [
  { token: "namespace.cel", foreground: "2c6eec" },
  { token: "function.cel", foreground: "7d59d6" },
  { token: "keyword.cel", foreground: "f92a82" },
  { token: "string.cel", foreground: "21b84c" },
  { token: "number.cel", foreground: "ee7e16" },
  { token: "operator.cel", foreground: "7b7980" },
  { token: "identifier.cel", foreground: "28262c" },
];

const TOKENS_DARK = [
  { token: "namespace.cel", foreground: "508cff" },
  { token: "function.cel", foreground: "b49cf0" },
  { token: "keyword.cel", foreground: "ed1772" },
  { token: "string.cel", foreground: "2dba55" },
  { token: "number.cel", foreground: "ef9440" },
  { token: "operator.cel", foreground: "808080" },
  { token: "identifier.cel", foreground: "d8d8d8" },
];

export function registerCel(): void {
  if (registered) return;
  registered = true;
  installWorker();

  monaco.languages.register({ id: CEL_LANGUAGE });

  /*
   * A Monarch tokenizer rather than `cel.ts`'s own `tokenize`.
   *
   * Monaco colours line by line through Monarch and has no hook that takes a flat
   * token list, so the grammar is expressed in its own terms. The two stay in step
   * because both read the *same* `ROOTS`, `FUNCTIONS` and `KEYWORDS` — the word
   * lists are the part that can drift, and they are shared.
   */
  monaco.languages.setMonarchTokensProvider(CEL_LANGUAGE, {
    keywords: [...KEYWORDS],
    namespaces: [...ROOTS],
    functions: FUNCTIONS.map((fn) => fn.name),
    tokenizer: {
      root: [
        [
          /[a-zA-Z_][\w]*/,
          {
            cases: {
              "@keywords": "keyword.cel",
              "@functions": "function.cel",
              "@namespaces": "namespace.cel",
              "@default": "identifier.cel",
            },
          },
        ],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.cel", next: "@string" }],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/'/, { token: "string.cel", next: "@stringSingle" }],
        [/\d+(\.\d+)?/, "number.cel"],
        [/[&|=!<>+\-*/%?:]+/, "operator.cel"],
        [/[()[\]{},.]/, "delimiter"],
        [/\s+/, "white"],
      ],
      string: [
        [/[^\\"]+/, "string.cel"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.cel", next: "@pop" }],
      ],
      stringSingle: [
        [/[^\\']+/, "string.cel"],
        [/\\./, "string.escape"],
        [/'/, { token: "string.cel", next: "@pop" }],
      ],
    },
  });

  monaco.languages.setLanguageConfiguration(CEL_LANGUAGE, {
    brackets: [
      ["(", ")"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.registerCompletionItemProvider(CEL_LANGUAGE, {
    // `.` so a namespace immediately offers its fields, which is the whole point
    // of a path-aware menu.
    triggerCharacters: ["."],
    provideCompletionItems: (model: monaco.editor.ITextModel, position: monaco.Position) => {
      const source = model.getValue();
      const caret = model.getOffsetAt(position);
      const { from, items } = complete(source, caret);
      const start = model.getPositionAt(from);

      return {
        suggestions: items.map((item) => ({
          label: item.label,
          detail: item.detail,
          kind: item.insert.endsWith("(")
            ? monaco.languages.CompletionItemKind.Function
            : item.insert.endsWith(".")
              ? monaco.languages.CompletionItemKind.Module
              : monaco.languages.CompletionItemKind.Field,
          insertText: item.insert,
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          // Accepting `request.` should chain straight into that namespace's
          // fields rather than requiring another keystroke.
          ...(item.insert.endsWith(".")
            ? { command: { id: "editor.action.triggerSuggest", title: "Suggest" } }
            : {}),
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(CEL_LANGUAGE, {
    provideHover: (model: monaco.editor.ITextModel, position: monaco.Position) => {
      const word = model.getWordAtPosition(position);
      if (word === null) return null;
      const namespace = NAMESPACES.find((entry) => entry.name === word.word);
      if (namespace !== undefined) {
        return { contents: [{ value: `**${namespace.name}** — ${namespace.detail}` }] };
      }
      const field = NAMESPACES.flatMap((entry) => entry.fields).find(
        (entry) => entry.name === word.word,
      );
      if (field !== undefined) {
        return { contents: [{ value: `**${field.name}**: \`${field.type}\` — ${field.detail}` }] };
      }
      const fn = FUNCTIONS.find((entry) => entry.name === word.word);
      return fn === undefined ? null : { contents: [{ value: fn.detail }] };
    },
  });

  monaco.editor.defineTheme(CEL_THEME_LIGHT, {
    base: "vs",
    inherit: true,
    rules: TOKENS_LIGHT,
    colors: {
      // `Background Grouped Container`, so the editor reads as the design's
      // expression box rather than as an embedded IDE.
      "editor.background": "#f5f5f5",
      "editorLineNumber.foreground": "#7b7980",
      "editor.lineHighlightBackground": "#ededed",
      "editorCursor.foreground": "#28262c",
    },
  });

  monaco.editor.defineTheme(CEL_THEME_DARK, {
    base: "vs-dark",
    inherit: true,
    rules: TOKENS_DARK,
    colors: {
      "editor.background": "#0d0e0f",
      "editorLineNumber.foreground": "#808080",
      "editor.lineHighlightBackground": "#232428",
      "editorCursor.foreground": "#d8d8d8",
    },
  });
}

/**
 * Put `cel.ts`'s diagnostics on the model as Monaco markers.
 *
 * `serverError` outranks the lexical ones: it comes from the API actually
 * compiling the expression, which is the only authority on whether it is valid.
 */
export function setMarkers(model: monaco.editor.ITextModel, serverError: string | null): void {
  const source = model.getValue();
  const lines = source.split("\n");
  const lastLine = lines.length;
  const lastColumn = (lines.at(-1)?.length ?? 0) + 1;

  const whole = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: lastLine,
    endColumn: lastColumn,
  };

  const markers: monaco.editor.IMarkerData[] =
    serverError != null && serverError !== ""
      ? [{ ...whole, message: serverError, severity: monaco.MarkerSeverity.Error }]
      : diagnose(source).map((entry) => ({
          ...whole,
          message: entry.message,
          severity:
            entry.severity === "error"
              ? monaco.MarkerSeverity.Error
              : monaco.MarkerSeverity.Warning,
        }));

  monaco.editor.setModelMarkers(model, CEL_LANGUAGE, markers);
}

export { monaco };
