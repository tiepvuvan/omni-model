import { describe, expect, it } from "vitest";
import { buildOmniConfig } from "../src/config.js";

describe("buildOmniConfig", () => {
  it("assembles providers, Firestore storage, rate limits and default provider from params", () => {
    const config = buildOmniConfig({
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-anthropic",
      DEFAULT_PROVIDER: "anthropic",
      REQUESTS_PER_HOUR: "30",
      DAILY_TOKEN_BUDGET: "500000",
      FIRESTORE_COLLECTION: "my_limits",
    });

    expect(config.providers.openai).toMatchObject({ type: "openai", apiKey: "sk-openai" });
    expect(config.providers.anthropic).toMatchObject({ type: "anthropic", apiKey: "sk-anthropic" });
    expect(config.providers.google).toBeUndefined();

    expect(config.storage).toMatchObject({ type: "firestore", collection: "my_limits" });
    expect(config.routing.defaultProvider).toBe("anthropic");

    const requestRule = config.rateLimits.find((r) => r.name === "per-user-requests");
    const tokenRule = config.rateLimits.find((r) => r.name === "per-user-daily-tokens");
    expect(requestRule?.requests).toEqual({ limit: 30, window: "1h" });
    expect(tokenRule?.tokens).toEqual({ limit: 500000, window: "1d" });
  });

  it("defaults the collection and rate limits when the params are omitted", () => {
    const config = buildOmniConfig({ GEMINI_API_KEY: "gemini-key" });
    expect(config.providers.google).toMatchObject({ type: "google", apiKey: "gemini-key" });
    expect(config.storage).toMatchObject({ type: "firestore", collection: "omni_ratelimits" });
    expect(config.routing.defaultProvider).toBe("google");
    expect(config.rateLimits.find((r) => r.name === "per-user-requests")?.requests).toEqual({
      limit: 30,
      window: "1h",
    });
    expect(config.rateLimits.find((r) => r.name === "per-user-daily-tokens")?.tokens).toEqual({
      limit: 30000,
      window: "1d",
    });
  });

  it("keeps reading the legacy request parameter with the new hour window", () => {
    const config = buildOmniConfig({
      GEMINI_API_KEY: "gemini-key",
      REQUESTS_PER_MINUTE: "45",
    });
    expect(config.rateLimits.find((r) => r.name === "per-user-requests")?.requests).toEqual({
      limit: 45,
      window: "1h",
    });
  });

  it("falls back to the first configured provider when the selected default has no key", () => {
    const config = buildOmniConfig({
      ANTHROPIC_API_KEY: "sk-anthropic",
      DEFAULT_PROVIDER: "openai",
    });
    expect(config.routing.defaultProvider).toBe("anthropic");
  });

  it("parses ADVANCED_CONFIG_JSON as a full config override", () => {
    const advanced = JSON.stringify({
      version: 1,
      storage: { type: "memory" },
      providers: { openai: { type: "openai", apiKey: "$" + "{OPENAI_API_KEY}" } },
      routing: { defaultProvider: "openai" },
    });

    const config = buildOmniConfig({
      ADVANCED_CONFIG_JSON: advanced,
      OPENAI_API_KEY: "sk-from-env",
      // Individual params are ignored when the advanced override is present.
      GEMINI_API_KEY: "ignored",
    });

    expect(config.storage.type).toBe("memory");
    expect(config.providers.openai).toMatchObject({ type: "openai", apiKey: "sk-from-env" });
    expect(config.providers.google).toBeUndefined();
  });

  it("throws when no provider API key is configured", () => {
    expect(() => buildOmniConfig({})).toThrow(/no provider API key/);
  });

  it("throws on a non-numeric integer param", () => {
    expect(() =>
      buildOmniConfig({ OPENAI_API_KEY: "sk-openai", REQUESTS_PER_HOUR: "thirty" }),
    ).toThrow(/REQUESTS_PER_HOUR/);
  });
});
