import { useState } from "react";
import type { ComponentDescriptor, RoutingRule } from "../../lib/api";
import { PREFERRED_PROVIDERS, preferredType } from "../../lib/preferred";
import { mergeCredentials, type OptionValues, SchemaForm } from "../schema-form";
import { Button, Callout, Modal, SelectField, TextAreaField, TextField } from "../ui/primitives";

/** `when: "true"` — the only expression the router treats as a catch-all. */
export const CATCH_ALL = "true";

/** A rule id has to survive being put in a URL path and read in a log line. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface RuleDraft {
  id: string;
  name: string;
  when: string;
  type: string;
  model: string;
  options: OptionValues;
}

/** Split a stored rule into the shape the form edits. */
export function draftFrom(rule: RoutingRule, index: number): RuleDraft {
  const { type, model, ...options } = rule.target;
  return {
    id: rule.id ?? `rules[${index}]`,
    name: rule.name ?? "",
    when: rule.when,
    type,
    model: model ?? "",
    options,
  };
}

export function emptyDraft(defaultType: string): RuleDraft {
  return { id: "", name: "", when: "", type: defaultType, model: "", options: {} };
}

/**
 * Assemble the `value` for `PUT /routing/rules/:id`.
 *
 * `model` is dropped when blank rather than sent empty: absent means "forward
 * whatever the client asked for", which is what a rule dispatching a family of
 * real model names wants, and `""` is not a model any upstream serves.
 */
export function ruleFrom(draft: RuleDraft, stored: OptionValues): Omit<RoutingRule, "id"> {
  const target = {
    type: draft.type,
    ...mergeCredentials(draft.options, stored),
    ...(draft.model.trim() === "" ? {} : { model: draft.model.trim() }),
  };
  return {
    when: draft.when.trim(),
    ...(draft.name.trim() === "" ? {} : { name: draft.name.trim() }),
    target,
  };
}

export function validateDraft(
  draft: RuleDraft,
  existingIds: readonly string[],
): Partial<Record<"id" | "when", string>> {
  const errors: Partial<Record<"id" | "when", string>> = {};
  if (draft.id.trim() === "") errors.id = "An id is required.";
  else if (!ID_PATTERN.test(draft.id.trim())) {
    errors.id = "Use lowercase letters, digits and hyphens.";
  } else if (existingIds.includes(draft.id.trim())) {
    errors.id = "Another rule already uses this id.";
  }
  if (draft.when.trim() === "") errors.when = "A condition is required — use true for a catch-all.";
  return errors;
}

export interface RuleEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new rule. */
  editing: { rule: RoutingRule; index: number } | null;
  providers: readonly ComponentDescriptor[];
  /** Ids already taken, excluding the rule being edited. */
  takenIds: readonly string[];
  onSubmit: (id: string, value: Omit<RoutingRule, "id">) => Promise<void>;
}

/**
 * The form for one routing rule.
 *
 * A rule is its condition plus where a match goes, and "where" now includes the
 * credential — so this form covers what used to be split across a providers
 * block and a route. The options half is generated from the provider factory's
 * own schema, so adding a provider type to the registry gives it a form here for
 * free.
 */
export function RuleEditor({
  open,
  onOpenChange,
  editing,
  providers,
  takenIds,
  onSubmit,
}: RuleEditorProps) {
  const fallbackType = preferredType(providers, PREFERRED_PROVIDERS);
  const [draft, setDraft] = useState<RuleDraft>(() =>
    editing === null ? emptyDraft(fallbackType) : draftFrom(editing.rule, editing.index),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // The modal is mounted once per open, so re-seeding on an `editing` change is
  // how switching rules without closing stays correct.
  const [seededFor, setSeededFor] = useState(editing?.rule.id ?? null);
  const key = editing?.rule.id ?? null;
  if (seededFor !== key) {
    setSeededFor(key);
    setDraft(editing === null ? emptyDraft(fallbackType) : draftFrom(editing.rule, editing.index));
    setTouched(false);
    setError(null);
  }

  const storedOptions = editing === null ? {} : draftFrom(editing.rule, editing.index).options;
  const errors = validateDraft(draft, takenIds);
  const schema = providers.find((entry) => entry.type === draft.type)?.optionsSchema ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(draft.id.trim(), ruleFrom(draft, storedOptions));
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The rule could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing === null ? "Add a routing rule" : `Edit ${draft.id}`}
      description="A rule is a condition and where a match goes — provider, credentials and model together."
    >
      {/*
       * `noValidate` with `required` still on the fields: the attributes keep the
       * semantics assistive technology reads, while the browser's own bubble is
       * suppressed in favour of messages that can actually help — "use true for a
       * catch-all" instead of "Please fill out this field".
       */}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {error !== null ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}

        <TextField
          label="Rule id"
          mono
          required
          value={draft.id}
          disabled={editing !== null}
          hint={
            editing === null
              ? "Identifies this rule in request logs and in the API. It cannot be changed later."
              : "Fixed: request logs already reference it."
          }
          error={touched ? (errors.id ?? null) : null}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
        />

        <TextField
          label="Name"
          value={draft.name}
          hint="Optional label shown as the route name in logs. Defaults to the id."
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />

        <TextAreaField
          label="Condition"
          mono
          rows={3}
          required
          value={draft.when}
          hint={
            draft.when.trim() === CATCH_ALL
              ? "Matches every request. Keep this rule last — nothing after it can ever fire."
              : "A CEL expression over request, user, client, device, http and now. Guard optional claims with has()."
          }
          onChange={(event) => setDraft({ ...draft, when: event.target.value })}
        />
        {touched && errors.when !== undefined ? (
          <p role="alert" className="-mt-2 text-xs text-destructive">
            {errors.when}
          </p>
        ) : null}

        <div className="border-t border-border pt-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-foreground-secondary">
            Target
          </p>
          <div className="flex flex-col gap-4">
            <SelectField
              label="Provider"
              value={draft.type}
              items={providers.map((entry) => ({ value: entry.type, label: entry.type }))}
              onValueChange={(type) =>
                // Options belong to a provider type; carrying them across a change
                // would submit keys the new factory rejects as unrecognised.
                setDraft({ ...draft, type, options: {} })
              }
            />

            <TextField
              label="Model"
              mono
              value={draft.model}
              hint="The upstream model to forward as. Leave blank to pass the client's model through unchanged."
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />

            <SchemaForm
              schema={schema}
              values={draft.options}
              omit={["type", "model"]}
              idPrefix={`rule-${draft.type}`}
              onChange={(options) => setDraft({ ...draft, options })}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : editing === null ? "Add rule" : "Save rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
