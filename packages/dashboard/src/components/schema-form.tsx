import { useState } from "react";
import type { JsonSchema } from "../lib/api";
import { helpFor } from "../lib/help";
import { SelectField, Switch, TextAreaField, TextField, TokensField } from "./ui/primitives";

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
 * Controls are chosen to match the design's inventory: a string list is a
 * `Tokens` input with chips, a boolean is a switch, a free-form map is the one
 * place raw JSON is honest.
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
 * Turn `baseUrl` into "Base URL" the way the design labels it.
 *
 * The file uses real product casing — "API Key", "Base URL", "Project ID",
 * "JWKS URL", "Team ID" — not a mechanical de-camelCasing, so acronyms are
 * spelled out rather than sentence-cased into "Api key".
 */
const ACRONYMS = new Set([
  "api",
  "url",
  "urls",
  "id",
  "ids",
  "jwt",
  "jwks",
  "ttl",
  "pem",
  "ip",
  "ca",
]);

function labelFor(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      // Title Case every word, uppercasing the acronyms — "API Key", "Base URL",
      // "Project ID", "Team ID". That is how the design writes them, and a
      // generated label that capitalises differently from a designed one is the
      // inconsistency a generated form is supposed to avoid.
      return ACRONYMS.has(lower)
        ? lower.toUpperCase()
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
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
  /** Properties the surrounding UI owns; `type` and `name` are the usual ones. */
  omit?: readonly string[];
  /** Only render these properties, in this order. */
  only?: readonly string[];
  /** Prefix for generated input ids, so two forms on one page do not collide. */
  idPrefix: string;
  /**
   * The component type, e.g. `jwt` — the key for operator-facing help text.
   *
   * Without it a field falls back to the schema's own description, which is
   * written for a contributor reading the source rather than for someone
   * deciding what to type.
   */
  componentType: string;
}

export function SchemaForm({
  schema,
  values,
  onChange,
  omit = [],
  only,
  idPrefix,
  componentType,
}: SchemaFormProps) {
  const properties = schema?.properties;
  if (properties === undefined) {
    return (
      <p className="type-label-12 text-foreground-secondary">
        This component publishes no options schema, so there is nothing to configure here.
      </p>
    );
  }

  const required = new Set(schema?.required ?? []);
  const entries = (
    only === undefined
      ? Object.entries(properties)
      : [
          ...only.flatMap((name) => {
            const property = properties[name];
            return property === undefined ? [] : [[name, property] as [string, JsonSchema]];
          }),
          /*
           * A required option is never hidden, even when the curated list omits it.
           *
           * The design chooses which fields a card shows, and following that is
           * what makes the screen match. But a required field left off the screen
           * is a configuration nobody can complete — the save would fail with a
           * message about a field that is not on the page. So the curated order
           * wins, and anything required that it missed is appended.
           */
          ...Object.entries(properties).filter(
            ([name]) => required.has(name) && !only.includes(name),
          ),
        ]
  ).filter(([name]) => !omit.includes(name));

  if (entries.length === 0) {
    return (
      <p className="type-label-12 text-foreground-secondary">This component takes no options.</p>
    );
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
    <>
      {entries.map(([name, property]) => (
        <SchemaField
          key={name}
          name={name}
          schema={property}
          value={values[name]}
          required={required.has(name)}
          componentType={componentType}
          id={`${idPrefix}-${name}`}
          onChange={(value) => set(name, value)}
        />
      ))}
    </>
  );
}

function SchemaField({
  name,
  schema,
  value,
  required,
  componentType,
  id,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  required: boolean;
  componentType: string;
  id: string;
  onChange: (value: unknown) => void;
}) {
  /*
   * Optional is marked, required is not.
   *
   * Marking the optional ones is the useful direction: on these screens most
   * fields are optional, so badging the minority that are required would leave
   * an operator unsure whether the rest are needed. "(optional)" answers the
   * question they actually have — can I leave this alone?
   */
  const label = required ? labelFor(name) : `${labelFor(name)} (optional)`;
  const help = helpFor(componentType, name, schema.description);

  if (isCredentialField(name)) {
    return <CredentialField label={label} help={help} value={value} id={id} onChange={onChange} />;
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
        {...(help === undefined ? {} : { help })}
      />
    );
  }

  const type = typeOf(schema);

  if (type === "boolean") {
    return (
      <Switch
        label={label}
        {...(help === undefined ? {} : { help })}
        checked={value === true || (value === undefined && schema.default === true)}
        onCheckedChange={onChange}
      />
    );
  }

  if (type === "array") {
    const values = Array.isArray(value) ? value.map(String) : [];
    return (
      <TokensField
        id={id}
        label={label}
        values={values}
        {...(help === undefined ? {} : { help })}
        onChange={(next) => onChange(next.length === 0 ? undefined : next)}
      />
    );
  }

  if (type === "object") {
    // A free-form map — `headers`, chiefly. There is no property list to render
    // fields from, so this is the one place raw JSON is the honest control.
    return <JsonField id={id} label={label} help={help} value={value} onChange={onChange} />;
  }

  if (type === "number" || type === "integer") {
    return (
      <TextField
        id={id}
        label={label}
        type="number"
        required={required}
        value={typeof value === "number" ? String(value) : ""}
        {...(help === undefined ? {} : { help })}
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
      {...(help === undefined ? {} : { help })}
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
  help,
  value,
  onChange,
}: {
  id: string;
  label: string;
  help: string | undefined;
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
      help={
        invalid
          ? "This is not valid JSON yet, so it has not been applied."
          : (help ?? "JSON object.")
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
  help,
  value,
  id,
  onChange,
}: {
  label: string;
  help: string | undefined;
  value: unknown;
  id: string;
  onChange: (value: unknown) => void;
}) {
  const sealed = isSecretRef(value);
  const fromEnv = isEnvRef(value);
  const stored = sealed || fromEnv;

  return (
    <TextField
      id={id}
      label={label}
      type="password"
      autoComplete="off"
      // A stored credential is unreadable by design, so there is nothing to
      // prefill. The placeholder is what tells the operator that blank is safe.
      placeholder={stored ? "•••••••• stored — leave blank to keep" : "sk_"}
      value={typeof value === "string" && !fromEnv ? value : ""}
      help={
        sealed
          ? "Sealed in encrypted storage. It is not readable from here or from the API."
          : fromEnv
            ? `Resolved from the environment: ${String(value)}`
            : (help ??
              "Typed in plaintext and sealed into encrypted storage before the revision is written.")
      }
      onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
    />
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
