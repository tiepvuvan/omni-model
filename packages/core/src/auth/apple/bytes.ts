/** Byte-level helpers shared by the Apple attestation verifiers. */

const encoder = new TextEncoder();

/** UTF-8 encode a string. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Concatenate byte arrays into one. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time byte comparison (no early exit on the byte loop) — used for
 * nonce and hash comparisons in the attestation checks.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Lowercase hex encoding. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** SHA-256 via WebCrypto. */
export async function sha256(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

/** Decode base64 or base64url (padding optional). Throws on invalid input. */
export function b64Decode(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Standard base64 encoding. */
export function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64url encoding without padding. */
export function b64UrlEncode(bytes: Uint8Array): string {
  return b64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Read a big-endian uint32 (e.g. the authenticator-data sign counter). */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/**
 * Convert a DER-encoded ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`)
 * into the raw fixed-width `r || s` form WebCrypto expects. App Attest
 * assertion signatures come DER-encoded from Secure Enclave; WebCrypto's
 * ECDSA verify only accepts raw. Throws on malformed input.
 */
export function derSignatureToRaw(der: Uint8Array, size = 32): Uint8Array<ArrayBuffer> {
  let pos = 0;
  const fail = (): never => {
    throw new Error("malformed DER ECDSA signature");
  };
  const readByte = (): number => {
    const byte = der[pos];
    if (byte === undefined) fail();
    pos += 1;
    return byte as number;
  };
  const readLength = (): number => {
    let length = readByte();
    if ((length & 0x80) !== 0) {
      const count = length & 0x7f;
      // ECDSA signatures for P-256/P-384 never need length-of-length > 2.
      if (count === 0 || count > 2) fail();
      length = 0;
      for (let i = 0; i < count; i++) length = (length << 8) | readByte();
    }
    return length;
  };
  const readInteger = (): Uint8Array => {
    if (readByte() !== 0x02) fail();
    const length = readLength();
    const end = pos + length;
    if (length === 0 || end > der.length) fail();
    let body = der.subarray(pos, end);
    pos = end;
    while (body.length > 1 && body[0] === 0) body = body.subarray(1);
    if (body.length > size) fail();
    const out = new Uint8Array(size);
    out.set(body, size - body.length);
    return out;
  };
  if (readByte() !== 0x30) fail();
  if (readLength() !== der.length - pos) fail();
  const r = readInteger();
  const s = readInteger();
  if (pos !== der.length) fail();
  return concatBytes(r, s);
}

/**
 * Inverse of {@link derSignatureToRaw}: wrap a raw `r || s` signature in DER.
 * Used by tests to fabricate device-style signatures from WebCrypto output.
 */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (raw.length === 0 || raw.length % 2 !== 0) {
    throw new Error("raw ECDSA signature must be a non-empty even-length r||s");
  }
  const encodeInteger = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let body = bytes.subarray(start);
    if (((body[0] ?? 0) & 0x80) !== 0) body = concatBytes(new Uint8Array([0]), body);
    return concatBytes(new Uint8Array([0x02, body.length]), body);
  };
  const half = raw.length / 2;
  const content = concatBytes(
    encodeInteger(raw.subarray(0, half)),
    encodeInteger(raw.subarray(half)),
  );
  if (content.length > 0x7f) throw new Error("raw ECDSA signature too large");
  return concatBytes(new Uint8Array([0x30, content.length]), content);
}
