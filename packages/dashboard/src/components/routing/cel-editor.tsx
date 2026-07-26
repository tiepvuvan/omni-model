import { useEffect, useId, useRef, useState } from "react";
import validIcon from "../../assets/valid.svg";
import { cx } from "../ui/primitives";
import { type Completion, complete, type Diagnostic, diagnose, tokenize } from "./cel";

/** One colour per token kind, from the design's palette. */
const TOKEN_COLOURS: Record<string, string> = {
  namespace: "text-accent-subtle-foreground",
  function: "text-violet-subtle-foreground",
  keyword: "text-pink-subtle-foreground",
  string: "text-green-subtle-foreground",
  number: "text-orange-subtle-foreground",
  operator: "text-foreground-secondary",
  punctuation: "text-foreground-secondary",
  identifier: "text-foreground-primary",
  unknown: "text-destructive",
  whitespace: "text-foreground-primary",
};

/**
 * A syntax-highlighted CEL editor with completion and live correctness.
 *
 * A real textarea under a painted overlay, rather than a `contenteditable`: the
 * textarea keeps native selection, undo, IME and screen-reader behaviour, and the
 * overlay only has to agree with it on font and box metrics. That is why both use
 * the same `type-mono-12` and the same padding — a mismatch shows up immediately
 * as drifting text.
 *
 * Correctness comes from two places. The instant half is lexical (brackets,
 * strings, unknown identifiers, and the unguarded-map-key trap). The authoritative
 * half is the server, which is the only thing that actually compiles CEL — passed
 * in as `serverError` by the screen that owns the draft.
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
  /** Named in the field's accessible label so a screen full of them is navigable. */
  ruleLabel: string;
}) {
  const generated = useId();
  const controlId = id ?? generated;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLPreElement>(null);

  const [menu, setMenu] = useState<{ from: number; items: Completion[]; active: number } | null>(
    null,
  );

  const diagnostics: Diagnostic[] = diagnose(value);
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const warnings = diagnostics.filter((entry) => entry.severity === "warning");
  const catchAll = value.trim() === "true";

  // The overlay does not scroll itself; it follows the textarea so a long
  // expression stays aligned with its highlighting.
  const syncScroll = () => {
    if (overlay.current !== null && textarea.current !== null) {
      overlay.current.scrollTop = textarea.current.scrollTop;
      overlay.current.scrollLeft = textarea.current.scrollLeft;
    }
  };

  // Runs after every render rather than on a value change: the overlay has to
  // re-follow the textarea whenever either could have moved, and `syncScroll`
  // reads refs only, so there is nothing to depend on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally every render.
  useEffect(syncScroll);

  const openMenu = (source: string, caret: number) => {
    const { from, items } = complete(source, caret);
    setMenu(items.length === 0 ? null : { from, items, active: 0 });
  };

  const accept = (item: Completion) => {
    const field = textarea.current;
    if (field === null || menu === null) return;
    const caret = field.selectionStart;
    const next = value.slice(0, menu.from) + item.insert + value.slice(caret);
    onChange(next);
    setMenu(null);
    // Put the caret after what was inserted, on the next frame so React has
    // already written the new value into the textarea.
    requestAnimationFrame(() => {
      const at = menu.from + item.insert.length;
      field.focus();
      field.setSelectionRange(at, at);
      // Inserting `request.` should immediately offer that namespace's fields —
      // the chained menu is most of what makes this feel like an editor.
      if (item.insert.endsWith(".")) openMenu(next, at);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu !== null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setMenu({
          ...menu,
          active: (menu.active + delta + menu.items.length) % menu.items.length,
        });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = menu.items[menu.active];
        if (item !== undefined) {
          event.preventDefault();
          accept(item);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(null);
        return;
      }
    }

    // Ctrl/Cmd-Space is the universal "what can go here" gesture.
    if (event.key === " " && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openMenu(value, event.currentTarget.selectionStart);
    }
  };

  const tokens = tokenize(value);

  return (
    <div className="flex w-full flex-col overflow-clip rounded-[var(--radius-card)] border border-solid border-border bg-background-grouped-container">
      <label className="sr-only" htmlFor={controlId}>
        Condition for {ruleLabel}
      </label>

      <div className="relative h-[85px] w-full">
        {/*
         * The painted copy. `aria-hidden` because the textarea over it already
         * carries the text — announcing both would read the expression twice.
         */}
        <pre
          ref={overlay}
          aria-hidden
          className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words p-[16px] type-mono-12"
        >
          {tokens.map((token) => (
            <span
              // Tokens have no identity across edits, but a start offset is unique
              // within one pass, which is all a key has to be.
              key={token.start}
              className={TOKEN_COLOURS[token.kind] ?? "text-foreground-primary"}
            >
              {token.value}
            </span>
          ))}
          {/* A trailing newline would otherwise not reserve a line in the overlay. */}
          {value.endsWith("\n") ? " " : null}
        </pre>

        <textarea
          ref={textarea}
          id={controlId}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${controlId}-status`}
          aria-invalid={errors.length > 0 || (serverError != null && serverError !== "")}
          placeholder={'request.model == "smart" && has(user.claims.tier)'}
          className="absolute inset-0 h-full w-full resize-none whitespace-pre-wrap break-words bg-transparent p-[16px] type-mono-12 text-transparent caret-foreground-primary outline-none placeholder:text-foreground-primary/30"
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onBlur={() => setMenu(null)}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next);
            openMenu(next, event.target.selectionStart);
          }}
        />

        {menu !== null ? (
          <div
            role="listbox"
            aria-label="Completions"
            className="absolute left-[16px] top-[calc(100%-8px)] z-30 max-h-[220px] w-[min(420px,calc(100%-32px))] overflow-y-auto rounded-[var(--radius-field)] border border-solid border-border bg-menu-background p-[4px] shadow-lg"
          >
            {menu.items.map((item, index) => (
              <button
                key={item.label}
                type="button"
                role="option"
                aria-selected={index === menu.active}
                // The textarea must keep focus, so the click cannot blur it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => accept(item)}
                className={cx(
                  "flex w-full flex-col items-start gap-[2px] rounded-[6px] px-[8px] py-[6px] text-left",
                  index === menu.active && "bg-item-selection",
                )}
              >
                <span className="type-mono-12 text-foreground-primary">{item.label}</span>
                <span className="type-label-12 text-foreground-secondary">{item.detail}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/*
       * The status line, right-aligned as the design draws it. One line, and the
       * most severe thing wins: a compile error from the server outranks a lexical
       * error, which outranks the silent-failure warning.
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
