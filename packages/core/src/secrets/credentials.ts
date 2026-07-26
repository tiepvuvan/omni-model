import { isSecretRef, type SecretRef, type SecretStore } from "./types.js";

/**
 * Configuration fields that hold a credential.
 *
 * These are the names a provider or verifier factory uses for something that
 * must never be written to `omni_config_revisions` in the clear. Kept in one
 * place because two things depend on the same list: the admin API, which seals
 * whatever arrives in one of these, and the documentation that tells operators
 * which fields get sealed.
 *
 * Matching by name rather than by schema annotation is a deliberate trade: it
 * means a *new* credential field on a third-party factory is only protected once
 * its name is added here, so the list is checked by a test against every
 * registered factory's options schema.
 */
export const CREDENTIAL_FIELDS: readonly string[] = [
  "apiKey",
  "secret",
  "jwtSecret",
  "privateKey",
  "serviceAccountKey",
];

/** Whether `field` names something that must be sealed before it is stored. */
export function isCredentialField(field: string): boolean {
  return CREDENTIAL_FIELDS.includes(field);
}

export interface SealCredentialsResult {
  /** The document with every plaintext credential replaced by a reference. */
  document: unknown;
  /** Paths that were sealed, for the audit log. Never their values. */
  sealed: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replace plaintext credentials with `{"$secret": id}` references, sealing each
 * value into `store` on the way.
 *
 * This is what lets an operator type an API key straight into a routing rule
 * while the stored revision still holds only a reference — so a revision dump, an
 * audit log or a rollback diff cannot leak it.
 *
 * Two behaviours matter:
 *
 * - An existing reference is **passed through untouched**. The dashboard reads a
 *   configuration back as references and re-sends them, so sealing them again
 *   would mint a new secret row on every save.
 * - Secret names are derived from the document path, and `SecretStore.put`
 *   reuses the row for a name. Editing a key in place therefore updates one row
 *   and keeps its id, rather than accumulating a row per edit — which is also
 *   what keeps every other configuration referencing that id working.
 *
 * `${VAR}` references are left alone: they are resolved from the environment at
 * bundle-build time and were never in the database to begin with.
 */
export async function sealCredentials(
  document: unknown,
  store: SecretStore,
  options: { namePrefix?: string } = {},
): Promise<SealCredentialsResult> {
  const sealed: string[] = [];
  const prefix = options.namePrefix ?? "config";

  const walk = async (node: unknown, path: string): Promise<unknown> => {
    if (isSecretRef(node)) return node;
    if (Array.isArray(node)) {
      return Promise.all(node.map((item, index) => walk(item, `${path}[${index}]`)));
    }
    if (!isRecord(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(node)) {
      const child = path === "" ? field : `${path}.${field}`;
      if (isCredentialField(field) && typeof value === "string" && value !== "") {
        if (looksLikeEnvReference(value)) {
          // Resolved from the environment at build time; nothing to seal, and
          // sealing it would store the literal "${VAR}" as a credential.
          out[field] = value;
          continue;
        }
        const description = await store.put(`${prefix}.${child}`, value);
        out[field] = { $secret: description.id } satisfies SecretRef;
        sealed.push(child);
        continue;
      }
      out[field] = await walk(value, child);
    }
    return out;
  };

  return { document: await walk(document, ""), sealed };
}

/** `${VAR}` or `${VAR:-default}`, the interpolation the loader resolves. */
function looksLikeEnvReference(value: string): boolean {
  return /^\$\{[^}]+\}$/.test(value.trim());
}
