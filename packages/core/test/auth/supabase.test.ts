import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { supabaseVerifierFactory } from "../../src/auth/verifiers/supabase.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1000;
const PROJECT_URL = "https://abcdefgh.supabase.co";
const ISSUER = `${PROJECT_URL}/auth/v1`;
const SECRET = "super-secret-supabase-jwt-key";

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

function bearer(token: string): Request {
  return new Request("https://proxy.example/v1/chat/completions", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function signAccessToken(
  key: CryptoKey | Uint8Array,
  payload: Record<string, unknown>,
  header: { alg: string; kid?: string },
  exp: number = NOW_SEC + 3600,
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    aud: "authenticated",
    sub: "user-7",
    role: "authenticated",
    app_metadata: { provider: "email" },
    ...payload,
  })
    .setProtectedHeader(header)
    .setIssuedAt(NOW_SEC - 10)
    .setExpirationTime(exp)
    .sign(key);
}

describe("supabaseVerifierFactory", () => {
  it("has type supabase", () => {
    expect(supabaseVerifierFactory.type).toBe("supabase");
  });

  describe("jwtSecret (HS256) mode", () => {
    const options = { type: "supabase", url: PROJECT_URL, jwtSecret: SECRET };
    const secretKey = new TextEncoder().encode(SECRET);

    it("verifies a valid access token and maps identity and claims", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const token = await signAccessToken(secretKey, {}, { alg: "HS256" });
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.provider).toBe("supabase");
      expect(result.identity.userId).toBe("user-7");
      expect(result.identity.claims.role).toBe("authenticated");
      expect(result.identity.claims.app_metadata).toEqual({ provider: "email" });
    });

    it("defaults the issuer to <url>/auth/v1 and rejects other issuers", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const token = await signAccessToken(
        secretKey,
        { iss: "https://other.supabase.co/auth/v1" },
        { alg: "HS256" },
      );
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("iss");
    });

    it('defaults the audience to "authenticated" and rejects others', async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const token = await signAccessToken(secretKey, { aud: "anon" }, { alg: "HS256" });
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("aud");
    });

    it("rejects a token signed with a different secret", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const token = await signAccessToken(
        new TextEncoder().encode("wrong-secret"),
        {},
        { alg: "HS256" },
      );
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("signature");
    });

    it("rejects an expired token", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const token = await signAccessToken(secretKey, {}, { alg: "HS256" }, NOW_SEC - 3600);
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || result.ok) throw new Error("expected rejection");
      expect(result.reason).toContain("expired");
    });

    it("returns null when the header is absent", async () => {
      const ctx = makeCtx(rejectFetch);
      const verifier = supabaseVerifierFactory.create(options, ctx);
      const request = new Request("https://proxy.example/v1/chat/completions");
      expect(await verifier.verify(request, ctx)).toBeNull();
    });
  });

  describe("jwks mode", () => {
    it("derives the JWKS URL from the project URL", async () => {
      const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: "sb-key", alg: "ES256", use: "sig" };
      const derivedUrl = `${PROJECT_URL}/auth/v1/.well-known/jwks.json`;
      const calls: string[] = [];
      const ctx = makeCtx(jwksFetch(derivedUrl, [jwk], calls));
      const verifier = supabaseVerifierFactory.create({ url: PROJECT_URL }, ctx);
      const token = await signAccessToken(privateKey, {}, { alg: "ES256", kid: "sb-key" });
      const result = await verifier.verify(bearer(token), ctx);
      if (result === null || !result.ok) throw new Error("expected success");
      expect(result.identity.userId).toBe("user-7");
      expect(calls).toEqual([derivedUrl]);
    });

    it("uses an explicit jwksUrl with issuer and audience overrides", async () => {
      const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), kid: "sb-key", alg: "ES256", use: "sig" };
      const jwksUrl = "https://keys.example.com/jwks.json";
      const calls: string[] = [];
      const ctx = makeCtx(jwksFetch(jwksUrl, [jwk], calls));
      const verifier = supabaseVerifierFactory.create(
        { jwksUrl, issuer: "https://custom-issuer.example", audience: "custom-aud" },
        ctx,
      );
      const token = await signAccessToken(
        privateKey,
        { iss: "https://custom-issuer.example", aud: "custom-aud" },
        { alg: "ES256", kid: "sb-key" },
      );
      const result = await verifier.verify(bearer(token), ctx);
      expect(result?.ok).toBe(true);
      expect(calls).toEqual([jwksUrl]);
    });
  });

  describe("configuration errors", () => {
    const ctx = makeCtx(rejectFetch);

    it("requires jwtSecret or a JWKS source", () => {
      expect(() => supabaseVerifierFactory.create({ type: "supabase" }, ctx)).toThrow(ConfigError);
    });

    it("rejects both jwtSecret and jwksUrl", () => {
      expect(() =>
        supabaseVerifierFactory.create(
          { jwtSecret: SECRET, jwksUrl: "https://keys.example.com/jwks.json" },
          ctx,
        ),
      ).toThrow(ConfigError);
    });

    it("rejects unknown options", () => {
      expect(() =>
        supabaseVerifierFactory.create({ jwtSecret: SECRET, secretKey: "typo" }, ctx),
      ).toThrow(ConfigError);
    });
  });
});
