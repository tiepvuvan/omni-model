import vendorOpenAi from "../../assets/vendor-openai.svg";
import vendorOpenAiCompatible from "../../assets/vendor-openai-compatible.svg";
import { cx } from "../ui/primitives";

/**
 * The glyph for each provider type, at the design's 24px.
 *
 * Only two: the Figma file draws OpenAI and OpenAI Compatible, and its design
 * system has no Anthropic or Gemini mark. Anthropic and Gemini therefore get the
 * same neutral monogram tile an embedder's own provider gets — drawing a vendor
 * logo from memory would put a wrong mark next to a real product name, which is
 * worse than not having one.
 */
export const VENDOR_ICONS: Record<string, string> = {
  openai: vendorOpenAi,
  "openai-compatible": vendorOpenAiCompatible,
};

/**
 * How each provider type is named to an operator.
 *
 * "OpenAI", not the file's "Open AI": that is a typo in the design, and shipping a
 * vendor's name misspelled is worse than deviating from it.
 */
export const VENDOR_TITLES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI Compatible",
  google: "Gemini",
};

/** What each one is for, in one line. */
const VENDOR_DETAILS: Record<string, string> = {
  openai: "api.openai.com — GPT models",
  anthropic: "api.anthropic.com — Claude models",
  google: "Google AI Studio — Gemini models",
  "openai-compatible": "Any OpenAI-shaped endpoint: Groq, Together, vLLM, Ollama",
};

/**
 * Pick where a rule sends its matches.
 *
 * A tiled picker rather than a dropdown: choosing a provider is choosing which
 * fields the card will then ask for, so it is worth seeing all four at once with
 * their marks. The order is deliberate — the two named vendors, then Gemini, then
 * the catch-all `openai-compatible`, which is the one you reach for when your
 * endpoint is not on the list.
 */
const ORDER = ["openai", "anthropic", "google", "openai-compatible"] as const;

export function ProviderPicker({
  available,
  value,
  onChange,
}: {
  /** Types the registry actually has, from `GET /meta`. */
  available: readonly string[];
  value: string;
  onChange: (type: string) => void;
}) {
  // Registry order for anything an embedder added, so a custom provider is still
  // reachable rather than silently missing.
  const types = [
    ...ORDER.filter((type) => available.includes(type)),
    ...available.filter((type) => !ORDER.includes(type as (typeof ORDER)[number])),
  ];

  return (
    <fieldset className="flex w-full flex-col gap-[8px]">
      <legend className="type-strong-13 text-foreground-primary">Provider</legend>
      <div className="grid w-full grid-cols-2 gap-[8px]">
        {types.map((type) => {
          const icon = VENDOR_ICONS[type];
          const selected = type === value;
          return (
            <button
              key={type}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(type)}
              className={cx(
                "flex items-center gap-[8px] rounded-[var(--radius-field)] border border-solid p-[10px] text-left",
                selected
                  ? "border-accent-primary bg-accent-subtle"
                  : "border-border bg-input-background hover:bg-item-selection",
              )}
            >
              {icon === undefined ? (
                // An embedder's own provider has no mark in the design system, so
                // it gets a neutral tile rather than a borrowed vendor's logo.
                <span
                  aria-hidden
                  className="flex size-[24px] shrink-0 items-center justify-center rounded-[6px] bg-item-selection type-strong-12 text-foreground-secondary"
                >
                  {type.charAt(0).toUpperCase()}
                </span>
              ) : (
                <img src={icon} alt="" aria-hidden className="size-[24px] shrink-0" />
              )}
              <span className="flex min-w-0 flex-col">
                <span className="type-strong-14 text-foreground-primary">
                  {VENDOR_TITLES[type] ?? type}
                </span>
                <span className="truncate type-label-12 text-foreground-secondary">
                  {VENDOR_DETAILS[type] ?? type}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
