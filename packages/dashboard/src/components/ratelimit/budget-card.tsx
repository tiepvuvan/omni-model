import { useEffect, useState } from "react";
import deleteIcon from "../../assets/delete.svg";
import type { RateLimitBudget, RateLimitKey, RateLimitRule } from "../../lib/api";
import { Button, Card, IconButton, SelectField, TextField } from "../ui/primitives";

/**
 * The budget half of a rate-limit rule: how much, per how long, counted per whom.
 *
 * The design draws one pair of fields — a number and a window — with no header, so
 * the numbers are the whole card. Two things it does not draw are here anyway,
 * because leaving them out would make the screen lie:
 *
 * - **A request budget.** A rule can limit requests, tokens, or both, and the
 *   configuration a fresh deployment starts with uses requests. Rendering only
 *   tokens would show an empty "Number of tokens" box for a rule that is actually
 *   enforcing 30 requests an hour.
 * - **What the count belongs to.** "30,000 tokens" means nothing until you know
 *   whether that is per user or across the whole deployment, and the difference is
 *   four orders of magnitude.
 */

/**
 * The windows the select offers.
 *
 * Windows are fixed and clock-aligned (`floor(now / window)`), so a "month" is a
 * 30-day bucket rather than a calendar one — hence the label. Anything the parser
 * accepts still round-trips: a stored value outside this list is appended to it
 * rather than replaced, so opening the screen cannot rewrite a window nobody
 * touched.
 */
const WINDOWS: readonly { value: string; label: string }[] = [
  { value: "1m", label: "1 minute" },
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "1d", label: "1 day" },
  { value: "7d", label: "1 week" },
  { value: "14d", label: "2 weeks" },
  { value: "30d", label: "1 month (30 days)" },
];

/** `key` values, in the order an operator is likely to want them. */
const KEYS: readonly { value: RateLimitKey; label: string }[] = [
  { value: "user", label: "Each user" },
  { value: "device", label: "Each device" },
  { value: "client", label: "Each client app" },
  { value: "ip", label: "Each IP address" },
  { value: "global", label: "Everyone together" },
];

const KEY_HELP: Record<RateLimitKey, string> = {
  user: "Per signed-in user, falling back to the device then the IP.",
  device: "Per device, falling back to the IP.",
  client: "Per client app — the write key that called.",
  ip: "Per IP address; everyone behind one NAT shares it.",
  global: "One budget for the whole deployment.",
  expression: "The counter key comes from the expression below.",
};

const groups = new Intl.NumberFormat("en-US");

/** Digits only: the design shows `30,000`, and a paste may carry the separators. */
function parseAmount(text: string): number {
  const digits = text.replace(/[^\d]/g, "");
  return digits === "" ? 0 : Number(digits);
}

/**
 * A grouped number field, as the design draws it (`30,000`, not `30000`).
 *
 * Formatting happens on blur rather than per keystroke: reformatting while typing
 * moves the caret to the end, which turns editing the middle of a number into a
 * fight. The value in the draft is always the parsed number, so what is shown and
 * what would be saved cannot diverge.
 */
function AmountField({
  label,
  help,
  value,
  onChange,
  id,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (value: number) => void;
  id: string;
}) {
  const [text, setText] = useState(() => groups.format(value));

  // Adopt an outside change — a discard, or a reorder moving a different rule
  // into this card — without reformatting what is being typed.
  useEffect(() => {
    setText((now) => (parseAmount(now) === value ? now : groups.format(value)));
  }, [value]);

  return (
    <TextField
      id={id}
      label={label}
      help={help}
      value={text}
      inputMode="numeric"
      autoComplete="off"
      error={value <= 0 ? "Enter a number greater than zero." : null}
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseAmount(event.target.value));
      }}
      onBlur={() => setText(groups.format(value))}
    />
  );
}

/** One budget: the number, then its window. */
function BudgetFields({
  kind,
  budget,
  onChange,
  idPrefix,
}: {
  kind: "tokens" | "requests";
  budget: RateLimitBudget;
  onChange: (budget: RateLimitBudget) => void;
  idPrefix: string;
}) {
  const windows =
    WINDOWS.some((option) => option.value === budget.window) || budget.window === ""
      ? WINDOWS
      : [...WINDOWS, { value: budget.window, label: budget.window }];

  return (
    <>
      <AmountField
        id={`${idPrefix}-${kind}-limit`}
        label={kind === "tokens" ? "Number of tokens" : "Number of requests"}
        help={
          kind === "tokens"
            ? "Prompt plus completion, counted after each response."
            : "A rejected request still counts against this."
        }
        value={budget.limit}
        onChange={(limit) => onChange({ ...budget, limit })}
      />
      <SelectField
        id={`${idPrefix}-${kind}-window`}
        label="Window"
        value={budget.window}
        items={windows}
        onValueChange={(window) => onChange({ ...budget, window })}
        help="Clock-aligned, so the count resets at the boundary."
      />
    </>
  );
}

export function BudgetCard({
  rule,
  onChange,
  onRemove,
  idPrefix,
  label,
}: {
  rule: RateLimitRule;
  onChange: (rule: RateLimitRule) => void;
  /** Absent for a rule with no condition — the design's Default row has no delete. */
  onRemove?: () => void;
  idPrefix: string;
  /** How the rule is named in an accessible label, e.g. `limit-1`. */
  label: string;
}) {
  const key = rule.key ?? "user";
  const keys = key === "expression" ? [...KEYS, { value: key, label: "Custom expression" }] : KEYS;

  /** Adding the missing budget kind; removing needs the other one to survive. */
  const setBudget = (kind: "tokens" | "requests", budget: RateLimitBudget | undefined) => {
    const next = { ...rule };
    if (budget === undefined) delete next[kind];
    else next[kind] = budget;
    onChange(next);
  };

  return (
    <Card
      className="w-[408px] shrink-0 self-stretch"
      footer={
        onRemove === undefined ? undefined : (
          <IconButton icon={deleteIcon} label={`Remove ${label}`} onClick={onRemove} />
        )
      }
    >
      {rule.tokens !== undefined ? (
        <BudgetFields
          kind="tokens"
          budget={rule.tokens}
          idPrefix={idPrefix}
          onChange={(tokens) => setBudget("tokens", tokens)}
        />
      ) : null}

      {rule.requests !== undefined ? (
        <BudgetFields
          kind="requests"
          budget={rule.requests}
          idPrefix={idPrefix}
          onChange={(requests) => setBudget("requests", requests)}
        />
      ) : null}

      <SelectField
        id={`${idPrefix}-key`}
        label="Counted per"
        value={key}
        items={keys}
        onValueChange={(next) => {
          const patch: RateLimitRule = { ...rule, key: next };
          // `keyExpression` only means something for `key: "expression"`; carrying
          // it across leaves a dead field in the stored document.
          if (next !== "expression") delete patch.keyExpression;
          onChange(patch);
        }}
        help={KEY_HELP[key]}
      />

      {key === "expression" ? (
        <TextField
          id={`${idPrefix}-key-expression`}
          label="Key expression"
          mono
          value={rule.keyExpression ?? ""}
          onChange={(event) => onChange({ ...rule, keyExpression: event.target.value })}
          help="A CEL expression producing the counter key. Its value is the budget's owner."
        />
      ) : null}

      {/*
       * Adding the other kind of budget. Only ever one button, because a rule
       * needs at least one budget to be valid — so the kind that is present has
       * no remove of its own until the other exists.
       */}
      <div className="flex w-full items-center gap-[8px]">
        {rule.tokens === undefined ? (
          <Button
            size="medium"
            onClick={() => setBudget("tokens", { limit: 30_000, window: "1d" })}
          >
            Add token budget
          </Button>
        ) : rule.requests !== undefined ? (
          <Button size="medium" onClick={() => setBudget("tokens", undefined)}>
            Remove token budget
          </Button>
        ) : null}

        {rule.requests === undefined ? (
          <Button size="medium" onClick={() => setBudget("requests", { limit: 30, window: "1h" })}>
            Add request limit
          </Button>
        ) : rule.tokens !== undefined ? (
          <Button size="medium" onClick={() => setBudget("requests", undefined)}>
            Remove request limit
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
