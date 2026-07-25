import { ConfigError } from "../errors.js";
import { toBufferSource } from "./bytes.js";
import type { Keyring } from "./keyring.js";

/** AES-GCM standard nonce length. Never reused with the same key. */
const IV_BYTES = 12;

/** A sealed value, exactly as it is stored. */
export interface SealedSecret {
  /** AES-GCM output: ciphertext with the authentication tag appended. */
  ciphertext: Uint8Array;
  iv: Uint8Array;
  /** Which master key sealed this, so rotation does not need a migration pass. */
  keyId: string;
}

/**
 * Encrypt `plaintext` under the keyring's active key.
 *
 * `id` is bound as additional authenticated data, so a ciphertext cannot be
 * moved to a different secret row: swapping the bytes of `openai-key` into
 * `anthropic-key` fails to decrypt instead of silently succeeding. This is why
 * the id is generated before sealing and never changes afterwards.
 */
export async function sealSecret(
  keyring: Keyring,
  id: string,
  plaintext: string,
): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(id) },
    keyring.active.key,
    encoder.encode(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, keyId: keyring.active.id };
}

/**
 * Decrypt a sealed value.
 *
 * Throws `ConfigError` when the recorded key is not in the keyring — which is
 * the recoverable case (the operator rotated a key out too early, and the fix is
 * to put it back in `OMNI_ENCRYPTION_KEY_PREVIOUS`). Tampering, a truncated row
 * or a mismatched id surface as a decryption failure from WebCrypto, which is
 * deliberately not softened: authenticated encryption failing means the data
 * cannot be trusted.
 */
export async function openSecret(
  keyring: Keyring,
  id: string,
  sealed: SealedSecret,
): Promise<string> {
  const master = keyring.find(sealed.keyId);
  if (master === undefined) {
    throw new ConfigError(
      `secret "${id}" was encrypted with key "${sealed.keyId}", which is not in the keyring. ` +
        `Add that key to OMNI_ENCRYPTION_KEY_PREVIOUS (comma-separated) to read it again. ` +
        `Keys currently loaded: ${keyring.keyIds().join(", ")}`,
    );
  }
  const encoder = new TextEncoder();
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(sealed.iv),
      additionalData: encoder.encode(id),
    },
    master.key,
    toBufferSource(sealed.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Last few characters of a value, for recognising *which* secret is set without
 * revealing it. Short values get no hint at all rather than most of themselves.
 */
export function secretHint(value: string): string {
  return value.length >= 8 ? `…${value.slice(-4)}` : "";
}

/**
 * Stable digest of a value, so an operator can tell whether two configurations
 * use the same credential and whether one changed.
 *
 * This is an unkeyed SHA-256 truncated to 64 bits: fine for the high-entropy API
 * keys it is meant for, but it does not hide a low-entropy value from someone
 * who can guess candidates. Not a substitute for the ciphertext.
 */
export async function secretFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toBufferSource(new TextEncoder().encode(value))),
  );
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
