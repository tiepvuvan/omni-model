import { useEffect, useState } from "react";
import deleteIcon from "../../assets/delete.svg";
import type { RateLimitBudget, RateLimitRule } from "../../lib/api";
import { Card, IconButton, SelectField, TextField } from "../ui/primitives";

/**
 * The budget half of a rate-limit rule: how many tokens, per how long.
 *
 * Exactly what the design draws — a number and a window, no header, a footer
 * holding the remove button. There is nothing else to draw: a budget counts
 * prompt-plus-completion tokens, and it counts them per user. Neither is
 * configurable, so neither is a control.
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

const groups = new Intl.NumberFormat("en-US");

/** Digits only: the design shows `30,000`, and a paste may carry the separators. */
export function parseAmount(text: string): number {
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
export function AmountField({
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
  id?: string;
}) {
  const [text, setText] = useState(() => groups.format(value));

  // Adopt an outside change — a discard, or a reorder moving a different rule
  // into this card — without reformatting what is being typed.
  useEffect(() => {
    setText((now) => (parseAmount(now) === value ? now : groups.format(value)));
  }, [value]);

  return (
    <TextField
      {...(id === undefined ? {} : { id })}
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
  const budget: RateLimitBudget = rule.tokens;
  const windows =
    WINDOWS.some((option) => option.value === budget.window) || budget.window === ""
      ? WINDOWS
      : [...WINDOWS, { value: budget.window, label: budget.window }];

  return (
    <Card
      className="w-[408px] shrink-0 self-stretch"
      footer={
        onRemove === undefined ? undefined : (
          <IconButton icon={deleteIcon} label={`Remove ${label}`} onClick={onRemove} />
        )
      }
    >
      <AmountField
        id={`${idPrefix}-tokens-limit`}
        label="Number of tokens"
        help="Prompt plus completion, per user, counted after each response."
        value={budget.limit}
        onChange={(limit) => onChange({ ...rule, tokens: { ...budget, limit } })}
      />
      <SelectField
        id={`${idPrefix}-tokens-window`}
        label="Window"
        value={budget.window}
        items={windows}
        onValueChange={(window) => onChange({ ...rule, tokens: { ...budget, window } })}
        help="Clock-aligned, so the count resets at the boundary."
      />
    </Card>
  );
}
