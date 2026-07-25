import { CompactEncrypt, compactDecrypt, decodeProtectedHeader } from "jose";
import { ConfigError } from "../errors.js";
import { toBufferSource } from "./bytes.js";
import type { Keyring } from "./keyring.js";

/**
 * Direct encryption with the master key: there is no per-secret content key to
 * wrap, because the keyring already gives us a 256-bit key per deployment.
 */
const ALG = "dir";
const ENC = "A256GCM";

/**
 * Protected-header parameter carrying the secret's id.
 *
 * Private name, since no registered JWE header means "the row this belongs to".
 */
const SECRET_ID_HEADER = "omni_sid";

/**
 * A sealed value: one JWE in compact serialization.
 *
 * `header.encrypted_key.iv.ciphertext.tag`, with an empty `encrypted_key`
 * because `alg` is `dir`. A single string rather than separate ciphertext/iv/tag
 * columns, and a format other tools already understand.
 */
export type SealedSecret = string;

/** The protected header we write, and the parts of it we read back. */
interface SealedHeader {
  kid?: unknown;
  [SECRET_ID_HEADER]?: unknown;
}

/**
 * Encrypt `plaintext` under the keyring's active key.
 *
 * `id` goes in the protected header, which JWE authenticates — so a ciphertext
 * cannot be moved to a different secret row. The check on the way out is an
 * equality comparison rather than a decryption failure (which is what binding
 * the id as `aad` would give), because compact serialization has no `aad` field.
 * It is equally strong: tampering with the header breaks the tag, so a header
 * that decrypts is a header the sealer wrote.
 */
export async function sealSecret(
  keyring: Keyring,
  id: string,
  plaintext: string,
): Promise<SealedSecret> {
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: ALG, enc: ENC, kid: keyring.active.id, [SECRET_ID_HEADER]: id })
    .encrypt(keyring.active.key);
}

/**
 * Decrypt a sealed value.
 *
 * Throws `ConfigError` when the recorded key is not in the keyring — the
 * recoverable case, where an operator rotated a key out too early and the fix is
 * to put it back. Tampering, truncation or a mismatched id surface as a
 * decryption failure, which is deliberately not softened: authenticated
 * encryption failing means the data cannot be trusted.
 */
export async function openSecret(
  keyring: Keyring,
  id: string,
  sealed: SealedSecret,
): Promise<string> {
  const { plaintext, protectedHeader } = await compactDecrypt(sealed, (header) => {
    const keyId = typeof header.kid === "string" ? header.kid : "";
    const master = keyring.find(keyId);
    if (master === undefined) {
      throw new ConfigError(
        `secret "${id}" was encrypted with key "${keyId}", which is not in the keyring. ` +
          "Add that key to OMNI_ENCRYPTION_KEY_PREVIOUS (comma-separated) to read it again. " +
          `Keys currently loaded: ${keyring.keyIds().join(", ")}`,
      );
    }
    return master.key;
  });

  const boundTo = (protectedHeader as SealedHeader)[SECRET_ID_HEADER];
  if (boundTo !== id) {
    // The ciphertext is intact but belongs to a different row: someone copied
    // bytes between secrets, or a backend returned the wrong row.
    throw new ConfigError(
      `secret "${id}" holds a value sealed for a different secret; refusing to use it`,
    );
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * Which master key sealed this value, read from the header.
 *
 * Cheap enough to call per row, which is why the id is not also stored in a
 * column: a projection that can disagree with the ciphertext is worse than a
 * parse. Returns `""` for anything unparseable, so a corrupt row shows up as
 * needing rotation rather than throwing during a listing.
 */
export function sealedKeyId(sealed: SealedSecret): string {
  try {
    const header = decodeProtectedHeader(sealed) as SealedHeader;
    return typeof header.kid === "string" ? header.kid : "";
  } catch {
    return "";
  }
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
