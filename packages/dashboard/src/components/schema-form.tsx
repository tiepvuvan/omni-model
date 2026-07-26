import { useState } from "react";
import type { JsonSchema } from "../lib/api";
import { SelectField, TextAreaField, TextField, ToggleField } from "./ui/primitives";

/**
 * A form rendered from a component's own options schema.
 *
 * `GET /admin/api/meta` publishes each registered factory's zod schema as JSON
 * Schema, so this renders one form for all ten component types instead of ten
 * hand-written ones. The point is not brevity — it is that the form cannot drift
 * from what the factory accepts. A provider added by an embedder gets a working
 * form with no dashboard change, and a renamed option stops appearing here the
 * moment the factory stops accepting it.
 *
 * Unrecognised keywords degrade to a text input rather than failing: a
 * third-party factory may publish something this does not model, and the save
 * path validates with the real schema anyway.
 */

/**
 * Fields whose value is a credential.
 *
 * Kept in step with core's `CREDENTIAL_FIELDS` by `test/credential-fields.test.ts`
 * — duplicated rather than imported because importing core would pull hono, zod,
 * jose and the CEL engine into a browser bundle for the sake of one array.
 */
export const CREDENTIAL_FIELDS = [
  "apiKey",
  "secret",
  "jwtSecret",
  "privateKey",
  "serviceAccountKey",
] as const;

export function isCredentialField(name: string): boolean {
  return (CREDENTIAL_FIELDS as readonly string[]).includes(name);
}

/** A `{"$secret": id}` reference: a credential already sealed in the database. */
export function isSecretRef(value: unknown): value is { $secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $secret?: unknown }).$secret === "string"
  );
}

/** An `${ENV_VAR}` reference, resolved from the environment at bundle build. */
export function isEnvRef(value: unknown): boolean {
  return typeof value === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
}

/**
 * Turn `baseUrl` into "Base url" for a schema that publishes no title.
 *
 * Sentence case, not title case: the design system labels fields that way, and
 * a generated label that capitalises differently from a hand-written one is
 * exactly the kind of inconsistency a generated form is supposed to avoid.
 */
function labelFor(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const first = words[0] ?? name.toLowerCase();
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/** The schema's declared type, tolerating `["string","null"]` unions. */
function typeOf(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.find((entry) => entry !== "null") ?? "string";
  if (schema.type !== undefined) return schema.type;
  // zod emits `anyOf` for a union; the first non-null branch is close enough to
  // pick an input, and the server validates the real thing.
  const branch = schema.anyOf?.find((entry) => entry.type !== "null");
  return branch?.type === undefined ? "string" : String(branch.type);
}

export type OptionValues = Record<string, unknown>;

export interface SchemaFormProps {
  schema: JsonSchema | null;
  values: OptionValues;
  onChange: (values: OptionValues) => void;
  /** Properties the surrounding UI owns; `type` and `model` are the usual ones. */
  omit?: readonly string[];
  /** Prefix for generated input ids, so two forms on one page do not collide. */
  idPrefix: string;
}

export function SchemaForm({ schema, values, onChange, omit = [], idPrefix }: SchemaFormProps) {
  const properties = schema?.properties;
  if (properties === undefined) {
    return (
      <p className="text-xs text-foreground-secondary">
        This component publishes no options schema, so there is nothing to configure here.
      </p>
    );
  }

  const required = new Set(schema?.required ?? []);
  const entries = Object.entries(properties).filter(([name]) => !omit.includes(name));
  if (entries.length === 0) {
    return <p className="text-xs text-foreground-secondary">This component takes no options.</p>;
  }

  const set = (name: string, value: unknown) => {
    const next = { ...values };
    // An empty optional field must be absent, not `""` — a strictObject with a
    // `.min(1)` would reject the empty string where it accepts the key missing.
    if (value === undefined || value === "") delete next[name];
    else next[name] = value;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-4">
      {entries.map(([name, property]) => (
        <SchemaField
          key={name}
          name={name}
          schema={property}
          value={values[name]}
          required={required.has(name)}
          id={`${idPrefix}-${name}`}
          onChange={(value) => set(name, value)}
        />
      ))}
    </div>
  );
}

function SchemaField({
  name,
  schema,
  value,
  required,
  id,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  id: string;
  onChange: (value: unknown) => void;
}) {
  const label = labelFor(name);
  const hint = schema.description;

  if (isCredentialField(name)) {
    return <CredentialField label={label} hint={hint} value={value} id={id} onChange={onChange} />;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const items = schema.enum.map((entry) => ({ value: String(entry), label: String(entry) }));
    const current = typeof value === "string" ? value : String(schema.default ?? items[0]?.value);
    return (
      <SelectField
        id={id}
        label={label}
        items={items}
        value={current}
        onValueChange={onChange}
        {...(hint === undefined ? {} : { hint })}
      />
    );
  }

  const type = typeOf(schema);

  if (type === "boolean") {
    return (
      <ToggleField
        label={label}
        {...(hint === undefined ? {} : { description: hint })}
        checked={value === true || (value === undefined && schema.default === true)}
        onCheckedChange={onChange}
      />
    );
  }

  if (type === "array") {
    // One per line: these are model names, algorithms, audiences and issuers —
    // values that can legitimately contain a comma.
    const lines = Array.isArray(value) ? value.map(String).join("\n") : "";
    return (
      <TextAreaField
        id={id}
        label={label}
        mono
        rows={3}
        value={lines}
        hint={hint ?? "One per line."}
        onChange={(event) => {
          const parsed = event.target.value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "");
          onChange(parsed.length === 0 ? undefined : parsed);
        }}
      />
    );
  }

  if (type === "object") {
    // A free-form map — `headers`, chiefly. There is no property list to render
    // fields from, so this is the one place raw JSON is the honest control.
    return <JsonField id={id} label={label} hint={hint} value={value} onChange={onChange} />;
  }

  if (type === "number" || type === "integer") {
    return (
      <TextField
        id={id}
        label={label}
        type="number"
        required={required}
        value={typeof value === "number" ? String(value) : ""}
        {...(hint === undefined ? {} : { hint })}
        {...(schema.minimum === undefined ? {} : { min: schema.minimum })}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(undefined);
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : raw);
        }}
      />
    );
  }

  return (
    <TextField
      id={id}
      label={label}
      required={required}
      mono={name.endsWith("Url") || name === "model"}
      value={typeof value === "string" ? value : ""}
      {...(hint === undefined ? {} : { hint })}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A JSON object editor that keeps invalid text on screen.
 *
 * Parsing on every keystroke and discarding what does not parse would delete
 * characters as they are typed, since every partial object is invalid. So the
 * text is local state and only a successful parse is lifted.
 */
function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const serialized = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);

  // Adopt an outside change (a different rule selected into the same form)
  // without clobbering what is being typed.
  const [seen, setSeen] = useState(serialized);
  if (seen !== serialized && text === seen) {
    setSeen(serialized);
    setText(serialized);
  }

  return (
    <TextAreaField
      id={id}
      label={label}
      mono
      rows={4}
      value={text}
      hint={
        invalid
          ? "This is not valid JSON yet, so it has not been applied."
          : (hint ?? "JSON object.")
      }
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        if (next.trim() === "") {
          setInvalid(false);
          onChange(undefined);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(next);
          setInvalid(false);
          onChange(parsed);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

/**
 * A credential input that never shows a credential.
 *
 * The stored document holds a `{"$secret": id}` reference or a `${VAR}`
 * reference, and there is no endpoint that returns the plaintext — `reveal` is
 * deliberately unreachable from the admin API. So this reports *which* of those
 * is in place and leaves the box empty: typing a new value replaces it, and
 * leaving it blank keeps what is already stored.
 */
function CredentialField({
  label,
  hint,
  value,
  id,
  onChange,
}: {
  label: string;
  hint: string | undefined;
  value: unknown;
  id: string;
  onChange: (value: unknown) => void;
}) {
  const sealed = isSecretRef(value);
  const fromEnv = isEnvRef(value);
  const stored = sealed || fromEnv;

  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        id={id}
        label={label}
        type="password"
        autoComplete="off"
        // A stored credential is unreadable by design, so there is nothing to
        // prefill. The placeholder is what tells the operator that blank is safe.
        placeholder={stored ? "•••••••• stored — leave blank to keep" : ""}
        value={typeof value === "string" && !fromEnv ? value : ""}
        hint={
          hint ??
          (stored
            ? undefined
            : "Typed in plaintext and sealed into encrypted storage before the revision is written.")
        }
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
      />
      {sealed ? (
        <p className="text-xs text-foreground-secondary">
          Sealed in encrypted storage. It is not readable from here or from the API.
        </p>
      ) : null}
      {fromEnv ? (
        <p className="font-mono text-xs text-foreground-secondary">
          Resolved from the environment: {String(value)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Merge edited options over what was stored, keeping untouched credentials.
 *
 * A blank credential box means "leave it alone", and the only way to express
 * that to the API is to send the reference back unchanged. Dropping the key
 * instead would delete the credential; sending an empty string would fail the
 * factory's own validation.
 */
export function mergeCredentials(edited: OptionValues, stored: OptionValues): OptionValues {
  const merged = { ...edited };
  for (const field of CREDENTIAL_FIELDS) {
    const next = merged[field];
    const previous = stored[field];
    if (next !== undefined && next !== "") continue;

    if (isSecretRef(previous) || isEnvRef(previous) || typeof previous === "string") {
      merged[field] = previous;
    } else {
      // Untouched with nothing behind it. The key has to be *absent*: an empty
      // string is not a credential and a `.min(1)` field would reject it.
      delete merged[field];
    }
  }
  return merged;
}
