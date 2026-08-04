import { describe, expect, it, vi } from "vitest";
import type { VerifyContext } from "../../src/auth/types.js";
import { recaptchaEnterpriseVerifierFactory } from "../../src/auth/verifiers/recaptcha-enterprise.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import type { GoogleAccessTokenProvider, RuntimeContext } from "../../src/types.js";

const baseOptions = {
  projectId: "risk-project",
  siteKey: "site-key",
  apiKey: "server-api-key",
  expectedAction: "chat",
  minScore: 0.6,
};

function runtime(
  fetchImpl: typeof fetch,
  getGoogleAccessToken?: GoogleAccessTokenProvider,
): RuntimeContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => 1_750_000_000_000,
    waitUntil: () => {},
    log: silentLogger,
    ...(getGoogleAccessToken === undefined ? {} : { getGoogleAccessToken }),
  };
}

function context(fetchImpl: typeof fetch): VerifyContext {
  return {
    ...runtime(fetchImpl),
    storage: new MemoryStorageAdapter(),
    clientIp: "203.0.113.9",
    maxInputTokens: 1024,
  };
}

function request(token = "recaptcha-token"): Request {
  return new Request("https://proxy.test/v1/chat/completions", {
    headers: { "x-recaptcha-token": token, "user-agent": "test-agent/1.0" },
  });
}

function successfulAssessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenProperties: {
      valid: true,
      action: "chat",
      hostname: "app.example.com",
      createTime: "2026-07-27T00:00:00Z",
    },
    riskAnalysis: { score: 0.9, reasons: ["AUTOMATION"], challenge: "PASS" },
    event: { token: "must-not-be-exposed", siteKey: "site-key" },
    ...overrides,
  };
}

describe("recaptchaEnterpriseVerifierFactory", () => {
  it("publishes an app-layer schema and validates credential choices", () => {
    expect(recaptchaEnterpriseVerifierFactory).toMatchObject({
      type: "recaptcha-enterprise",
      layer: "app",
    });
    expect(() =>
      recaptchaEnterpriseVerifierFactory.create(
        { ...baseOptions, serviceAccountKey: "{}" },
        runtime(fetch),
      ),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      recaptchaEnterpriseVerifierFactory.create(
        { ...baseOptions, apiKey: undefined },
        runtime(fetch),
      ),
    ).toThrow(ConfigError);
  });

  it("rejects malformed service-account JSON without echoing it", () => {
    const credential = '{"private_key":"do-not-echo"}';
    try {
      recaptchaEnterpriseVerifierFactory.create(
        { ...baseOptions, apiKey: undefined, serviceAccountKey: credential },
        runtime(fetch, async () => "access-token"),
      );
      throw new Error("expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).not.toContain("do-not-echo");
    }
  });

  it("returns null without its header and makes no assessment", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const verifier = recaptchaEnterpriseVerifierFactory.create(baseOptions, runtime(fetchImpl));
    expect(
      await verifier.verify(new Request("https://proxy.test/v1/models"), context(fetchImpl)),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preflights the project, site key, and API key with a synthetic assessment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        event: {
          token: "omni-model-configuration-test",
          siteKey: "site-key",
          expectedAction: "chat",
        },
      });
      return Response.json({
        tokenProperties: { valid: false, invalidReason: "MALFORMED" },
        riskAnalysis: {},
      });
    });
    const ctx = runtime(fetchImpl);
    const verifier = recaptchaEnterpriseVerifierFactory.create(baseOptions, ctx);

    expect(await verifier.testConfiguration?.(ctx)).toMatchObject({
      ok: true,
      message: expect.stringContaining("project, site key"),
    });
  });

  it("reports a project or credential refusal without its API key", async () => {
    const ctx = runtime(
      vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 })),
    );
    const verifier = recaptchaEnterpriseVerifierFactory.create(baseOptions, ctx);

    const result = await verifier.testConfiguration?.(ctx);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(result)).not.toContain("server-api-key");
  });

  it("creates an API-key assessment with action, user agent and trusted IP", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe(
        "https://recaptchaenterprise.googleapis.com/v1/projects/risk-project/assessments",
      );
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-goog-api-key": "server-api-key",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        event: {
          token: "recaptcha-token",
          siteKey: "site-key",
          expectedAction: "chat",
          userAgent: "test-agent/1.0",
          userIpAddress: "203.0.113.9",
        },
      });
      return Response.json(successfulAssessment());
    });
    const verifier = recaptchaEnterpriseVerifierFactory.create(
      { ...baseOptions, hostnames: ["app.example.com"] },
      runtime(fetchImpl),
    );
    const result = await verifier.verify(request(), context(fetchImpl));

    expect(result).toEqual({
      ok: true,
      identity: {
        provider: "recaptcha-enterprise",
        claims: {
          score: 0.9,
          reasons: ["AUTOMATION"],
          action: "chat",
          createTime: "2026-07-27T00:00:00Z",
          hostname: "app.example.com",
          challenge: "PASS",
        },
      },
    });
  });

  it("uses OAuth with the required scope and explicit service account", async () => {
    const key = JSON.stringify({
      type: "service_account",
      client_email: "verifier@example.iam.gserviceaccount.com",
      private_key: "private-key",
    });
    const getGoogleAccessToken = vi.fn<GoogleAccessTokenProvider>(async () => "access-token");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer access-token" });
      return Response.json(successfulAssessment());
    });
    const verifier = recaptchaEnterpriseVerifierFactory.create(
      { ...baseOptions, apiKey: undefined, serviceAccountKey: key },
      runtime(fetchImpl, getGoogleAccessToken),
    );
    expect(await verifier.verify(request(), context(fetchImpl))).toMatchObject({ ok: true });
    expect(getGoogleAccessToken).toHaveBeenCalledWith({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      serviceAccountKey: key,
    });
  });

  it.each([
    [
      successfulAssessment({
        tokenProperties: { valid: false, invalidReason: "DUPE" },
      }),
      "reCAPTCHA Enterprise token was rejected",
    ],
    [
      successfulAssessment({
        tokenProperties: { valid: true, action: "other" },
      }),
      "reCAPTCHA Enterprise action does not match",
    ],
    [
      successfulAssessment({ riskAnalysis: { score: 0.2 } }),
      "reCAPTCHA Enterprise score is too low",
    ],
    [
      successfulAssessment({
        tokenProperties: { valid: true, action: "chat", hostname: "evil.example" },
      }),
      "reCAPTCHA Enterprise origin is not allowed",
    ],
  ])("rejects an assessment that violates policy", async (body, reason) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body));
    const verifier = recaptchaEnterpriseVerifierFactory.create(
      { ...baseOptions, hostnames: ["app.example.com"] },
      runtime(fetchImpl),
    );
    expect(await verifier.verify(request(), context(fetchImpl))).toMatchObject({
      ok: false,
      reason,
    });
  });

  it("accepts an allowed Android package as an origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(
        successfulAssessment({
          tokenProperties: {
            valid: true,
            action: "chat",
            androidPackageName: "com.example.app",
          },
        }),
      ),
    );
    const verifier = recaptchaEnterpriseVerifierFactory.create(
      { ...baseOptions, androidPackageNames: ["com.example.app"] },
      runtime(fetchImpl),
    );
    expect(await verifier.verify(request(), context(fetchImpl))).toMatchObject({ ok: true });
  });

  it("fails closed on auth, network, HTTP and malformed assessment failures", async () => {
    const unavailable = {
      ok: false,
      status: 503,
      reason: "reCAPTCHA Enterprise verification unavailable",
    };
    const oauthFailure = recaptchaEnterpriseVerifierFactory.create(
      { ...baseOptions, apiKey: undefined },
      runtime(fetch, async () => {
        throw new Error("no credentials");
      }),
    );
    expect(await oauthFailure.verify(request(), context(fetch))).toEqual(unavailable);

    for (const fetchImpl of [
      vi.fn<typeof fetch>(async () => {
        throw new Error("offline");
      }),
      vi.fn<typeof fetch>(async () => new Response("forbidden", { status: 403 })),
      vi.fn<typeof fetch>(async () => Response.json({ riskAnalysis: { score: 1 } })),
    ]) {
      const verifier = recaptchaEnterpriseVerifierFactory.create(baseOptions, runtime(fetchImpl));
      expect(await verifier.verify(request(), context(fetchImpl))).toEqual(unavailable);
    }
  });
});
