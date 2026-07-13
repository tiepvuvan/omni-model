import { describe, expect, it } from "vitest";
import type { Identity } from "../../src/auth/types.js";
import { buildRequestFacts, extractClientIp } from "../../src/server/facts.js";

const NOW = 1_750_000_000_000;

function build(overrides: Partial<Parameters<typeof buildRequestFacts>[0]> = {}) {
  return buildRequestFacts({
    method: "POST",
    path: "/v1/chat/completions",
    headers: new Headers(),
    ip: null,
    body: null,
    identity: null,
    now: NOW,
    ...overrides,
  });
}

describe("extractClientIp", () => {
  it("prefers cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2",
      "x-real-ip": "3.3.3.3",
    });
    expect(extractClientIp(headers)).toBe("1.1.1.1");
  });

  it("uses the first x-forwarded-for entry, trimmed", () => {
    const headers = new Headers({ "x-forwarded-for": " 2.2.2.2 , 10.0.0.1, 10.0.0.2" });
    expect(extractClientIp(headers)).toBe("2.2.2.2");
  });

  it("falls back to x-real-ip, then null", () => {
    expect(extractClientIp(new Headers({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(extractClientIp(new Headers())).toBeNull();
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
      stream: true,
      messageCount: 2,
      maxTokens: 100,
      temperature: 0.5,
      user: "client-user",
    });
    expect(facts.now).toBe(NOW);
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
      stream: false,
      messageCount: 0,
      maxTokens: null,
      temperature: null,
      user: null,
    });
    const embedFacts = build({ body: { model: "embed-1" } });
    expect(embedFacts.request.model).toBe("embed-1");
    expect(embedFacts.request.messageCount).toBe(0);
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

  it("maps an anonymous request to unauthenticated facts", () => {
    const facts = build({});
    expect(facts.user).toEqual({ id: null, authenticated: false, provider: null, claims: {} });
    expect(facts.device.id).toBeNull();
  });

  it("maps identity to user/device facts", () => {
    const identity: Identity = {
      provider: "fake-auth",
      userId: "u1",
      deviceId: "d1",
      claims: { tier: "pro" },
    };
    const facts = build({ identity, ip: "9.9.9.9" });
    expect(facts.user).toEqual({
      id: "u1",
      authenticated: true,
      provider: "fake-auth",
      claims: { tier: "pro" },
    });
    expect(facts.device.id).toBe("d1");
    expect(facts.http.ip).toBe("9.9.9.9");
    expect(facts.http.method).toBe("POST");
    expect(facts.http.path).toBe("/v1/chat/completions");
  });
});
