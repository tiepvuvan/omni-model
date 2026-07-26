import type * as Monaco from "monaco-editor";
import { useEffect, useId, useRef, useState } from "react";
import validIcon from "../../assets/valid.svg";
import { cx } from "../ui/primitives";
import { diagnose } from "./cel";
import {
  CEL_LANGUAGE,
  CEL_THEME_DARK,
  CEL_THEME_LIGHT,
  monaco,
  registerCel,
  setMarkers,
} from "./cel-monaco";

/**
 * The condition editor: Monaco with the CEL language registered.
 *
 * Monaco brings what a hand-rolled overlay cannot — a squiggle under the offending
 * text, hover documentation, bracket matching, multi-cursor, and a completion
 * widget that behaves the way every other code editor does. The language itself
 * (tokens, completions, diagnostics) is `cel.ts`, shared with the tests and with
 * the fact-parity check against core's `RequestFacts`.
 *
 * The status line below is kept even though Monaco shows markers inline: a marker
 * explains *where*, and the line explains *what happens* — "this rule would
 * silently never fire" is the sentence that matters, and it should not need a
 * hover to find.
 */
export function CelEditor({
  value,
  onChange,
  id,
  serverError,
  ruleLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  /** A compile error from the API, which is the authority on syntax. */
  serverError?: string | null;
  ruleLabel: string;
}) {
  const generated = useId();
  const controlId = id ?? generated;
  const host = useRef<HTMLDivElement>(null);
  /**
   * Mount-time seeds, read once.
   *
   * Monaco is constructed with the value and the aria-label it should start from;
   * afterwards both are pushed in imperatively. Kept in refs so the mount effect
   * has no reactive dependency on either — depending on `value` would tear the
   * editor down and rebuild it on every keystroke.
   */
  const seed = useRef({ value, ruleLabel });
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** The latest `onChange`, so the mount-once listener never calls a stale one. */
  const notify = useRef(onChange);
  notify.current = onChange;
  const [ready, setReady] = useState(false);

  const diagnostics = diagnose(value);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  const catchAll = value.trim() === "true";

  // Mount once. Monaco owns its own DOM, so React must not render into it — hence
  // the empty dependency list and the imperative updates below.
  useEffect(() => {
    if (host.current === null) return;
    registerCel();

    const dark = document.documentElement.dataset.theme === "dark";
    const instance = monaco.editor.create(host.current, {
      value: seed.current.value,
      language: CEL_LANGUAGE,
      theme: dark ? CEL_THEME_DARK : CEL_THEME_LIGHT,
      // The design's expression box, not an IDE: no gutter furniture, no minimap.
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      minimap: { enabled: false },
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 0,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      scrollbar: { vertical: "auto", horizontal: "hidden", useShadows: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      // Geist Mono at the design's 12/16, so the box matches every other mono
      // surface on the screen.
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 16,
      padding: { top: 16, bottom: 16 },
      wordWrap: "on",
      // A routing condition is one expression; Tab belongs to the form, not to the
      // editor, so keyboard navigation out of the field still works.
      tabFocusMode: true,
      automaticLayout: true,
      contextmenu: false,
      quickSuggestions: { other: true, strings: false, comments: false },
      suggestSelection: "first",
      fixedOverflowWidgets: true,
      ariaLabel: `Condition for ${seed.current.ruleLabel}`,
    });

    editor.current = instance;
    setReady(true);

    const subscription = instance.onDidChangeModelContent(() => {
      notify.current(instance.getValue());
    });

    return () => {
      subscription.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      editor.current = null;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount once; updates are imperative.
  }, []);

  // Adopt an outside change — a discard, or a reorder that moves a different
  // expression into this instance — without disturbing the caret while typing.
  useEffect(() => {
    const instance = editor.current;
    if (instance === null) return;
    if (instance.getValue() !== value) instance.setValue(value);
  }, [value]);

  // Markers follow the text, the server's verdict, and the editor existing at all
  // — `ready` flips once after mount, which is what schedules the first push.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is read through the model.
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model == null) return;
    setMarkers(model, serverError ?? null);
  }, [value, serverError, ready]);

  // Monaco's theme is global, so a toggle has to be pushed into it.
  useEffect(() => {
    if (!ready) return;
    const apply = () =>
      monaco.editor.setTheme(
        document.documentElement.dataset.theme === "dark" ? CEL_THEME_DARK : CEL_THEME_LIGHT,
      );
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [ready]);

  return (
    <div className="flex w-full flex-col overflow-clip rounded-[var(--radius-card)] border border-solid border-border bg-background-grouped-container">
      <div ref={host} id={controlId} data-testid={`cel-${ruleLabel}`} className="h-[85px] w-full" />

      {/*
       * The status line, right-aligned as the design draws it. One line, most
       * severe wins: a compile error from the server outranks a lexical error,
       * which outranks the silent-failure warning.
       */}
      <div id={`${controlId}-status`} className="flex w-full flex-col items-end gap-[4px] p-[12px]">
        {serverError != null && serverError !== "" ? (
          <Status tone="error">{serverError}</Status>
        ) : errors.length > 0 ? (
          <Status tone="error">{errors[0]?.message}</Status>
        ) : warnings.length > 0 ? (
          <Status tone="warning">{warnings[0]?.message}</Status>
        ) : (
          <Status tone="ok">
            {catchAll ? "Catch-all — matches everything" : "Valid expression"}
          </Status>
        )}
      </div>
    </div>
  );
}

function Status({
  tone,
  children,
}: {
  tone: "ok" | "warning" | "error";
  children: React.ReactNode;
}) {
  return (
    <span
      role={tone === "ok" ? undefined : "status"}
      className={cx(
        "flex items-start gap-[4px] text-right type-strong-12",
        tone === "ok" && "text-success",
        tone === "warning" && "text-yellow-subtle-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {tone === "ok" ? (
        <img src={validIcon} alt="" aria-hidden className="mt-[1px] size-[16px] shrink-0" />
      ) : null}
      <span>{children}</span>
    </span>
  );
}
