import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { firebaseAuthVerifierFactory } from "../../src/auth/verifiers/firebase-auth.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1000;
const GOOGLE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const PROJECT_ID = "my-project";
const ISSUER = `https://securetoken.google.com/${PROJECT_ID}`;

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "fb-key", alg: "RS256", use: "sig" };

function makeCtx(fetchImpl: typeof fetch): VerifyContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => NOW,
    waitUntil: () => {},
    log: silentLogger,
    storage: new MemoryStorageAdapter(() => NOW),
  };
}

function jwksFetch(calls: string[]): typeof fetch {
  return async (input) => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(target);
    if (target !== GOOGLE_JWKS_URL) throw new Error(`unexpected fetch: ${target}`);
    return Response.json({ keys: [jwk] });
  };
}

const rejectFetch: typeof fetch = async () => {
  throw new Error("network access not expected");
};

function withHeader(name: string, value: string): Request {
  return new Request("https://proxy.example/v1/chat/completions", {
    headers: { [name]: value },
  });
}

async function signIdToken(
  payload: Record<string, unknown>,
  exp: number = NOW_SEC + 3600,
): Promise<string> {
  return new SignJWT({ iss: ISSUER, aud: PROJECT_ID, sub: "uid-123", ...payload })
    .setProtectedHeader({ alg: "RS256", kid: "fb-key" })
    .setIssuedAt(NOW_SEC - 10)
    .setExpirationTime(exp)
    .sign(privateKey);
}

describe("firebaseAuthVerifierFactory", () => {
  const options = { type: "firebase-auth", projectId: PROJECT_ID };

  it("has type firebase-auth", () => {
    expect(firebaseAuthVerifierFactory.type).toBe("firebase-auth");
  });

  it("verifies a valid ID token against Google's JWKS", async () => {
    const calls: string[] = [];
    const ctx = makeCtx(jwksFetch(calls));
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const token = await signIdToken({ email: "a@example.com" });
    const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    if (result === null || !result.ok) throw new Error("expected success");
    expect(result.identity.provider).toBe("firebase-auth");
    expect(result.identity.userId).toBe("uid-123");
    expect(result.identity.claims.email).toBe("a@example.com");
    expect(calls).toEqual([GOOGLE_JWKS_URL]);
  });

  it("returns null when the header is absent", async () => {
    const ctx = makeCtx(rejectFetch);
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const request = new Request("https://proxy.example/v1/chat/completions");
    expect(await verifier.verify(request, ctx)).toBeNull();
  });

  it("rejects a token issued for a different project", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const token = await signIdToken({ aud: "other-project" });
    const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("aud");
  });

  it("rejects a token with the wrong issuer", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const token = await signIdToken({ iss: "https://securetoken.google.com/other-project" });
    const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("iss");
  });

  it("rejects an expired token", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const token = await signIdToken({}, NOW_SEC - 3600);
    const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("expired");
  });

  it("rejects a token with an empty subject", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAuthVerifierFactory.create(options, ctx);
    const token = await signIdToken({ sub: "" });
    const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("subject");
  });

  it("reads the token from an overridden header", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAuthVerifierFactory.create({ ...options, header: "x-id-token" }, ctx);
    const token = await signIdToken({});
    const result = await verifier.verify(withHeader("x-id-token", `Bearer ${token}`), ctx);
    expect(result?.ok).toBe(true);
    // The default header is no longer consulted.
    const viaDefault = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
    expect(viaDefault).toBeNull();
  });

  it("requires projectId and rejects unknown options", () => {
    const ctx = makeCtx(rejectFetch);
    expect(() => firebaseAuthVerifierFactory.create({ type: "firebase-auth" }, ctx)).toThrow(
      ConfigError,
    );
    expect(() => firebaseAuthVerifierFactory.create({ ...options, project: "typo" }, ctx)).toThrow(
      ConfigError,
    );
  });
});
