import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { jwtVerifierFactory } from "../../src/auth/verifiers/jwt.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1000;
const JWKS_URL = "https://auth.example.com/.well-known/jwks.json";
const ISSUER = "https://auth.example.com";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "ES256", use: "sig" };
const otherPair = await generateKeyPair("ES256", { extractable: true });

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

function jwksFetch(url: string, keys: unknown[], calls: string[]): typeof fetch {
  return async (input) => {
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(target);
    if (target !== url) throw new Error(`unexpected fetch: ${target}`);
    return Response.json({ keys });
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

async function sign(
  key: CryptoKey | Uint8Array,
  payload: Record<string, unknown>,
  header: { alg: string; kid?: string },
  exp: number = NOW_SEC + 3600,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuedAt(NOW_SEC - 10)
    .setExpirationTime(exp)
    .sign(key);
}

describe("jwtVerifierFactory", () => {
  it("has type jwt and defaults the instance name to the type", () => {
    expect(jwtVerifierFactory.type).toBe("jwt");
    const ctx = makeCtx(rejectFetch);
    expect(jwtVerifierFactory.create({ secret: "s" }, ctx).name).toBe("jwt");
    expect(jwtVerifierFactory.create({ secret: "s", name: "main" }, ctx).name).toBe("main");
  });

  describe("jwks mode", () => {
    const options = {
      type: "jwt",
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      audience: "omni",
      deviceIdClaim: "device_id",
    };
    const basePayload = { iss: ISSUER, aud: "omni", sub: "user-1" };

    it("verifies a valid token and maps the identity", async () => {
      const calls: string[] = [];
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], calls));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        privateKey,
        { ...basePayload, device_id: "dev-9", tier: "pro" },
        { alg: "ES256", kid: "key-1" },
      );
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.provider).toBe("jwt");
      expect(result.identity.userId).toBe("user-1");
      expect(result.identity.deviceId).toBe("dev-9");
      expect(result.identity.claims.tier).toBe("pro");
      expect(calls).toEqual([JWKS_URL]);
    });

    it("accepts a case-insensitive bearer prefix", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(privateKey, basePayload, { alg: "ES256", kid: "key-1" });
      const result = await verifier.verify(withHeader("authorization", `bEaReR ${token}`), ctx);
      expect(result?.ok).toBe(true);
    });

    it("returns null when the header is absent", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(options, ctx);
      const request = new Request("https://proxy.example/v1/chat/completions");
      expect(await verifier.verify(request, ctx)).toBeNull();
    });

    it("returns null for a non-bearer authorization header", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(options, ctx);
      const result = await verifier.verify(withHeader("authorization", "Basic dXNlcjpwYXNz"), ctx);
      expect(result).toBeNull();
    });

    it("rejects an expired token without echoing it", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        privateKey,
        basePayload,
        { alg: "ES256", kid: "key-1" },
        NOW_SEC - 3600,
      );
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("expired");
      expect(result.reason).not.toContain(token);
    });

    it("accepts a just-expired token within the clock tolerance", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        privateKey,
        basePayload,
        { alg: "ES256", kid: "key-1" },
        NOW_SEC - 30,
      );
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      expect(result?.ok).toBe(true);
    });

    it("rejects the wrong issuer", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        privateKey,
        { ...basePayload, iss: "https://evil.example.com" },
        { alg: "ES256", kid: "key-1" },
      );
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("iss");
    });

    it("rejects the wrong audience", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        privateKey,
        { ...basePayload, aud: "someone-else" },
        { alg: "ES256", kid: "key-1" },
      );
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("aud");
    });

    it("rejects a token signed with a different key", async () => {
      const ctx = makeCtx(jwksFetch(JWKS_URL, [jwk], []));
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(otherPair.privateKey, basePayload, {
        alg: "ES256",
        kid: "key-1",
      });
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("signature");
    });

    it("rejects a malformed token", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(options, ctx);
      const result = await verifier.verify(withHeader("authorization", "Bearer not-a-jwt"), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toBe("malformed token");
    });
  });

  describe("secret (HS256) mode", () => {
    const secret = "shared-hs256-secret";
    const options = { secret, header: "x-auth-token", scheme: "none", issuer: ISSUER };
    const secretKey = new TextEncoder().encode(secret);

    it("verifies a raw token from a custom header", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(secretKey, { iss: ISSUER, sub: "user-2" }, { alg: "HS256" });
      const result = await verifier.verify(withHeader("x-auth-token", token), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.userId).toBe("user-2");
    });

    it("rejects a token signed with a different secret", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(options, ctx);
      const token = await sign(
        new TextEncoder().encode("wrong-secret"),
        { iss: ISSUER, sub: "user-2" },
        { alg: "HS256" },
      );
      const result = await verifier.verify(withHeader("x-auth-token", token), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("signature");
    });
  });

  describe("publicKey (SPKI) mode", () => {
    it("verifies a token against a pinned public key", async () => {
      const spki = await exportSPKI(publicKey);
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create(
        { publicKey: spki, algorithms: ["ES256"], issuer: ISSUER },
        ctx,
      );
      const token = await sign(privateKey, { iss: ISSUER, sub: "user-3" }, { alg: "ES256" });
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.userId).toBe("user-3");
    });
  });

  describe("claim mapping", () => {
    it("maps a custom userIdClaim and stringifies non-string values", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create({ secret: "s", userIdClaim: "uid" }, ctx);
      const key = new TextEncoder().encode("s");
      const token = await sign(key, { uid: 42 }, { alg: "HS256" });
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.userId).toBe("42");
    });

    it("leaves userId unset when the claim is absent", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = jwtVerifierFactory.create({ secret: "s" }, ctx);
      const key = new TextEncoder().encode("s");
      const token = await sign(key, { scope: "chat" }, { alg: "HS256" });
      const result = await verifier.verify(withHeader("authorization", `Bearer ${token}`), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.userId).toBeUndefined();
    });
  });

  describe("configuration errors", () => {
    const ctx = makeCtx(rejectFetch);

    it("rejects a config without a key source", () => {
      expect(() => jwtVerifierFactory.create({ type: "jwt" }, ctx)).toThrow(ConfigError);
    });

    it("rejects a config with multiple key sources", () => {
      expect(() => jwtVerifierFactory.create({ jwksUrl: JWKS_URL, secret: "s" }, ctx)).toThrow(
        ConfigError,
      );
    });

    it("rejects publicKey without exactly one algorithm", async () => {
      const spki = await exportSPKI(publicKey);
      expect(() => jwtVerifierFactory.create({ publicKey: spki }, ctx)).toThrow(ConfigError);
      expect(() =>
        jwtVerifierFactory.create({ publicKey: spki, algorithms: ["ES256", "RS256"] }, ctx),
      ).toThrow(ConfigError);
    });

    it("rejects unknown options", () => {
      expect(() => jwtVerifierFactory.create({ secret: "s", jwks_url: JWKS_URL }, ctx)).toThrow(
        ConfigError,
      );
    });
  });
});
