/**
 * Human-visible marker on every write key.
 *
 * A fixed, distinctive prefix is what lets secret scanners (GitHub, gitleaks,
 * your own CI) recognise a leaked key in a commit or a log, so it is worth the
 * few bytes.
 */
export const WRITE_KEY_PREFIX = "omk_";

/** Random bytes behind each key. 256 bits, so guessing is not a threat model. */
const SECRET_BYTES = 32;

/** Characters of the key shown as its searchable, non-secret label. */
const LABEL_LENGTH = WRITE_KEY_PREFIX.length + 8;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Mint a new key. This is the only moment the plaintext exists. */
export function generateWriteKeySecret(): string {
  return WRITE_KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

/**
 * Hash a presented key for storage and lookup.
 *
 * A plain SHA-256 rather than a password hash on purpose: these are
 * 256-bit random values, so there is nothing to brute-force, and a deliberately
 * slow hash would put ~100ms of work on the hot path of every request.
 */
export async function hashWriteKeySecret(secret: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The part of a key safe to store in the clear and show in a list: enough to
 * match a key an operator is holding against a row, without being usable.
 */
export function writeKeyLabel(secret: string): { prefix: string; last4: string } {
  return { prefix: secret.slice(0, LABEL_LENGTH), last4: secret.slice(-4) };
}

/**
 * Whether a string is even shaped like a write key.
 *
 * Used to reject obvious noise before hashing and a store lookup, so a flood of
 * junk credentials costs almost nothing.
 */
export function looksLikeWriteKey(value: string): boolean {
  return (
    value.startsWith(WRITE_KEY_PREFIX) &&
    value.length > LABEL_LENGTH + 8 &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(WRITE_KEY_PREFIX.length))
  );
}
