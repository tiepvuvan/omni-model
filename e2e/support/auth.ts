/**
 * A self-contained credential for the e2e suites.
 *
 * A verifier is mandatory — the proxy refuses to start without one — so suites
 * that exercise chat, streaming, tools or storage still need an authenticated
 * caller. The `jwt` verifier with a shared secret is the only one needing no
 * external service, so the configs use it and requests carry a token signed
 * here. Those suites now exercise the auth path on every request, which the old
 * unauthenticated configs never did.
 *
 * Signed with WebCrypto rather than a JWT library: HS256 is a few lines, and
 * `e2e/` is not a workspace package, so it has no dependencies of its own.
 *
 * The secret is a test constant, not a credential — it only ever authenticates
 * against a proxy this suite started.
 */
export const E2E_JWT_SECRET = "omni-e2e-shared-secret-not-a-real-credential";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

let cached: string | undefined;

/** A bearer token the e2e configs' `jwt` verifier accepts (HS256). */
export async function e2eToken(): Promise<string> {
  if (cached !== undefined) return cached;
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const segments = [
    base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }))),
    base64url(encoder.encode(JSON.stringify({ sub: "e2e-user", iat: now, exp: now + 7200 }))),
  ];
  const signingInput = segments.join(".");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(E2E_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  cached = `${signingInput}.${base64url(new Uint8Array(signature))}`;
  return cached;
}

/** Headers carrying the e2e credential, to spread into a fetch init. */
export async function authHeaders(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await e2eToken()}` };
}
