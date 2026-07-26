import { Dialog } from "@base-ui-components/react/dialog";
import { Field } from "@base-ui-components/react/field";
import { Select } from "@base-ui-components/react/select";
import { Switch } from "@base-ui-components/react/switch";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useId } from "react";

/**
 * The styled surface over Base UI.
 *
 * Base UI ships behaviour and accessibility and no appearance, so this file is
 * where the Figma tokens get applied — once per control rather than at every use
 * site. Every colour is a `--color-*` custom property generated from the token
 * export, so a re-export changes the whole dashboard and a hardcoded hex here
 * would be the one thing that quietly stops matching.
 */

/** Join class names, dropping the falsy ones. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-field)] px-3 py-2 " +
  "text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 " +
  "whitespace-nowrap";

const BUTTON_VARIANTS = {
  primary: "bg-accent-primary text-accent-foreground hover:opacity-90",
  secondary:
    "bg-button-background text-foreground-primary border border-border hover:bg-item-selection",
  ghost: "text-foreground-secondary hover:bg-item-selection hover:text-foreground-primary",
  destructive: "bg-destructive text-accent-foreground hover:opacity-90",
} as const;

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: keyof typeof BUTTON_VARIANTS;
}

export function Button({ variant = "secondary", className, type, ...props }: ButtonProps) {
  return (
    <button
      // A button inside a form defaults to `submit`, which turns a "cancel" or a
      // "remove row" into an accidental save. Opt in explicitly instead.
      type={type ?? "button"}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
      {...props}
    />
  );
}

const CONTROL =
  "w-full rounded-[var(--radius-field)] border border-border bg-input-background " +
  "px-3 py-2 text-sm text-foreground-primary placeholder:text-foreground-secondary " +
  "disabled:opacity-50";

export interface TextFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "children"> {
  label: string;
  /** Rendered under the control; the *why*, not a repeat of the label. */
  hint?: ReactNode;
  error?: string | null;
  /** Renders in `Geist Mono` — for expressions, ids and model names. */
  mono?: boolean;
}

export function TextField({ label, hint, error, mono, className, ...props }: TextFieldProps) {
  return (
    <Field.Root className="flex flex-col gap-1.5">
      <Field.Label className="text-sm font-medium text-foreground-primary">{label}</Field.Label>
      <Field.Control
        className={cx(
          CONTROL,
          mono === true && "font-mono",
          error != null && "border-destructive",
          className,
        )}
        {...props}
      />
      {hint !== undefined && error == null ? (
        <Field.Description className="text-xs text-foreground-secondary">{hint}</Field.Description>
      ) : null}
      {error != null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Field.Root>
  );
}

export interface TextAreaFieldProps extends ComponentPropsWithoutRef<"textarea"> {
  label: string;
  hint?: ReactNode;
  mono?: boolean;
}

export function TextAreaField({ label, hint, mono, className, id, ...props }: TextAreaFieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      {/*
       * `htmlFor` rather than a wrapping label, and the hint outside it. A hint
       * nested inside the label becomes part of the field's accessible name, so a
       * screen reader announces the whole explanation as the field's title.
       */}
      <label htmlFor={controlId} className="text-sm font-medium text-foreground-primary">
        {label}
      </label>
      <textarea
        id={controlId}
        className={cx(CONTROL, mono === true && "font-mono", className)}
        {...(hint === undefined ? {} : { "aria-describedby": hintId })}
        {...props}
      />
      {hint !== undefined ? (
        <p id={hintId} className="text-xs text-foreground-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  items: readonly { value: T; label: string }[];
  hint?: ReactNode;
  id?: string;
}

export function SelectField<T extends string>({
  label,
  value,
  onValueChange,
  items,
  hint,
  id,
}: SelectFieldProps<T>) {
  const current = items.find((item) => item.value === value);
  return (
    <Field.Root className="flex flex-col gap-1.5">
      <Field.Label className="text-sm font-medium text-foreground-primary">{label}</Field.Label>
      <Select.Root
        items={items as { value: T; label: string }[]}
        value={value}
        onValueChange={(next) => onValueChange(next as T)}
      >
        <Select.Trigger
          id={id}
          className={cx(CONTROL, "flex items-center justify-between text-left")}
        >
          <Select.Value>{current?.label ?? value}</Select.Value>
          <Select.Icon aria-hidden className="text-foreground-secondary">
            ▾
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} className="z-50">
            <Select.Popup className="min-w-[12rem] rounded-[var(--radius-field)] border border-border bg-menu-background p-1 shadow-lg">
              {items.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  className="flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm text-foreground-primary data-[highlighted]:bg-item-selection"
                >
                  <Select.ItemIndicator className="text-accent-primary">✓</Select.ItemIndicator>
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      {hint !== undefined ? (
        <Field.Description className="text-xs text-foreground-secondary">{hint}</Field.Description>
      ) : null}
    </Field.Root>
  );
}

export interface ToggleFieldProps {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function ToggleField({ label, description, checked, onCheckedChange }: ToggleFieldProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground-primary">{label}</span>
        {description !== undefined ? (
          <span className="text-xs text-foreground-secondary">{description}</span>
        ) : null}
      </div>
      <Switch.Root
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
        className={cx(
          "relative h-6 w-10 shrink-0 rounded-full border border-border transition-colors",
          checked ? "bg-accent-primary" : "bg-item-selection",
        )}
      >
        <Switch.Thumb
          className={cx(
            "block h-4 w-4 rounded-full bg-background-l3 shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-1",
          )}
        />
      </Switch.Root>
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

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const CALLOUT_TONES = {
  warning: "border-yellow-subtle-foreground/30 bg-yellow-subtle text-yellow-subtle-foreground",
  danger: "border-red-subtle-foreground/30 bg-red-subtle text-red-subtle-foreground",
  info: "border-accent-subtle-foreground/30 bg-accent-subtle text-accent-subtle-foreground",
  success: "border-green-subtle-foreground/30 bg-green-subtle text-green-subtle-foreground",
} as const;

/**
 * A short block of consequence: a validation failure, or a save that succeeded
 * but produced a configuration that will not behave the way it reads.
 */
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
      className={cx("rounded-[var(--radius-field)] border px-3 py-2 text-sm", CALLOUT_TONES[tone])}
    >
      {title !== undefined ? <p className="font-medium">{title}</p> : null}
      {children}
    </div>
  );
}

/** A titled surface. Every editable group on a page is one of these. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("panel", className)}>
      {title !== undefined || actions !== undefined ? (
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex flex-col gap-1">
            {title !== undefined ? (
              <h2 className="text-sm font-semibold text-foreground-primary">{title}</h2>
            ) : null}
            {description !== undefined ? (
              <p className="text-xs text-foreground-secondary">{description}</p>
            ) : null}
          </div>
          {actions !== undefined ? <div className="flex gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? <div className="px-5 py-4">{children}</div> : null}
    </section>
  );
}

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onOpenChange, title, description, children, footer }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-dialog-backdrop/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-panel)] border border-border bg-background-l3 shadow-xl">
          <div className="flex flex-col gap-1 border-b border-border px-5 py-4">
            <Dialog.Title className="text-sm font-semibold text-foreground-primary">
              {title}
            </Dialog.Title>
            {description !== undefined ? (
              <Dialog.Description className="text-xs text-foreground-secondary">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          <div className="flex flex-col gap-4 px-5 py-4">{children}</div>
          {footer !== undefined ? (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
