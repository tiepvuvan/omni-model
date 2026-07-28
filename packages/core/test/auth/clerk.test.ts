import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { clerkVerifierFactory } from "../../src/auth/verifiers/clerk.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1_000;
const ISSUER = "https://helpful-otter-42.clerk.accounts.dev";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "clerk-key", alg: "RS256", use: "sig" };

function context(fetchImpl: typeof fetch): VerifyContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => NOW,
    waitUntil: () => {},
    log: silentLogger,
    storage: new MemoryStorageAdapter(() => NOW),
  };
}

function jwksFetch(calls: string[] = []): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url !== JWKS_URL) throw new Error(`unexpected fetch: ${url}`);
    return Response.json({ keys: [jwk] });
  };
}

function tokenRequest(token: string, header = "x-clerk-session-token", bearer = false): Request {
  return new Request("https://proxy.example/v1/chat/completions", {
    headers: { [header]: bearer ? `Bearer ${token}` : token },
  });
}

async function sign(
  overrides: Record<string, unknown> = {},
  expiration = NOW_SEC + 3_600,
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    sub: "user_2abc",
    sid: "sess_2abc",
    azp: "https://app.example.com",
    role: "authenticated",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "clerk-key", typ: "JWT" })
    .setIssuedAt(NOW_SEC - 10)
    .setNotBefore(NOW_SEC - 10)
    .setExpirationTime(expiration)
    .sign(privateKey);
}

describe("clerkVerifierFactory", () => {
  it("publishes a user-layer schema and rejects unknown options", () => {
    expect(clerkVerifierFactory).toMatchObject({ type: "clerk", layer: "user" });
    expect(() => clerkVerifierFactory.create({}, context(fetch))).toThrow(ConfigError);
    expect(() =>
      clerkVerifierFactory.create({ issuer: "http://insecure.example" }, context(fetch)),
    ).toThrow(/https/);
    expect(() =>
      clerkVerifierFactory.create(
        { issuer: ISSUER, secretKey: "must-not-be-used" },
        context(fetch),
      ),
    ).toThrow(ConfigError);
  });

  it("verifies a Clerk session token against the issuer JWKS", async () => {
    const calls: string[] = [];
    const ctx = context(jwksFetch(calls));
    const verifier = clerkVerifierFactory.create(
      { issuer: `${ISSUER}/`, authorizedParties: ["https://app.example.com"] },
      ctx,
    );
    const result = await verifier.verify(tokenRequest(await sign()), ctx);

    expect(result).toEqual({
      ok: true,
      identity: {
        provider: "clerk",
        userId: "user_2abc",
        claims: expect.objectContaining({
          sid: "sess_2abc",
          azp: "https://app.example.com",
          role: "authenticated",
        }),
      },
    });
    expect(calls).toEqual([JWKS_URL]);
  });

  it("returns null without its bearer header and supports a custom header", async () => {
    const calls: string[] = [];
    const fetchImpl = jwksFetch(calls);
    const ctx = context(fetchImpl);
    const verifier = clerkVerifierFactory.create(
      { issuer: ISSUER, header: "x-clerk-token", scheme: "bearer" },
      ctx,
    );

    expect(await verifier.verify(new Request("https://proxy.example/v1/models"), ctx)).toBeNull();
    expect(calls).toEqual([]);
    expect(
      await verifier.verify(tokenRequest(await sign(), "x-clerk-token", true), ctx),
    ).toMatchObject({
      ok: true,
    });
  });

  it("enforces issuer, expiration, user subject, and session id", async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ iss: "https://other.clerk.accounts.dev" }, NOW_SEC + 3_600, "iss"],
      [{}, NOW_SEC - 3_600, "expired"],
      [{ sub: "" }, NOW_SEC + 3_600, "user subject"],
      [{ sid: "" }, NOW_SEC + 3_600, "session id"],
    ];
    for (const [overrides, expiration, reason] of cases) {
      const ctx = context(jwksFetch());
      const verifier = clerkVerifierFactory.create({ issuer: ISSUER }, ctx);
      const result = await verifier.verify(tokenRequest(await sign(overrides, expiration)), ctx);
      expect(result).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    }
  });

  it("rejects a token whose signature was changed", async () => {
    const token = await sign();
    const parts = token.split(".");
    const signature = parts[2];
    if (parts[0] === undefined || parts[1] === undefined || signature === undefined) {
      throw new Error("test token is malformed");
    }
    const changed = `${parts[0]}.${parts[1]}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const ctx = context(jwksFetch());
    const verifier = clerkVerifierFactory.create({ issuer: ISSUER }, ctx);
    expect(await verifier.verify(tokenRequest(changed), ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signature"),
    });
  });

  it("checks azp when present and an authorized-party allowlist is configured", async () => {
    const ctx = context(jwksFetch());
    const verifier = clerkVerifierFactory.create(
      { issuer: ISSUER, authorizedParties: ["https://app.example.com"] },
      ctx,
    );
    for (const azp of ["https://evil.example", ["https://app.example.com"]]) {
      expect(await verifier.verify(tokenRequest(await sign({ azp })), ctx)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("authorized party"),
      });
    }
  });

  it("accepts a missing azp because Clerk omits it when Origin is unavailable", async () => {
    const ctx = context(jwksFetch());
    const verifier = clerkVerifierFactory.create(
      { issuer: ISSUER, authorizedParties: ["https://app.example.com"] },
      ctx,
    );
    expect(await verifier.verify(tokenRequest(await sign({ azp: undefined })), ctx)).toMatchObject({
      ok: true,
    });
  });

  it("rejects pending organization sessions unless explicitly allowed", async () => {
    const token = await sign({ sts: "pending" });
    const strictCtx = context(jwksFetch());
    const strict = clerkVerifierFactory.create({ issuer: ISSUER }, strictCtx);
    expect(await strict.verify(tokenRequest(token), strictCtx)).toMatchObject({
      ok: false,
      reason: "Clerk session is pending",
    });

    const allowedCtx = context(jwksFetch());
    const allowed = clerkVerifierFactory.create(
      { issuer: ISSUER, allowPendingSessions: true },
      allowedCtx,
    );
    expect(await allowed.verify(tokenRequest(token), allowedCtx)).toMatchObject({ ok: true });
  });

  it("returns 503 when the Clerk JWKS is unreachable or invalid", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 })),
      vi.fn<typeof fetch>(async () => Response.json({ notKeys: [] })),
    ]) {
      const ctx = context(fetchImpl);
      const verifier = clerkVerifierFactory.create({ issuer: ISSUER }, ctx);
      expect(await verifier.verify(tokenRequest(await sign()), ctx)).toEqual({
        ok: false,
        status: 503,
        reason: "Clerk verification unavailable",
      });
    }
  });
});
