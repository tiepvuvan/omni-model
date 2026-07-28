import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/auth/types.js";
import { buildRequestFacts, extractClientIp } from "../../src/server/facts.js";

function build(overrides: Partial<Parameters<typeof buildRequestFacts>[0]> = {}) {
  return buildRequestFacts({
    method: "POST",
    path: "/v1/chat/completions",
    headers: new Headers(),
    ip: null,
    body: null,
    identity: null,
    ...overrides,
  });
}

describe("extractClientIp", () => {
  describe("with trustProxyHeaders = true (behind a trusted proxy)", () => {
    it("prefers cf-connecting-ip", () => {
      const headers = new Headers({
        "cf-connecting-ip": "1.1.1.1",
        "x-forwarded-for": "2.2.2.2",
        "x-real-ip": "3.3.3.3",
      });
      expect(extractClientIp(headers, true)).toBe("1.1.1.1");
    });

    it("uses the first x-forwarded-for entry, trimmed", () => {
      const headers = new Headers({ "x-forwarded-for": " 2.2.2.2 , 10.0.0.1, 10.0.0.2" });
      expect(extractClientIp(headers, true)).toBe("2.2.2.2");
    });

    it("falls back to x-real-ip, then null", () => {
      expect(extractClientIp(new Headers({ "x-real-ip": "3.3.3.3" }), true)).toBe("3.3.3.3");
      expect(extractClientIp(new Headers(), true)).toBeNull();
    });
  });

  describe("with trustProxyHeaders = false (default)", () => {
    it("ignores all client-suppliable forwarding headers so they cannot be spoofed", () => {
      const headers = new Headers({
        "cf-connecting-ip": "1.1.1.1",
        "x-forwarded-for": "2.2.2.2",
        "x-real-ip": "3.3.3.3",
      });
      expect(extractClientIp(headers, false)).toBeNull();
    });
  });
});

describe("buildRequestFacts", () => {
  it("extracts request fields from a chat body", () => {
    const facts = build({
      body: {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
        stream: true,
        max_tokens: 100,
        temperature: 0.5,
        user: "client-user",
      },
    });
    expect(facts.request).toEqual({
      model: "gpt-4o",
      inputTokenCount: 42,
      maxTokens: 100,
      temperature: 0.5,
    });
  });

  it("prefers max_completion_tokens over max_tokens", () => {
    const facts = build({
      body: { model: "m", messages: [], max_tokens: 100, max_completion_tokens: 42 },
    });
    expect(facts.request.maxTokens).toBe(42);
  });

  it("defaults missing fields for a null or minimal body", () => {
    const facts = build({ body: null });
    expect(facts.request).toEqual({
      model: "",
      inputTokenCount: 0,
      maxTokens: null,
      temperature: null,
    });
    const embedFacts = build({ body: { model: "embed-1" } });
    expect(embedFacts.request.model).toBe("embed-1");
    expect(embedFacts.request.inputTokenCount).toBeGreaterThan(0);
  });

  it("redacts sensitive headers but keeps them present", () => {
    const facts = build({
      headers: new Headers({
        Authorization: "Bearer secret",
        Cookie: "session=abc",
        "X-API-Key": "sk-123",
        "X-Custom": "visible",
      }),
    });
    expect(facts.http.headers.authorization).toBe("<redacted>");
    expect(facts.http.headers.cookie).toBe("<redacted>");
    expect(facts.http.headers["x-api-key"]).toBe("<redacted>");
    expect(facts.http.headers["x-custom"]).toBe("visible");
  });

  it("redacts device-attestation credential headers", () => {
    // These carry App Check / DeviceCheck / App Attest tokens and must not
    // reach CEL expressions or logs verbatim.
    const facts = build({
      headers: new Headers({
        "X-Firebase-AppCheck": "appcheck-token",
        "X-Apple-Device-Token": "devicecheck-token",
        "X-AppAttest-Assertion": "assertion-blob",
        "X-AppAttest-KeyId": "key-id",
      }),
    });
    expect(facts.http.headers["x-firebase-appcheck"]).toBe("<redacted>");
    expect(facts.http.headers["x-apple-device-token"]).toBe("<redacted>");
    expect(facts.http.headers["x-appattest-assertion"]).toBe("<redacted>");
    expect(facts.http.headers["x-appattest-keyid"]).toBe("<redacted>");
  });

  it("maps a request without identity to an empty user fact", () => {
    const facts = build({});
    expect(facts.user).toEqual({ id: null, claims: {}, providers: [] });
  });

  it("maps identity to the exact user fact surface", () => {
    const identity: Identity = {
      provider: "fake-auth",
      providers: ["fake-auth", "firebase-app-check"],
      userId: "u1",
      deviceId: "d1",
      claims: { tier: "pro" },
    };
    const facts = build({ identity, ip: "9.9.9.9" });
    expect(facts.user).toEqual({
      id: "u1",
      claims: { tier: "pro" },
      providers: ["fake-auth", "firebase-app-check"],
    });
    expect(facts.http.ip).toBe("9.9.9.9");
    expect(facts.http.method).toBe("POST");
    expect(facts.http.path).toBe("/v1/chat/completions");
  });

  it("allows a routing simulation to override the measured input token count", () => {
    const facts = build({ body: { model: "m" }, inputTokenCount: 12_345 });
    expect(facts.request.inputTokenCount).toBe(12_345);
  });
});
