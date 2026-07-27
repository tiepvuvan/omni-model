import { describe, expect, it, vi } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import {
  googlePlayIntegrityRequestHash,
  googlePlayIntegrityVerifierFactory,
} from "../../src/auth/verifiers/google-play-integrity.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import type { GoogleAccessTokenProvider, RuntimeContext } from "../../src/types.js";

const NOW = 1_750_000_000_000;
const BODY = '{"model":"gpt"}';
const PACKAGE = "com.example.app";

function runtime(
  fetchImpl: typeof fetch,
  getGoogleAccessToken?: GoogleAccessTokenProvider,
): RuntimeContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => NOW,
    waitUntil: () => {},
    log: silentLogger,
    ...(getGoogleAccessToken === undefined ? {} : { getGoogleAccessToken }),
  };
}

function context(fetchImpl: typeof fetch, maxInputTokens = 1024): VerifyContext {
  return {
    ...runtime(fetchImpl),
    storage: new MemoryStorageAdapter(),
    clientIp: null,
    maxInputTokens,
  };
}

function request(body = BODY): Request {
  return new Request("https://proxy.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-google-play-integrity": "encrypted-integrity-token",
    },
    body,
  });
}

async function validResponse(
  overrides: {
    requestDetails?: Record<string, unknown>;
    appIntegrity?: Record<string, unknown>;
    deviceIntegrity?: Record<string, unknown>;
    accountDetails?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const hash = await googlePlayIntegrityRequestHash(
    "POST",
    "/v1/chat/completions",
    new TextEncoder().encode(BODY),
  );
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: PACKAGE,
        requestHash: hash,
        timestampMillis: String(NOW - 10_000),
        ...overrides.requestDetails,
      },
      appIntegrity: {
        appRecognitionVerdict: "PLAY_RECOGNIZED",
        packageName: PACKAGE,
        certificateSha256Digest: ["cert-a"],
        versionCode: "42",
        ...overrides.appIntegrity,
      },
      deviceIntegrity: {
        deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
        ...overrides.deviceIntegrity,
      },
      accountDetails: {
        appLicensingVerdict: "LICENSED",
        ...overrides.accountDetails,
      },
      environmentDetails: { playProtectVerdict: "NO_ISSUES" },
      testingDetails: { isTestingResponse: true },
    },
  };
}

describe("googlePlayIntegrityRequestHash", () => {
  it("has a fixed cross-language canonical form", async () => {
    await expect(
      googlePlayIntegrityRequestHash(
        "post",
        "/v1/chat/completions",
        new TextEncoder().encode(BODY),
      ),
    ).resolves.toBe("mPzUlAej70tiwv2iHqDItGiqCEqlc0nKfk1lsJlP4gw");
  });
});

describe("googlePlayIntegrityVerifierFactory", () => {
  it("publishes an app-layer schema and requires a Google OAuth runtime", () => {
    expect(googlePlayIntegrityVerifierFactory).toMatchObject({
      type: "google-play-integrity",
      layer: "app",
    });
    expect(() =>
      googlePlayIntegrityVerifierFactory.create({ packageName: PACKAGE }, runtime(fetch)),
    ).toThrow(ConfigError);
    expect(() =>
      googlePlayIntegrityVerifierFactory.create(
        { packageName: PACKAGE, maxAge: "later" },
        runtime(fetch, async () => "access-token"),
      ),
    ).toThrow(/maxAge/);
  });

  it("rejects malformed service-account JSON without echoing it", () => {
    const key = '{"private_key":"do-not-echo"}';
    try {
      googlePlayIntegrityVerifierFactory.create(
        { packageName: PACKAGE, serviceAccountKey: key },
        runtime(fetch, async () => "access-token"),
      );
      throw new Error("expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).not.toContain("do-not-echo");
    }
  });

  it("returns null without its header and performs no OAuth or decode call", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const getGoogleAccessToken = vi.fn<GoogleAccessTokenProvider>(async () => "access-token");
    const verifier = googlePlayIntegrityVerifierFactory.create(
      { packageName: PACKAGE },
      runtime(fetchImpl, getGoogleAccessToken),
    );
    expect(
      await verifier.verify(new Request("https://proxy.test/v1/models"), context(fetchImpl)),
    ).toBeNull();
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decodes a Standard token and enforces the exact request binding", async () => {
    const serviceAccountKey = JSON.stringify({
      type: "service_account",
      client_email: "play@example.iam.gserviceaccount.com",
      private_key: "private-key",
    });
    const getGoogleAccessToken = vi.fn<GoogleAccessTokenProvider>(async () => "access-token");
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(
        "https://playintegrity.googleapis.com/v1/com.example.app:decodeIntegrityToken",
      );
      expect(init?.headers).toEqual({
        authorization: "Bearer access-token",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        integrityToken: "encrypted-integrity-token",
      });
      return Response.json(await validResponse());
    });
    const verifier = googlePlayIntegrityVerifierFactory.create(
      {
        packageName: PACKAGE,
        serviceAccountKey,
        requireLicensed: true,
        certificateSha256Digests: ["cert-a"],
      },
      runtime(fetchImpl, getGoogleAccessToken),
    );
    const result = await verifier.verify(request(), context(fetchImpl));

    expect(getGoogleAccessToken).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/playintegrity"],
      serviceAccountKey,
    });
    expect(result).toEqual({
      ok: true,
      identity: {
        provider: "google-play-integrity",
        claims: {
          appIntegrity: {
            appRecognitionVerdict: "PLAY_RECOGNIZED",
            packageName: PACKAGE,
            certificateSha256Digest: ["cert-a"],
            versionCode: "42",
          },
          deviceIntegrity: {
            deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"],
          },
          accountDetails: { appLicensingVerdict: "LICENSED" },
          environmentDetails: { playProtectVerdict: "NO_ISSUES" },
          testingDetails: { isTestingResponse: true },
        },
      },
    });
  });

  it.each([
    [
      { requestDetails: { requestHash: "wrong" } },
      "Google Play Integrity request binding is invalid",
    ],
    [
      { requestDetails: { requestPackageName: "com.evil.app" } },
      "Google Play Integrity request binding is invalid",
    ],
    [
      { requestDetails: { timestampMillis: String(NOW - 121_000) } },
      "Google Play Integrity request binding is invalid",
    ],
    [
      { requestDetails: { timestampMillis: String(NOW + 31_000) } },
      "Google Play Integrity request binding is invalid",
    ],
    [
      { appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } },
      "Google Play did not recognize this app version",
    ],
    [
      { deviceIntegrity: { deviceRecognitionVerdict: [] } },
      "Google Play device integrity requirement was not met",
    ],
  ])("rejects a decoded verdict that violates required policy", async (overrides, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(await validResponse(overrides)),
    );
    const verifier = googlePlayIntegrityVerifierFactory.create(
      { packageName: PACKAGE },
      runtime(fetchImpl, async () => "access-token"),
    );
    expect(await verifier.verify(request(), context(fetchImpl))).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("supports licensing, certificate pins, and alternate accepted device labels", async () => {
    const cases = [
      {
        options: { requireLicensed: true },
        overrides: { accountDetails: { appLicensingVerdict: "UNLICENSED" } },
        reason: "Google Play app license is required",
      },
      {
        options: { certificateSha256Digests: ["other-cert"] },
        overrides: {},
        reason: "Google Play app certificate is not allowed",
      },
    ];
    for (const entry of cases) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(await validResponse(entry.overrides)),
      );
      const verifier = googlePlayIntegrityVerifierFactory.create(
        { packageName: PACKAGE, ...entry.options },
        runtime(fetchImpl, async () => "access-token"),
      );
      expect(await verifier.verify(request(), context(fetchImpl))).toMatchObject({
        ok: false,
        reason: entry.reason,
      });
    }

    const virtualFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        await validResponse({
          deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_VIRTUAL_INTEGRITY"] },
        }),
      ),
    );
    const virtual = googlePlayIntegrityVerifierFactory.create(
      {
        packageName: PACKAGE,
        deviceRecognitionVerdicts: ["MEETS_VIRTUAL_INTEGRITY"],
      },
      runtime(virtualFetch, async () => "access-token"),
    );
    expect(await virtual.verify(request(), context(virtualFetch))).toMatchObject({ ok: true });
  });

  it("rejects an oversized body before OAuth or upstream work", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const getGoogleAccessToken = vi.fn<GoogleAccessTokenProvider>(async () => "access-token");
    const verifier = googlePlayIntegrityVerifierFactory.create(
      { packageName: PACKAGE },
      runtime(fetchImpl, getGoogleAccessToken),
    );
    expect(await verifier.verify(request("too-large"), context(fetchImpl, 1))).toEqual({
      ok: false,
      status: 413,
      reason: "request input exceeds the configured token limit",
    });
    expect(getGoogleAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies invalid tokens separately from service failures", async () => {
    const invalidFetch = vi.fn<typeof fetch>(async () => new Response("invalid", { status: 400 }));
    const invalid = googlePlayIntegrityVerifierFactory.create(
      { packageName: PACKAGE },
      runtime(invalidFetch, async () => "access-token"),
    );
    expect(await invalid.verify(request(), context(invalidFetch))).toMatchObject({
      ok: false,
      reason: "Google Play Integrity token was rejected",
    });

    const unavailable = {
      ok: false,
      status: 503,
      reason: "Google Play Integrity verification unavailable",
    };
    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 })),
      vi.fn<typeof fetch>(async () => Response.json({ tokenPayloadExternal: {} })),
    ]) {
      const verifier = googlePlayIntegrityVerifierFactory.create(
        { packageName: PACKAGE },
        runtime(fetchImpl, async () => "access-token"),
      );
      expect(await verifier.verify(request(), context(fetchImpl))).toEqual(unavailable);
    }
  });

  it("fails closed when Google credentials cannot produce an access token", async () => {
    const verifier = googlePlayIntegrityVerifierFactory.create(
      { packageName: PACKAGE },
      runtime(fetch, async () => {
        throw new Error("credentials unavailable");
      }),
    );
    expect(await verifier.verify(request(), context(fetch))).toEqual({
      ok: false,
      status: 503,
      reason: "Google Play Integrity verification unavailable",
    });
  });
});
