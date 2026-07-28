import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { awsCognitoVerifierFactory } from "../../src/auth/verifiers/aws-cognito.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";

const NOW = Date.UTC(2026, 0, 1);
const NOW_SEC = NOW / 1_000;
const REGION = "us-east-1";
const USER_POOL_ID = "us-east-1_Example";
const CLIENT_ID = "4exampleclientid";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: "cognito-key", alg: "RS256", use: "sig" };

const baseOptions = {
  region: REGION,
  userPoolId: USER_POOL_ID,
  clientIds: [CLIENT_ID],
};

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

function tokenRequest(token: string): Request {
  return new Request("https://proxy.example/v1/chat/completions", {
    headers: { "x-cognito-id-token": token },
  });
}

async function sign(
  tokenUse: "access" | "id",
  overrides: Record<string, unknown> = {},
  expiration = NOW_SEC + 3_600,
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    sub: "cognito-user-id",
    token_use: tokenUse,
    ...(tokenUse === "access"
      ? { client_id: CLIENT_ID, scope: "openid profile models:invoke", username: "alice" }
      : { aud: CLIENT_ID, email: "alice@example.com" }),
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "cognito-key" })
    .setIssuedAt(NOW_SEC - 10)
    .setExpirationTime(expiration)
    .sign(privateKey);
}

describe("awsCognitoVerifierFactory", () => {
  it("publishes a user-layer schema and validates pool configuration", () => {
    expect(awsCognitoVerifierFactory).toMatchObject({ type: "aws-cognito", layer: "user" });
    const ctx = context(fetch);
    expect(() =>
      awsCognitoVerifierFactory.create({ ...baseOptions, userPoolId: "eu-west-1_Other" }, ctx),
    ).toThrow(ConfigError);
    expect(() =>
      awsCognitoVerifierFactory.create(
        { ...baseOptions, tokenUse: "id", requiredScopes: ["openid"] },
        ctx,
      ),
    ).toThrow(ConfigError);
    expect(() => awsCognitoVerifierFactory.create({ ...baseOptions, pool: "typo" }, ctx)).toThrow(
      ConfigError,
    );
  });

  it("verifies an access token, client_id, and required scopes", async () => {
    const calls: string[] = [];
    const ctx = context(jwksFetch(calls));
    const verifier = awsCognitoVerifierFactory.create(
      { ...baseOptions, requiredScopes: ["openid", "models:invoke"] },
      ctx,
    );
    const result = await verifier.verify(tokenRequest(await sign("access")), ctx);

    expect(result).toEqual({
      ok: true,
      identity: {
        provider: "aws-cognito",
        userId: "cognito-user-id",
        claims: expect.objectContaining({
          token_use: "access",
          client_id: CLIENT_ID,
          username: "alice",
        }),
      },
    });
    expect(calls).toEqual([JWKS_URL]);
  });

  it("verifies an ID token against its aud app-client claim", async () => {
    const ctx = context(jwksFetch());
    const verifier = awsCognitoVerifierFactory.create({ ...baseOptions, tokenUse: "id" }, ctx);
    expect(await verifier.verify(tokenRequest(await sign("id")), ctx)).toMatchObject({
      ok: true,
      identity: { userId: "cognito-user-id" },
    });
  });

  it("supports either token kind while preserving each client-binding rule", async () => {
    for (const tokenUse of ["access", "id"] as const) {
      const ctx = context(jwksFetch());
      const verifier = awsCognitoVerifierFactory.create(
        { ...baseOptions, tokenUse: "either" },
        ctx,
      );
      expect(await verifier.verify(tokenRequest(await sign(tokenUse)), ctx)).toMatchObject({
        ok: true,
      });
    }
  });

  it("rejects the wrong token kind", async () => {
    const ctx = context(jwksFetch());
    const verifier = awsCognitoVerifierFactory.create(baseOptions, ctx);
    expect(await verifier.verify(tokenRequest(await sign("id")), ctx)).toMatchObject({
      ok: false,
      reason: "Cognito id token is not accepted",
    });
  });

  it.each([
    ["access", { client_id: "other-client" }, "access token client"],
    ["id", { aud: "other-client" }, "ID token audience"],
    ["access", { scope: "openid profile" }, "required scope"],
    ["access", { token_use: "refresh" }, "token_use"],
    ["access", { sub: "" }, "user subject"],
  ] as const)("rejects invalid Cognito policy claims", async (kind, overrides, reason) => {
    const ctx = context(jwksFetch());
    const verifier = awsCognitoVerifierFactory.create(
      { ...baseOptions, tokenUse: "either", requiredScopes: ["models:invoke"] },
      ctx,
    );
    expect(await verifier.verify(tokenRequest(await sign(kind, overrides)), ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining(reason),
    });
  });

  it("enforces the exact user-pool issuer and token expiration", async () => {
    for (const [overrides, expiration, reason] of [
      [
        { iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" },
        NOW_SEC + 3_600,
        "iss",
      ],
      [{}, NOW_SEC - 3_600, "expired"],
    ] as const) {
      const ctx = context(jwksFetch());
      const verifier = awsCognitoVerifierFactory.create(baseOptions, ctx);
      expect(
        await verifier.verify(tokenRequest(await sign("access", overrides, expiration)), ctx),
      ).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
    }
  });

  it("rejects a token whose signature was changed", async () => {
    const token = await sign("access");
    const parts = token.split(".");
    const signature = parts[2];
    if (parts[0] === undefined || parts[1] === undefined || signature === undefined) {
      throw new Error("test token is malformed");
    }
    const changed = `${parts[0]}.${parts[1]}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    const ctx = context(jwksFetch());
    const verifier = awsCognitoVerifierFactory.create(baseOptions, ctx);
    expect(await verifier.verify(tokenRequest(changed), ctx)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("signature"),
    });
  });

  it("returns null without a bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const ctx = context(fetchImpl);
    const verifier = awsCognitoVerifierFactory.create(baseOptions, ctx);
    expect(await verifier.verify(new Request("https://proxy.example/v1/models"), ctx)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 503 when the Cognito JWKS is unreachable or invalid", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 })),
      vi.fn<typeof fetch>(async () => Response.json({ notKeys: [] })),
    ]) {
      const ctx = context(fetchImpl);
      const verifier = awsCognitoVerifierFactory.create(baseOptions, ctx);
      expect(await verifier.verify(tokenRequest(await sign("access")), ctx)).toEqual({
        ok: false,
        status: 503,
        reason: "AWS Cognito verification unavailable",
      });
    }
  });
});
