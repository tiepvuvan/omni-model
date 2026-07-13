import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { firebaseAppCheckVerifierFactory } from "../../src/auth/verifiers/firebase-app-check.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1000;
const JWKS_URL = "https://firebaseappcheck.googleapis.com/v1/jwks";
const PROJECT_NUMBER = "1234567890";
const ISSUER = `https://firebaseappcheck.googleapis.com/${PROJECT_NUMBER}`;
const APP_ID = "1:1234567890:ios:abc123def456";

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "ac-key", alg: "RS256", use: "sig" };

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
    if (target !== JWKS_URL) throw new Error(`unexpected fetch: ${target}`);
    return Response.json({ keys: [jwk] });
  };
}

const rejectFetch: typeof fetch = async () => {
  throw new Error("network access not expected");
};

function withAppCheckHeader(token: string, header = "x-firebase-appcheck"): Request {
  return new Request("https://proxy.example/v1/chat/completions", {
    headers: { [header]: token },
  });
}

async function signAppCheckToken(
  payload: Record<string, unknown>,
  options: { typ?: string; exp?: number } = {},
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    // App Check `aud` is an array of project resource names.
    aud: [`projects/${PROJECT_NUMBER}`, "projects/my-project"],
    sub: APP_ID,
    provider: "device_check",
    ...payload,
  })
    .setProtectedHeader({ alg: "RS256", kid: "ac-key", typ: options.typ ?? "JWT" })
    .setIssuedAt(NOW_SEC - 10)
    .setExpirationTime(options.exp ?? NOW_SEC + 3600)
    .sign(privateKey);
}

describe("firebaseAppCheckVerifierFactory", () => {
  const options = { type: "firebase-app-check", projectNumber: PROJECT_NUMBER };

  it("has type firebase-app-check", () => {
    expect(firebaseAppCheckVerifierFactory.type).toBe("firebase-app-check");
  });

  it("verifies a valid token and maps the app id to deviceId", async () => {
    const calls: string[] = [];
    const ctx = makeCtx(jwksFetch(calls));
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const result = await verifier.verify(withAppCheckHeader(await signAppCheckToken({})), ctx);
    if (result === null || !result.ok) throw new Error("expected success");
    expect(result.identity.provider).toBe("firebase-app-check");
    expect(result.identity.deviceId).toBe(APP_ID);
    expect(result.identity.userId).toBeUndefined();
    expect(result.identity.claims.provider).toBe("device_check");
    expect(calls).toEqual([JWKS_URL]);
  });

  it("returns null when the header is absent", async () => {
    const ctx = makeCtx(rejectFetch);
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const request = new Request("https://proxy.example/v1/chat/completions");
    expect(await verifier.verify(request, ctx)).toBeNull();
  });

  it("rejects a token whose audience lacks the project", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const token = await signAppCheckToken({ aud: ["projects/9999999999"] });
    const result = await verifier.verify(withAppCheckHeader(token), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("aud");
  });

  it("rejects a token with the wrong issuer", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const token = await signAppCheckToken({
      iss: "https://firebaseappcheck.googleapis.com/9999999999",
    });
    const result = await verifier.verify(withAppCheckHeader(token), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("iss");
  });

  it("rejects an expired token", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const token = await signAppCheckToken({}, { exp: NOW_SEC - 3600 });
    const result = await verifier.verify(withAppCheckHeader(token), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("expired");
  });

  it("rejects a token with an unexpected typ header", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAppCheckVerifierFactory.create(options, ctx);
    const token = await signAppCheckToken({}, { typ: "at+jwt" });
    const result = await verifier.verify(withAppCheckHeader(token), ctx);
    if (result === null || result.ok) throw new Error("expected rejection");
    expect(result.reason).toContain("typ");
  });

  it("enforces the appIds allowlist", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const allowed = firebaseAppCheckVerifierFactory.create({ ...options, appIds: [APP_ID] }, ctx);
    const token = await signAppCheckToken({});
    const accepted = await allowed.verify(withAppCheckHeader(token), ctx);
    expect(accepted?.ok).toBe(true);

    const restricted = firebaseAppCheckVerifierFactory.create(
      { ...options, appIds: ["1:1234567890:android:other"] },
      ctx,
    );
    const rejected = await restricted.verify(withAppCheckHeader(token), ctx);
    if (rejected === null || rejected.ok) throw new Error("expected rejection");
    expect(rejected.reason).toContain(APP_ID);
  });

  it("reads the raw token from an overridden header", async () => {
    const ctx = makeCtx(jwksFetch([]));
    const verifier = firebaseAppCheckVerifierFactory.create(
      { ...options, header: "x-attestation" },
      ctx,
    );
    const token = await signAppCheckToken({});
    const result = await verifier.verify(withAppCheckHeader(token, "x-attestation"), ctx);
    expect(result?.ok).toBe(true);
    expect(await verifier.verify(withAppCheckHeader(token), ctx)).toBeNull();
  });

  it("requires a numeric projectNumber and rejects unknown options", () => {
    const ctx = makeCtx(rejectFetch);
    expect(() =>
      firebaseAppCheckVerifierFactory.create({ type: "firebase-app-check" }, ctx),
    ).toThrow(ConfigError);
    expect(() =>
      firebaseAppCheckVerifierFactory.create({ projectNumber: "my-project" }, ctx),
    ).toThrow(ConfigError);
    expect(() =>
      firebaseAppCheckVerifierFactory.create({ ...options, appId: APP_ID }, ctx),
    ).toThrow(ConfigError);
  });
});
