import { useEffect, useId, useRef, useState } from "react";
import { api, type ProviderEntry } from "../../lib/api";
import { cx } from "../ui/primitives";

/**
 * The upstream model, chosen from what the credential can actually serve.
 *
 * This is two things at once, and the second is the point. Asking the upstream for
 * its model list is the only way to populate a trustworthy dropdown — and the same
 * call proves the API key works, at the moment it is typed, instead of at the
 * moment a client's request fails in production. A key that is wrong shows up here
 * as "the upstream refused this key", not as an empty list.
 *
 * It stays a free-text field as well as a dropdown: an endpoint may serve a model
 * it does not advertise, a self-hosted server may have no discovery endpoint at
 * all, and blank is meaningful (forward the client's own model unchanged). A
 * dropdown that could not express those would be a downgrade.
 */
export function ModelField({
  provider,
  value,
  onChange,
}: {
  /** Named provider configuration used for model discovery. */
  provider: ProviderEntry | undefined;
  value: string;
  onChange: (model: string) => void;
}) {
  const id = useId();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; models: string[] }
    | { kind: "refused"; message: string }
    | { kind: "unavailable"; reason: string }
  >({ kind: "idle" });
  const [open, setOpen] = useState(false);

  /**
   * What the last lookup was for.
   *
   * Everything except `model` — the model is the *answer*, so including it would
   * re-ask the upstream on every keystroke in this very field.
   */
  const signature = JSON.stringify(provider);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    /*
     * Nothing to check until there is something to check *with*.
     *
     * Asking early is worse than not asking: the factory rejects an incomplete
     * target, and that rejection lands in this field as a red error about a value
     * the operator has not reached yet. `openai-compatible` needs its endpoint —
     * there is no default — and a key can be a sealed reference rather than a
     * string, which counts as supplied.
     */
    if (provider === undefined) {
      setState({ kind: "idle" });
      return;
    }
    const hasKey =
      typeof provider.apiKey === "string" ? provider.apiKey !== "" : provider.apiKey !== undefined;
    const hasEndpoint =
      provider.type !== "openai-compatible" ||
      (typeof provider.baseUrl === "string" && provider.baseUrl !== "");
    if (!hasEndpoint || (!hasKey && provider.type !== "openai-compatible")) {
      setState({ kind: "idle" });
      return;
    }
    if (asked.current === signature) return;

    const timer = setTimeout(() => {
      asked.current = signature;
      setState({ kind: "loading" });
      void api
        .listUpstreamModels(provider)
        .then((result) => {
          if (result.ok === false) {
            setState({
              kind: "refused",
              message:
                result.error ?? `The upstream refused this key (HTTP ${result.status ?? "error"}).`,
            });
            return;
          }
          if (result.ok === null) {
            setState({
              kind: "unavailable",
              reason: result.reason ?? "This provider cannot list models.",
            });
            return;
          }
          setState({ kind: "ok", models: result.models });
        })
        .catch((error: unknown) =>
          setState({
            kind: "refused",
            message: error instanceof Error ? error.message : "The check failed.",
          }),
        );
      // Debounced: a key is typed or pasted a character at a time, and each
      // intermediate value is a wrong key that would report as refused.
    }, 700);
    return () => clearTimeout(timer);
  }, [signature, provider]);

  const models = state.kind === "ok" ? state.models : [];
  const narrowed = models.filter((entry) =>
    value === "" ? true : entry.toLowerCase().includes(value.toLowerCase()),
  );
  /*
   * Falling back to the whole list when nothing matches.
   *
   * Filtering to zero is the wrong answer to "show me what I can pick": a value
   * from another provider, or a private model name, would hide the very list the
   * operator opened the field to see.
   */
  const matches = narrowed.length === 0 ? models : narrowed;
  const unknown = state.kind === "ok" && value !== "" && !models.includes(value);

  return (
    <div className="flex w-full flex-col gap-[8px]">
      <label htmlFor={id} className="type-strong-13 w-full text-foreground-primary">
        Model (optional)
      </label>

      <div className="relative">
        <input
          id={id}
          value={value}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-describedby={`${id}-help`}
          autoComplete="off"
          spellCheck={false}
          placeholder={provider?.type === "deepseek" ? "deepseek-v4-flash" : "gpt-4o-mini"}
          className="w-full rounded-[var(--radius-field)] border border-solid border-border bg-input-background p-[10px] type-mono-12 text-foreground-primary"
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // A click on an option must land before the list unmounts.
          onBlur={() => setTimeout(() => setOpen(false), 120)}
        />

        {open && matches.length > 0 ? (
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label="Models the upstream serves"
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-30 max-h-[200px] overflow-y-auto rounded-[var(--radius-field)] border border-solid border-border bg-menu-background p-[4px] shadow-lg"
          >
            {matches.slice(0, 60).map((entry) => (
              <button
                key={entry}
                type="button"
                role="option"
                aria-selected={entry === value}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(entry);
                  setOpen(false);
                }}
                className={cx(
                  "flex w-full items-center rounded-[6px] px-[8px] py-[6px] text-left type-mono-12 text-foreground-primary hover:bg-item-selection",
                  entry === value && "bg-item-selection",
                )}
              >
                {entry}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <p id={`${id}-help`} className="type-label-12 text-foreground-secondary">
        {state.kind === "loading" ? (
          "Checking the key and loading the model list…"
        ) : state.kind === "refused" ? (
          <span className="text-destructive">{state.message}</span>
        ) : state.kind === "unavailable" ? (
          `${state.reason} Type the model name.`
        ) : state.kind === "ok" ? (
          <>
            <span className="text-success">
              Key accepted — {models.length} model{models.length === 1 ? "" : "s"} available.
            </span>{" "}
            {unknown ? (
              <span className="text-yellow-subtle-foreground">
                “{value}” is not in the list. That is allowed — an endpoint can serve a model it
                does not advertise — but check the spelling.
              </span>
            ) : (
              "Leave blank to pass the client's own model through unchanged."
            )}
          </>
        ) : provider === undefined ? (
          "Choose a provider first."
        ) : provider.type === "openai-compatible" ? (
          "Configure the provider's base URL on the Providers page to load its models. Leave blank to pass the client's own model through unchanged."
        ) : (
          "Configure the provider's API key on the Providers page to load its models. Leave blank to pass the client's own model through unchanged."
        )}
      </p>
    </div>
  );
}
