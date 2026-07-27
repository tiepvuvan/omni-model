import { Checkbox as BaseCheckbox } from "@base-ui-components/react/checkbox";
import { Dialog } from "@base-ui-components/react/dialog";
import { Select } from "@base-ui-components/react/select";
import { Switch as BaseSwitch } from "@base-ui-components/react/switch";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useId } from "react";
import checkIcon from "../../assets/check.svg";
import tokenRemoveIcon from "../../assets/token-remove.svg";
import unfoldMoreIcon from "../../assets/unfold-more.svg";

/**
 * The design system, transcribed from Figma.
 *
 * Every number here is a value from the file rather than a rounded-off
 * equivalent: a control is `rounded-[10px]`, not `rounded-lg`, and a button is a
 * 23px pill at every size. Tailwind's own scale is deliberately avoided for
 * anything the design specifies, because `p-2.5` and `p-[10px]` agreeing today
 * is a coincidence — the token is the spec.
 *
 * Base UI supplies behaviour and accessibility and no appearance, so this is the
 * only file that paints.
 */

/** Join class names, dropping the falsy ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ Button */

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-[var(--radius-pill)] border border-solid " +
  "transition-colors disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap";

/**
 * Primary carries a translucent white inner border over the accent fill — a
 * detail that reads as a subtle bevel and disappears if you substitute a plain
 * border colour.
 */
const BUTTON_STYLES = {
  primary: "bg-accent-primary border-white/30 text-accent-foreground hover:brightness-95",
  secondary: "bg-button-background border-border text-foreground-primary hover:bg-item-selection",
  destructive: "bg-destructive border-white/30 text-accent-foreground hover:brightness-95",
} as const;

const BUTTON_SIZES = {
  /** `Large (Default)`: 12/8 padding, Button 14. */
  large: "px-[12px] py-[8px] type-strong-14",
  /** `Medium`: 8/6 padding, Button 12. */
  medium: "px-[8px] py-[6px] type-strong-12",
  /** Icon-only: a 28px square. */
  icon: "size-[28px] p-0 shrink-0",
} as const;

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: keyof typeof BUTTON_STYLES;
  size?: keyof typeof BUTTON_SIZES;
  /** 16px leading glyph; the design pulls the left padding in to 10px for it. */
  icon?: string;
}

export function Button({
  variant = "secondary",
  size = "large",
  icon,
  className,
  type,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      // A button inside a form defaults to `submit`, which turns a "cancel" or a
      // "remove row" into an accidental save. Opt in explicitly instead.
      type={type ?? "button"}
      className={cx(
        BUTTON_BASE,
        BUTTON_STYLES[variant],
        BUTTON_SIZES[size],
        icon !== undefined && size === "large" && "gap-[4px] pl-[10px] pr-[12px]",
        className,
      )}
      {...props}
    >
      {icon !== undefined ? (
        <img src={icon} alt="" aria-hidden className="size-[16px] shrink-0" />
      ) : null}
      {children}
    </button>
  );
}

/** An icon-only 28px button; the glyph is 14px inside it. */
export function IconButton({
  icon,
  label,
  className,
  ...props
}: Omit<ButtonProps, "icon" | "size" | "children"> & { icon: string; label: string }) {
  return (
    <Button size="icon" aria-label={label} className={className} {...props}>
      <img src={icon} alt="" aria-hidden className="size-[14px]" />
    </Button>
  );
}

/* --------------------------------------------------------------- TextInput */

/** The control box shared by every input variant. */
const CONTROL =
  "flex w-full items-center rounded-[var(--radius-field)] border border-solid border-border " +
  "bg-input-background text-foreground-primary type-copy-14 disabled:opacity-50";

/**
 * The id of a field's help text, so a control can point at it.
 *
 * Help has to be an accessible *description*, never part of the name: nesting it
 * inside the label is what makes a screen reader announce the whole explanation
 * as the field's title.
 */
const describedBy = (controlId: string, has: boolean): { "aria-describedby"?: string } =>
  has ? { "aria-describedby": `${controlId}-help` } : {};

/** A field: label above, control, help text below. Gaps are 8px throughout. */
function Field({
  label,
  htmlFor,
  help,
  error,
  children,
  className,
}: {
  label?: string;
  htmlFor: string;
  help?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex w-full flex-col gap-[8px]", className)}>
      {label !== undefined ? (
        <label htmlFor={htmlFor} className="type-strong-13 w-full text-foreground-primary">
          {label}
        </label>
      ) : null}
      {children}
      {error != null ? (
        <p id={`${htmlFor}-help`} role="alert" className="type-label-12 w-full text-destructive">
          {error}
        </p>
      ) : help !== undefined ? (
        <p id={`${htmlFor}-help`} className="type-label-12 w-full text-foreground-secondary">
          {help}
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "children"> {
  label?: string;
  help?: ReactNode;
  error?: string | null;
  mono?: boolean;
}

export function TextField({ label, help, error, mono, className, id, ...props }: TextFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <Field
      {...(label === undefined ? {} : { label })}
      htmlFor={controlId}
      {...(help === undefined ? {} : { help })}
      {...(error === undefined ? {} : { error })}
    >
      <input
        id={controlId}
        {...describedBy(controlId, help !== undefined || error != null)}
        className={cx(
          CONTROL,
          "gap-[6px] p-[10px]",
          mono === true && "type-mono-12",
          error != null && "border-destructive",
          className,
        )}
        {...props}
      />
    </Field>
  );
}

export interface TextAreaFieldProps extends ComponentPropsWithoutRef<"textarea"> {
  label?: string;
  help?: ReactNode;
  mono?: boolean;
}

export function TextAreaField({ label, help, mono, className, id, ...props }: TextAreaFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <Field
      {...(label === undefined ? {} : { label })}
      htmlFor={controlId}
      {...(help === undefined ? {} : { help })}
    >
      <textarea
        id={controlId}
        {...describedBy(controlId, help !== undefined)}
        className={cx(CONTROL, "gap-[6px] p-[10px]", mono === true && "type-mono-12", className)}
        {...props}
      />
    </Field>
  );
}

/**
 * A chip inside a `Tokens` input.
 *
 * Reads as one value in a list, with its own remove affordance — which is what
 * makes a comma-separated text box the wrong control for algorithms, app ids and
 * model names.
 */
export function InputToken({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center justify-center gap-[2px] rounded-[var(--radius-chip)] border border-solid border-border bg-background-l1 px-[6px] py-[4px] type-label-12 text-foreground-primary">
      {label}
      {onRemove !== undefined ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${label}`}>
          <img src={tokenRemoveIcon} alt="" aria-hidden className="size-[12px]" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * A list of values, entered one at a time and shown as chips.
 *
 * The control box grows to wrap, and typing commits on Enter — the design shows
 * chips, and a chip that cannot be removed individually is a text box wearing a
 * costume.
 */
export function TokensField({
  label,
  help,
  values,
  onChange,
  placeholder,
  id,
}: {
  label?: string;
  help?: ReactNode;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <Field
      {...(label === undefined ? {} : { label })}
      htmlFor={controlId}
      {...(help === undefined ? {} : { help })}
    >
      <div className={cx(CONTROL, "flex-wrap content-center gap-[6px] px-[10px] py-[8px]")}>
        {values.map((value) => (
          <InputToken
            key={value}
            label={value}
            onRemove={() => onChange(values.filter((entry) => entry !== value))}
          />
        ))}
        <input
          id={controlId}
          {...describedBy(controlId, help !== undefined)}
          className="min-w-[6ch] flex-1 bg-transparent outline-none type-copy-14"
          placeholder={values.length === 0 ? placeholder : ""}
          onKeyDown={(event) => {
            const input = event.currentTarget;
            const entered = input.value.trim();
            if (event.key === "Enter" && entered !== "") {
              event.preventDefault();
              if (!values.includes(entered)) onChange([...values, entered]);
              input.value = "";
              return;
            }
            // Backspace on an empty box removes the last chip, which is what
            // every tag input does and what a keyboard user reaches for.
            if (event.key === "Backspace" && input.value === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={(event) => {
            // Committing on blur too: a value typed and then clicked away from
            // is a value the operator meant to add.
            const entered = event.currentTarget.value.trim();
            if (entered === "") return;
            if (!values.includes(entered)) onChange([...values, entered]);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </Field>
  );
}

export interface SelectFieldProps<T extends string> {
  label?: string;
  value: T;
  onValueChange: (value: T) => void;
  items: readonly { value: T; label: string }[];
  help?: ReactNode;
  id?: string;
  className?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  onValueChange,
  items,
  help,
  id,
  className,
}: SelectFieldProps<T>) {
  const generated = useId();
  const controlId = id ?? generated;
  const current = items.find((item) => item.value === value);
  return (
    <Field
      {...(label === undefined ? {} : { label })}
      htmlFor={controlId}
      {...(help === undefined ? {} : { help })}
      {...(className === undefined ? {} : { className })}
    >
      <Select.Root
        items={items as { value: T; label: string }[]}
        value={value}
        onValueChange={(next) => onValueChange(next as T)}
      >
        <Select.Trigger
          id={controlId}
          {...describedBy(controlId, help !== undefined)}
          className={cx(CONTROL, "gap-[6px] p-[10px] text-left")}
        >
          <Select.Value className="flex-1 truncate">{current?.label ?? value}</Select.Value>
          <Select.Icon>
            <img src={unfoldMoreIcon} alt="" aria-hidden className="size-[20px] shrink-0" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} className="z-50">
            <Select.Popup className="min-w-[12rem] rounded-[var(--radius-field)] border border-solid border-border bg-menu-background p-[4px] shadow-lg">
              {items.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  className="flex cursor-default items-center gap-[6px] rounded-[6px] px-[8px] py-[6px] type-copy-14 text-foreground-primary data-[highlighted]:bg-item-selection"
                >
                  <Select.ItemIndicator className="flex size-[12px] shrink-0 items-center">
                    <img src={checkIcon} alt="" aria-hidden className="size-[12px]" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </Field>
  );
}

/* ---------------------------------------------------- Checkbox and Switch */

/**
 * An 18px checkbox. Checked is the accent fill with the same translucent white
 * inner border the primary button carries.
 */
export function Checkbox({
  label,
  checked,
  onCheckedChange,
  "aria-label": ariaLabel,
}: {
  label?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    /*
     * The visible text lives *inside* the control, not in a `<label>` beside it.
     *
     * Base UI renders `Checkbox.Root` as a `<button role="checkbox">`, which a
     * wrapping label does not name — so a label would look right, announce
     * nothing, and not even be clickable. With the text inside, the accessible
     * name comes from the content and the whole row toggles.
     */
    <BaseCheckbox.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      {...(label === undefined && ariaLabel !== undefined ? { "aria-label": ariaLabel } : {})}
      className={cx(
        "flex shrink-0 items-center",
        label === undefined
          ? "size-[18px]"
          : "gap-[8px] py-[6px] type-copy-14 text-foreground-primary",
      )}
    >
      <span
        className={cx(
          "flex size-[18px] shrink-0 items-center justify-center rounded-[var(--radius-check)] border border-solid",
          checked ? "border-white/30 bg-accent-primary" : "border-border bg-input-background",
        )}
      >
        <BaseCheckbox.Indicator className="flex items-center justify-center">
          <img src={checkIcon} alt="" aria-hidden className="size-[12px]" />
        </BaseCheckbox.Indicator>
      </span>
      {label}
    </BaseCheckbox.Root>
  );
}

/**
 * A single-choice control: the checkbox's shape, round, and never self-clearing.
 *
 * A real `<input type="radio">`, hidden behind the styled circle rather than
 * reimplemented. Not Base UI's `Radio`, which has to live inside a `RadioGroup`
 * wrapping every option — and these options are separate cards on the screen, so
 * the wrapper would have to own the cards. A native input in a `<label>` gets the
 * grouping, the arrow-key behaviour and the accessible name for free, which is
 * more than a `role="radio"` button would have carried.
 *
 * `onSelect` rather than `onChange(boolean)`: a radio cannot be unticked, only
 * replaced, so there is no `false` to report.
 */
export function Radio({
  label,
  name,
  checked,
  onSelect,
}: {
  /** Names the control, and is read out. Kept short: "Use Firebase". */
  label: string;
  /** Groups the options, so arrow keys move between them. */
  name: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label className="flex shrink-0 cursor-default items-center gap-[8px] py-[6px] type-copy-14 text-foreground-primary">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cx(
          "flex size-[18px] shrink-0 items-center justify-center rounded-full border border-solid",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent-primary",
          checked ? "border-white/30 bg-accent-primary" : "border-border bg-input-background",
        )}
      >
        {checked ? <span className="size-[6px] rounded-full bg-accent-foreground" /> : null}
      </span>
      {label}
    </label>
  );
}

/** A 30×19 switch. The thumb is a 15px circle inset 2px. */
export function Switch({
  label,
  help,
  checked,
  onCheckedChange,
}: {
  label: string;
  /** Rendered under the row — never folded into the label, which names the control. */
  help?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <span className="flex w-full flex-col gap-[8px]">
      <span className="flex items-center gap-[8px] type-copy-14 text-foreground-primary">
        <BaseSwitch.Root
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={label}
          className={cx(
            "relative h-[19px] w-[30px] shrink-0 rounded-[48px] border border-solid transition-colors",
            checked ? "border-white/30 bg-accent-primary" : "border-border bg-item-selection",
          )}
        >
          <BaseSwitch.Thumb
            className={cx(
              "absolute top-[1px] block size-[15px] rounded-full bg-background-l3 shadow transition-[left]",
              checked ? "left-[13px]" : "left-[1px]",
            )}
          />
        </BaseSwitch.Root>
        {label}
      </span>
      {help !== undefined ? (
        <span className="type-label-12 text-foreground-secondary">{help}</span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------- Card */

/**
 * The surface everything on a screen sits in: white, 1px border, 16px radius.
 *
 * The header is `px-16 py-12` and separated by a border; the body is `p-16` with
 * a 16px gap. `actions` is the right-hand slot — an enable checkbox on the
 * authentication screen, an edit button on routing.
 */
export function Card({
  title,
  icon,
  actions,
  children,
  footer,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  /** A 20px (authentication) or 24px (routing) vendor glyph. */
  icon?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /**
   * A `px-16 py-12` strip below the body, separated by a border.
   *
   * The rate-limit screen's budget card has no header — the numbers are the whole
   * card — so its remove button lives here instead. Right-aligned like the header
   * slot it stands in for.
   */
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx(
        "flex flex-col items-start rounded-[var(--radius-card)] border border-solid border-border bg-background-l3",
        className,
      )}
    >
      {title !== undefined ? (
        <header className="flex w-full items-center justify-between border-b border-solid border-border px-[16px] py-[12px]">
          <div className="flex items-center gap-[8px]">
            {icon}
            <span className="type-strong-14 text-foreground-primary">{title}</span>
          </div>
          {actions}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className={cx("flex w-full flex-col gap-[16px] p-[16px]", bodyClassName)}>
          {children}
        </div>
      ) : null}
      {footer !== undefined ? (
        <footer className="flex w-full items-center justify-end border-t border-solid border-border px-[16px] py-[12px]">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------- Status and dialog */

const CALLOUT_TONES = {
  warning: "border-yellow-subtle-foreground/30 bg-yellow-subtle text-yellow-subtle-foreground",
  danger: "border-red-subtle-foreground/30 bg-red-subtle text-red-subtle-foreground",
  info: "border-accent-subtle-foreground/30 bg-accent-subtle text-accent-subtle-foreground",
  success: "border-green-subtle-foreground/30 bg-green-subtle text-green-subtle-foreground",
} as const;

/** A short block of consequence: a rejection, or a save that needs reading. */
export function Callout({
  tone = "info",
  title,
  children,
  role,
}: {
  tone?: keyof typeof CALLOUT_TONES;
  title?: string;
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className={cx(
        "w-full rounded-[var(--radius-field)] border border-solid px-[12px] py-[10px] type-copy-14",
        CALLOUT_TONES[tone],
      )}
    >
      {title !== undefined ? <p className="type-strong-14">{title}</p> : null}
      {children}
    </div>
  );
}

const BADGE_TONES = {
  neutral: "bg-item-selection text-foreground-secondary",
  accent: "bg-accent-subtle text-accent-subtle-foreground",
  success: "bg-green-subtle text-green-subtle-foreground",
  warning: "bg-yellow-subtle text-yellow-subtle-foreground",
  danger: "bg-red-subtle text-red-subtle-foreground",
} as const;

/** The design's badge: 18px pill, 6/2 padding, Strong/Label 12. */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center justify-center gap-[2px] rounded-[18px] px-[6px] py-[2px] type-strong-12",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-dialog-backdrop/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] border border-solid border-border bg-background-l3 shadow-xl">
          <div className="flex flex-col gap-[4px] border-b border-solid border-border px-[16px] py-[12px]">
            <Dialog.Title className="type-strong-14 text-foreground-primary">{title}</Dialog.Title>
            {description !== undefined ? (
              <Dialog.Description className="type-label-12 text-foreground-secondary">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          <div className="flex flex-col gap-[16px] p-[16px]">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * A modal panel that enters from the right edge.
 *
 * It keeps Base UI's focus trap, escape handling, backdrop dismissal, and
 * accessible title while matching the dashboard's flat bordered surfaces.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-dialog-backdrop/40" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-[min(680px,calc(100vw-24px))] animate-[activity-drawer-in_180ms_ease-out] flex-col border-l border-solid border-border bg-background-l3 shadow-xl">
          <div className="flex shrink-0 items-start justify-between gap-[16px] border-b border-solid border-border px-[20px] py-[16px]">
            <div className="min-w-0">
              <Dialog.Title className="type-heading-20 text-foreground-primary">
                {title}
              </Dialog.Title>
              {description !== undefined ? (
                <Dialog.Description className="mt-[4px] truncate type-label-12 text-foreground-secondary">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              className={cx(BUTTON_BASE, BUTTON_STYLES.secondary, BUTTON_SIZES.medium, "shrink-0")}
            >
              Close
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
