import { beforeAll, describe, expect, it } from "vitest";
import { appleAppAttestVerifierFactory } from "../../../src/auth/apple/app-attest.js";
import { b64Encode, utf8 } from "../../../src/auth/apple/bytes.js";
import type { AuthRoute, AuthVerifier } from "../../../src/auth/types.js";
import { ConfigError } from "../../../src/errors.js";
import {
  AAGUID_DEVELOPMENT,
  buildAssertion,
  buildAttestation,
  type FakeAppleCa,
  makeCtx,
  makeFakeRoot,
  type TestCtx,
} from "./helpers.js";

const TEAM_ID = "TEAM123456";
const BUNDLE_ID = "com.example.app";
const APP_ID = `${TEAM_ID}.${BUNDLE_ID}`;

let ca: FakeAppleCa;

beforeAll(async () => {
  ca = await makeFakeRoot();
});

function makeVerifier(ctx: TestCtx, overrides: Record<string, unknown> = {}): AuthVerifier {
  return appleAppAttestVerifierFactory.create(
    {
      type: "apple-app-attest",
      teamId: TEAM_ID,
      bundleId: BUNDLE_ID,
      rootCaPem: ca.rootPem,
      ...overrides,
    },
    ctx,
  );
}

function route(verifier: AuthVerifier, path: string): AuthRoute {
  const found = verifier.routes?.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`route ${path} not found`);
  return found;
}

async function issueChallenge(verifier: AuthVerifier, ctx: TestCtx): Promise<string> {
  const handler = route(verifier, "/auth/app-attest/challenge").handler;
  const response = await handler(
    new Request("https://proxy.example/auth/app-attest/challenge", { method: "POST" }),
    ctx,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { challenge: string };
  expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.challenge;
}

async function register(
  verifier: AuthVerifier,
  ctx: TestCtx,
  body: Record<string, unknown>,
): Promise<Response> {
  const handler = route(verifier, "/auth/app-attest/register").handler;
  return handler(
    new Request("https://proxy.example/auth/app-attest/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );
}

function assertionRequest(headers: Record<string, string>): Request {
  return new Request("https://proxy.example/v1/chat/completions", { method: "POST", headers });
}

/** Register a fresh key end to end; returns what the client would hold. */
async function registerDevice(verifier: AuthVerifier, ctx: TestCtx) {
  const challenge = await issueChallenge(verifier, ctx);
  const fixture = await buildAttestation({ ca, challenge, appId: APP_ID });
  const response = await register(verifier, ctx, {
    keyId: fixture.keyId,
    attestation: fixture.attestation,
    challenge,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ registered: true });
  return fixture;
}

async function assertOnce(
  verifier: AuthVerifier,
  ctx: TestCtx,
  keyId: string,
  signingKey: CryptoKey,
  counter: number,
  overrides: { challenge?: string; rpIdHashOverride?: Uint8Array; tamperSignature?: boolean } = {},
) {
  const challenge = overrides.challenge ?? (await issueChallenge(verifier, ctx));
  const assertion = await buildAssertion({
    challenge,
    appId: APP_ID,
    counter,
    signingKey,
    rpIdHashOverride: overrides.rpIdHashOverride,
    tamperSignature: overrides.tamperSignature,
  });
  return verifier.verify(
    assertionRequest({
      "x-appattest-keyid": keyId,
      "x-appattest-assertion": assertion,
      "x-appattest-challenge": challenge,
    }),
    ctx,
  );
}

describe("appleAppAttestVerifierFactory", () => {
  it("has the expected type and routes", () => {
    const ctx = makeCtx();
    const verifier = makeVerifier(ctx);
    expect(appleAppAttestVerifierFactory.type).toBe("apple-app-attest");
    expect(verifier.type).toBe("apple-app-attest");
    expect(verifier.routes?.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /auth/app-attest/challenge",
      "POST /auth/app-attest/register",
    ]);
  });

  it("rejects invalid options at startup", () => {
    const ctx = makeCtx();
    expect(() => appleAppAttestVerifierFactory.create({ teamId: TEAM_ID }, ctx)).toThrow(
      ConfigError,
    );
    expect(() => makeVerifier(ctx, { challengeTtl: "eleven" })).toThrow(ConfigError);
    expect(() => makeVerifier(ctx, { rootCaPem: "not a certificate" })).toThrow(ConfigError);
    expect(() => makeVerifier(ctx, { environment: "staging" })).toThrow(ConfigError);
  });

  it("registers an attested key and verifies assertions (happy path)", async () => {
    const ctx = makeCtx();
    const verifier = makeVerifier(ctx);
    const device = await registerDevice(verifier, ctx);

    const result = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 1);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    if (result?.ok === true) {
      expect(result.identity).toEqual({
        provider: "apple-app-attest",
        deviceId: device.keyId,
        claims: {},
      });
    }

    // Counter advances; a later assertion with a higher counter still works.
    const again = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 2);
    expect(again?.ok).toBe(true);
  });

  it("expires challenges after challengeTtl", async () => {
    let nowMs = new Date("2026-06-01T00:00:00Z").getTime();
    const ctx = makeCtx({ now: () => nowMs });
    const verifier = makeVerifier(ctx, { challengeTtl: "30s" });
    const challenge = await issueChallenge(verifier, ctx);
    const fixture = await buildAttestation({ ca, challenge, appId: APP_ID });
    nowMs += 31_000;
    const response = await register(verifier, ctx, {
      keyId: fixture.keyId,
      attestation: fixture.attestation,
      challenge,
    });
    expect(response.status).toBe(400);
  });

  describe("registration failures", () => {
    it("rejects an unknown challenge with an OpenAI-style error body", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const fixture = await buildAttestation({ ca, challenge: "bogus", appId: APP_ID });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge: "bogus",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { message: string; type: string };
      };
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("challenge");
    });

    it("rejects non-JSON and incomplete bodies", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const handler = route(verifier, "/auth/app-attest/register").handler;
      const bad = await handler(
        new Request("https://proxy.example/auth/app-attest/register", {
          method: "POST",
          body: "not json",
        }),
        ctx,
      );
      expect(bad.status).toBe(400);
      const incomplete = await register(verifier, ctx, { keyId: "abc" });
      expect(incomplete.status).toBe(400);
    });

    it("rejects an attestation whose nonce was computed over a different challenge", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const stored = await issueChallenge(verifier, ctx);
      // Attestation built over some other challenge string.
      const fixture = await buildAttestation({ ca, challenge: `${stored}x`, appId: APP_ID });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge: stored,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("nonce");
    });

    it("rejects a chain that does not terminate at the configured root", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const otherCa = await makeFakeRoot("Impostor Root");
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({ ca: otherCa, challenge, appId: APP_ID });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("chain");
    });

    it("rejects an expired credential certificate", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({
        ca,
        challenge,
        appId: APP_ID,
        notBefore: new Date("2020-01-01T00:00:00Z"),
        notAfter: new Date("2021-01-01T00:00:00Z"),
      });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
    });

    it("rejects an rpIdHash for a different appId", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({
        ca,
        challenge,
        appId: `${TEAM_ID}.com.other.app`,
      });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("rpIdHash");
    });

    it("rejects an AAGUID from the wrong environment", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx); // production
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({
        ca,
        challenge,
        appId: APP_ID,
        aaguid: AAGUID_DEVELOPMENT,
      });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("AAGUID");
    });

    it("accepts the development AAGUID when environment is development", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx, { environment: "development" });
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({
        ca,
        challenge,
        appId: APP_ID,
        aaguid: AAGUID_DEVELOPMENT,
      });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(200);
    });

    it("rejects a keyId that is not the hash of the attested public key", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({ ca, challenge, appId: APP_ID });
      const wrongKeyId = b64Encode(new Uint8Array(32).fill(9));
      const response = await register(verifier, ctx, {
        keyId: wrongKeyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("keyId");
    });

    it("rejects a credentialId that differs from the keyId", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({
        ca,
        challenge,
        appId: APP_ID,
        credentialId: new Uint8Array(32).fill(3),
      });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("credentialId");
    });

    it("rejects a wrong attestation format", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({ ca, challenge, appId: APP_ID, fmt: "packed" });
      const response = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(response.status).toBe(400);
    });

    it("consumes the challenge on successful registration", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const fixture = await buildAttestation({ ca, challenge, appId: APP_ID });
      const first = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(first.status).toBe(200);
      const replay = await register(verifier, ctx, {
        keyId: fixture.keyId,
        attestation: fixture.attestation,
        challenge,
      });
      expect(replay.status).toBe(400);
    });
  });

  describe("assertion verification", () => {
    it("returns null when no App Attest headers are present", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      expect(await verifier.verify(assertionRequest({}), ctx)).toBeNull();
    });

    it("fails closed when only some headers are present", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const result = await verifier.verify(assertionRequest({ "x-appattest-keyid": "abc" }), ctx);
      expect(result?.ok).toBe(false);
    });

    it("rejects an unregistered keyId with 401", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const result = await verifier.verify(
        assertionRequest({
          "x-appattest-keyid": b64Encode(new Uint8Array(32).fill(1)),
          "x-appattest-assertion": "AAAA",
          "x-appattest-challenge": challenge,
        }),
        ctx,
      );
      expect(result).toEqual({
        ok: false,
        status: 401,
        reason: "unknown App Attest key — register first",
      });
    });

    it("rejects a replayed challenge", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const first = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 1, {
        challenge,
      });
      expect(first?.ok).toBe(true);
      const replay = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 2, {
        challenge,
      });
      expect(replay?.ok).toBe(false);
      if (replay !== null && replay.ok === false) {
        expect(replay.reason).toContain("challenge");
      }
    });

    it("accepts at most one of many concurrent replays of a single assertion", async () => {
      // A captured (keyId, assertion, challenge) triple fired N times in
      // parallel must not all pass: the challenge is claimed atomically.
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const assertion = await buildAssertion({
        challenge,
        appId: APP_ID,
        counter: 1,
        signingKey: device.leafKeys.privateKey,
      });
      const fire = () =>
        verifier.verify(
          assertionRequest({
            "x-appattest-keyid": device.keyId,
            "x-appattest-assertion": assertion,
            "x-appattest-challenge": challenge,
          }),
          ctx,
        );
      const results = await Promise.all([fire(), fire(), fire(), fire(), fire()]);
      const accepted = results.filter((r) => r !== null && r.ok === true);
      expect(accepted).toHaveLength(1);
    });

    it("rejects a counter replay", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const first = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 5);
      expect(first?.ok).toBe(true);
      const replay = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 5);
      expect(replay?.ok).toBe(false);
      if (replay !== null && replay.ok === false) {
        expect(replay.reason).toContain("counter");
      }
      const lower = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 4);
      expect(lower?.ok).toBe(false);
    });

    it("rejects a tampered signature", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const result = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 1, {
        tamperSignature: true,
      });
      expect(result?.ok).toBe(false);
      if (result !== null && result.ok === false) {
        expect(result.reason).toContain("signature");
      }
    });

    it("rejects a signature from a different key", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const otherKeys = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const result = await assertOnce(verifier, ctx, device.keyId, otherKeys.privateKey, 1);
      expect(result?.ok).toBe(false);
    });

    it("rejects an rpIdHash for a different appId", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const wrongHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", utf8("OTHER.com.example.app")),
      );
      const result = await assertOnce(verifier, ctx, device.keyId, device.leafKeys.privateKey, 1, {
        rpIdHashOverride: wrongHash,
      });
      expect(result?.ok).toBe(false);
      if (result !== null && result.ok === false) {
        expect(result.reason).toContain("rpIdHash");
      }
    });

    it("rejects a malformed assertion", async () => {
      const ctx = makeCtx();
      const verifier = makeVerifier(ctx);
      const device = await registerDevice(verifier, ctx);
      const challenge = await issueChallenge(verifier, ctx);
      const result = await verifier.verify(
        assertionRequest({
          "x-appattest-keyid": device.keyId,
          "x-appattest-assertion": "!!!not base64 cbor!!!",
          "x-appattest-challenge": challenge,
        }),
        ctx,
      );
      expect(result?.ok).toBe(false);
    });
  });
});
