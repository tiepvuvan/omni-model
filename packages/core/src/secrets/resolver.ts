import { ConfigError } from "../errors.js";
import { ENCRYPTION_KEY_VARIABLE } from "./keyring.js";
import { isSecretRef, looksLikeSecretRef, type SecretStore } from "./types.js";

/**
 * Replace every `{"$secret": id}` in a configuration document with its value.
 *
 * Runs when a bundle is built, never when a document is stored — which is the
 * whole point: the stored revision, its history, its diffs and its audit trail
 * contain references, and plaintext exists only in the live bundle.
 *
 * Errors name the *path* to the offending reference but never a value, so a
 * rejected configuration is debuggable without leaking anything. A missing
 * secret is a hard failure rather than a silent empty string: a provider
 * configured with an empty key would fail confusingly on its first upstream
 * call instead of at reload time.
 */
export async function resolveSecretRefs(
  document: unknown,
  store: SecretStore | null,
): Promise<unknown> {
  const refs = new Map<string, string>();
  collectRefs(document, "$", refs);
  if (refs.size === 0) return document;

  if (store === null) {
    const paths = [...refs.values()].sort();
    throw new ConfigError(
      `configuration references ${refs.size} secret(s) but no secret store is available. ` +
        `Set ${ENCRYPTION_KEY_VARIABLE} and use PostgreSQL storage so secrets can be ` +
        `decrypted. References at: ${paths.join(", ")}`,
    );
  }

  const values = new Map<string, string>();
  for (const [id, path] of refs) {
    let value: string | null;
    try {
      value = await store.reveal(id);
    } catch (error) {
      // Includes the "key not in the keyring" case, whose message is actionable.
      throw new ConfigError(
        `${path}: could not decrypt secret "${id}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (value === null) {
      throw new ConfigError(
        `${path}: references unknown secret "${id}". It may have been deleted after this ` +
          "configuration was saved.",
      );
    }
    values.set(id, value);
  }

  return substitute(document, values);
}

/** First pass: find every reference, so all failures are reported before any read. */
function collectRefs(node: unknown, path: string, refs: Map<string, string>): void {
  if (isSecretRef(node)) {
    const extra = Object.keys(node).filter((key) => key !== "$secret");
    if (extra.length > 0) {
      throw new ConfigError(
        `${path}: a secret reference must contain only "$secret" (found ${extra.join(", ")})`,
      );
    }
    if (node.$secret.trim() === "") {
      throw new ConfigError(`${path}: secret reference has an empty id`);
    }
    // First path wins, which makes the error message deterministic when one
    // secret is referenced from several places.
    if (!refs.has(node.$secret)) refs.set(node.$secret, path);
    return;
  }
  if (looksLikeSecretRef(node)) {
    throw new ConfigError(
      `${path}: "$secret" must be a string id, e.g. {"$secret": "…"}. A malformed reference ` +
        "would otherwise be passed through as a plain object.",
    );
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      collectRefs(item, `${path}[${index}]`, refs);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectRefs(value, `${path}.${key}`, refs);
    }
  }
}

/** Second pass: rebuild the document with values in place of references. */
function substitute(node: unknown, values: Map<string, string>): unknown {
  if (isSecretRef(node)) {
    const value = values.get(node.$secret);
    // collectRefs already proved every reference resolves.
    if (value === undefined) throw new ConfigError(`unresolved secret "${node.$secret}"`);
    return value;
  }
  if (Array.isArray(node)) return node.map((item) => substitute(item, values));
  if (node !== null && typeof node === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = substitute(value, values);
    }
    return result;
  }
  return node;
}
