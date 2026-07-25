/**
 * A reference to a stored secret, used in configuration where a value would go:
 *
 * ```json
 * { "providers": { "openai": { "type": "openai", "apiKey": { "$secret": "…" } } } }
 * ```
 *
 * References are what make a configuration revision safe to store, diff, export
 * and roll back: the document names a credential without containing it.
 */
export interface SecretRef {
  $secret: string;
}

/** Everything about a secret except its value. Safe to return over HTTP. */
export interface SecretDescription {
  id: string;
  name: string;
  /** Last few characters, e.g. `…a1b2`. Empty for short values. */
  hint: string;
  /** Stable digest; equal fingerprints mean equal values. */
  fingerprint: string;
  /** Id of the master key this is currently sealed under. */
  keyId: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/**
 * Encrypted storage for credentials.
 *
 * The asymmetry is deliberate: everything here is safe to expose over an admin
 * API **except** {@link SecretStore.reveal}, which is the single path to
 * plaintext and exists only so a bundle can be built. An admin API must never
 * call it — that is what "write-only" means in practice.
 */
export interface SecretStore {
  readonly type: string;

  /**
   * Store `value` under `name`, replacing any existing secret with that name
   * while keeping its id — so configurations referencing it keep working when a
   * credential is rotated.
   */
  put(name: string, value: string): Promise<SecretDescription>;

  /**
   * The plaintext, or null when the id is unknown.
   *
   * Only the bundle builder should call this. It is named to be conspicuous in
   * review for exactly that reason.
   */
  reveal(id: string): Promise<string | null>;

  describe(id: string): Promise<SecretDescription | null>;
  describeByName(name: string): Promise<SecretDescription | null>;
  list(): Promise<SecretDescription[]>;
  /** Returns whether a secret was removed. */
  delete(id: string): Promise<boolean>;

  /**
   * Re-seal every secret under the keyring's active key, returning how many
   * changed. Safe to call repeatedly; already-current secrets are skipped.
   */
  rotate(): Promise<{ rotated: number; total: number }>;

  close?(): Promise<void>;
}

/**
 * A stored row, as a backend persists it. Contains no plaintext.
 *
 * The sealed value is one opaque string (a JWE), so a backend needs a single
 * text column and no knowledge of how it is framed. There is deliberately no
 * `keyId` column: which key sealed a value is in the JWE header, and a
 * projection that can disagree with the ciphertext is worse than a parse.
 */
export interface SecretRow {
  id: string;
  name: string;
  /** JWE compact serialization. See `sealSecret`. */
  jwe: string;
  hint: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Row persistence for {@link SecretStore}, with no knowledge of cryptography.
 *
 * Splitting it this way means the encryption lives in exactly one place, so a
 * new backend cannot get the crypto subtly wrong — it only has to store text.
 */
export interface SecretRowStore {
  upsert(row: SecretRow): Promise<void>;
  findById(id: string): Promise<SecretRow | null>;
  findByName(name: string): Promise<SecretRow | null>;
  list(): Promise<SecretRow[]>;
  delete(id: string): Promise<boolean>;
  close?(): Promise<void>;
}

/** Whether `value` is a {@link SecretRef}. */
export function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $secret?: unknown }).$secret === "string"
  );
}

/** Whether `value` looks like a secret reference but is malformed. */
export function looksLikeSecretRef(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "$secret" in (value as Record<string, unknown>)
  );
}
