import { ConfigError } from "../errors.js";
import { toBufferSource } from "./bytes.js";

/** AES-256 needs exactly this many bytes of key material. */
const KEY_BYTES = 32;

/** Domain separator, so a key id is not a bare hash of key material. */
const KEY_ID_DOMAIN = "omni-model/secret-key-id/v1";

export const ENCRYPTION_KEY_VARIABLE = "OMNI_ENCRYPTION_KEY";
export const PREVIOUS_ENCRYPTION_KEY_VARIABLE = "OMNI_ENCRYPTION_KEY_PREVIOUS";

/** One master key, ready to use. */
export interface MasterKey {
  /** Short, stable, self-describing identifier stored alongside each ciphertext. */
  readonly id: string;
  readonly key: CryptoKey;
}

/**
 * The master keys this process can use.
 *
 * Rotation is additive and needs no migration pass: the active key encrypts
 * everything new, retired keys stay available for decryption, and each
 * ciphertext records which key sealed it. Re-encrypting existing rows is
 * therefore optional and can happen lazily.
 */
export interface Keyring {
  /** Key used to seal new secrets. */
  readonly active: MasterKey;
  /** Look up by the id recorded with a ciphertext. */
  find(keyId: string): MasterKey | undefined;
  /** Every key id, active first. Useful for reporting rotation progress. */
  keyIds(): string[];
}

function decodeBase64(value: string, variable: string): Uint8Array {
  // Accept base64url too: `openssl rand -base64 32` output pasted through a URL
  // or a k8s secret can arrive either way.
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  } catch {
    throw new ConfigError(
      `${variable} is not valid base64. Generate one with: openssl rand -base64 32`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKeyId(raw: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const domain = encoder.encode(KEY_ID_DOMAIN);
  const input = new Uint8Array(domain.length + raw.length);
  input.set(domain, 0);
  input.set(raw, domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toBufferSource(input)));
  return [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importMasterKey(value: string, variable: string): Promise<MasterKey> {
  const raw = decodeBase64(value, variable);
  if (raw.length !== KEY_BYTES) {
    throw new ConfigError(
      `${variable} must decode to exactly ${KEY_BYTES} bytes (got ${raw.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toBufferSource(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: await deriveKeyId(raw), key };
}

export interface CreateKeyringOptions {
  /** Base64 master key used for new encryptions. */
  active: string;
  /** Base64 keys accepted for decryption only, e.g. the key being rotated out. */
  previous?: readonly string[];
}

/** Build a keyring, or throw `ConfigError` explaining what is wrong with a key. */
export async function createKeyring(options: CreateKeyringOptions): Promise<Keyring> {
  const active = await importMasterKey(options.active, ENCRYPTION_KEY_VARIABLE);
  const byId = new Map<string, MasterKey>([[active.id, active]]);
  const order = [active.id];

  for (const value of options.previous ?? []) {
    if (value.trim() === "") continue;
    const key = await importMasterKey(value, PREVIOUS_ENCRYPTION_KEY_VARIABLE);
    // A repeated key is harmless; keeping the first occurrence keeps ids stable.
    if (byId.has(key.id)) continue;
    byId.set(key.id, key);
    order.push(key.id);
  }

  return {
    active,
    find: (keyId) => byId.get(keyId),
    keyIds: () => [...order],
  };
}

/**
 * Build a keyring from the environment, or return null when no key is set.
 *
 * Null is not an error: a deployment that never stores a secret needs no key.
 * It becomes an error only when a configuration actually references one, which
 * the resolver reports with the variable name to set.
 */
export async function keyringFromEnv(
  env: Record<string, string | undefined>,
): Promise<Keyring | null> {
  const active = env[ENCRYPTION_KEY_VARIABLE];
  if (active === undefined || active.trim() === "") return null;
  const previous = (env[PREVIOUS_ENCRYPTION_KEY_VARIABLE] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return createKeyring({ active, previous });
}
