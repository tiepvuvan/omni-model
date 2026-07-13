import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, customFetch, errors } from "jose";
import type { RuntimeContext } from "../../types.js";
import type { AuthResult } from "../types.js";

/** How a credential is carried in its header. */
export type HeaderScheme = "bearer" | "none";

/**
 * Read a credential from `header`. With scheme "bearer" a case-insensitive
 * `Bearer ` prefix is required and stripped; with "none" the trimmed raw
 * header value is used. Returns null when the header is absent, empty, or
 * carries a different scheme — i.e. the request presents no credential this
 * verifier is responsible for.
 */
export function extractToken(
  request: Request,
  header: string,
  scheme: HeaderScheme,
): string | null {
  const raw = request.headers.get(header);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (scheme === "none") return value;
  const match = /^bearer\s+(\S+)$/i.exec(value);
  return match?.[1] ?? null;
}

/**
 * Map a jose verification failure to an explicit rejection with a short,
 * token-free reason. Non-jose errors (network failures reaching a JWKS
 * endpoint, broken key material) are rethrown so they surface as server
 * errors instead of a misleading credential rejection.
 */
export function invalidTokenResult(error: unknown): AuthResult {
  if (!(error instanceof errors.JOSEError)) throw error;
  return { ok: false, reason: reasonFor(error) };
}

function reasonFor(error: errors.JOSEError): string {
  if (error instanceof errors.JWTExpired) return "token expired";
  // jose claim-validation messages name the offending claim, never its value.
  if (error instanceof errors.JWTClaimValidationFailed) return `token rejected: ${error.message}`;
  if (error instanceof errors.JWKSNoMatchingKey) return "no key in the JWKS matches the token";
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return "token signature verification failed";
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return "token algorithm is not allowed";
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) {
    return "malformed token";
  }
  return `token verification failed (${error.code})`;
}

/**
 * Remote JWKS resolver bound to the injected runtime fetch. jose caches the
 * fetched key set and refetches only when a token references an unknown key
 * id, so create one resolver per verifier instance.
 */
export function remoteJwks(url: string, runtime: RuntimeContext): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(url), {
    // Wrapping in an arrow keeps `fetch` bound to its runtime (an unbound
    // reference throws "Illegal invocation" on some platforms).
    [customFetch]: (input, init) => runtime.fetch(input, init),
  });
}
