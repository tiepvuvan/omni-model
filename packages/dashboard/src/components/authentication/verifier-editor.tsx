import { useState } from "react";
import type { ComponentDescriptor, VerifierEntry } from "../../lib/api";
import { PREFERRED_VERIFIERS, preferredType } from "../../lib/preferred";
import { type OptionValues, SchemaForm } from "../schema-form";
import { Button, Callout, Modal, SelectField, TextField } from "../ui/primitives";

export interface VerifierEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent for a new verifier. */
  editing: { entry: VerifierEntry; index: number } | null;
  verifiers: readonly ComponentDescriptor[];
  labels: Record<string, string>;
  onSubmit: (entry: VerifierEntry) => Promise<void>;
}

/**
 * The form for one verifier.
 *
 * Entirely generated from the verifier factory's own options schema, published by
 * `GET /admin/api/meta`. Six built-in verifier types with quite different options
 * — a shared secret, a Firebase project id, an Apple team and key id — share this
 * one form, and a seventh added to the registry gets it without a change here.
 */
export function VerifierEditor({
  open,
  onOpenChange,
  editing,
  verifiers,
  labels,
  onSubmit,
}: VerifierEditorProps) {
  const fallbackType = preferredType(verifiers, PREFERRED_VERIFIERS);
  const seed = (): { type: string; name: string; options: OptionValues } => {
    if (editing === null) return { type: fallbackType, name: "", options: {} };
    const { type, name, ...options } = editing.entry;
    return { type, name: typeof name === "string" ? name : "", options };
  };

  const [state, setState] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const schema = verifiers.find((entry) => entry.type === state.type)?.optionsSchema ?? null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        type: state.type,
        ...state.options,
        ...(state.name.trim() === "" ? {} : { name: state.name.trim() }),
      });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The verifier could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing === null ? "Add a verifier" : `Edit the ${state.type} verifier`}
      description="Options come from the verifier's own schema, so this form accepts exactly what the proxy accepts."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error !== null ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}

        <SelectField
          label="Type"
          value={state.type}
          items={verifiers.map((entry) => ({
            value: entry.type,
            label: labels[entry.type] ?? entry.type,
          }))}
          onValueChange={(type) =>
            // Options are per type; keeping them across a change would submit keys
            // the new factory rejects as unrecognised.
            setState({ ...state, type, options: {} })
          }
        />

        <TextField
          label="Name"
          value={state.name}
          hint="Optional label, recorded on a request as the provider that authenticated it. Defaults to the type."
          onChange={(event) => setState({ ...state, name: event.target.value })}
        />

        <div className="border-t border-border pt-4">
          <SchemaForm
            schema={schema}
            values={state.options}
            omit={["type", "name"]}
            idPrefix={`verifier-${state.type}`}
            onChange={(options) => setState({ ...state, options })}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : editing === null ? "Add verifier" : "Save verifier"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
