import {
  ConfigError,
  environmentConfigDocument,
  hasEnvironmentConfig,
  parseEnvironmentConfig,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";

const JWT_SECRET_REFERENCE = "$" + "{OMNI_JWT_SECRET}";
const OPENAI_API_KEY_REFERENCE = "$" + "{OPENAI_API_KEY}";

const STARTER_ENV = {
  OPENAI_API_KEY: "sk-test",
  OMNI_JWT_SECRET: "test-jwt-secret",
  OMNI__SERVER__LOG_LEVEL: "silent",
  OMNI__SERVER__CORS__ALLOW_ORIGINS: '["https://app.example.com"]',
  OMNI__STORAGE__TYPE: "memory",
  OMNI__SECURITY__PROVIDERS__0__TYPE: "jwt",
  OMNI__SECURITY__PROVIDERS__0__SECRET: JWT_SECRET_REFERENCE,
  OMNI__SECURITY__PROVIDERS__0__ALGORITHMS: '["HS256"]',
  OMNI__PROVIDERS__OPENAI__TYPE: "openai",
  OMNI__PROVIDERS__OPENAI__API_KEY: OPENAI_API_KEY_REFERENCE,
  OMNI__RATE_LIMITS__0__NAME: "per-user-requests",
  OMNI__RATE_LIMITS__0__KEY: "user",
  OMNI__RATE_LIMITS__0__REQUESTS__LIMIT: "60",
  OMNI__RATE_LIMITS__0__REQUESTS__WINDOW: "1m",
  OMNI__ROUTING__DEFAULT_PROVIDER: "openai",
};

describe("environment configuration", () => {
  it("builds and validates a complete nested config from environment variables", () => {
    const config = parseEnvironmentConfig(STARTER_ENV);

    expect(config).toMatchObject({
      server: { logLevel: "silent", cors: { allowOrigins: ["https://app.example.com"] } },
      storage: { type: "memory" },
      security: { providers: [{ type: "jwt", secret: "test-jwt-secret", algorithms: ["HS256"] }] },
      providers: { openai: { type: "openai", apiKey: "sk-test" } },
      rateLimits: [
        { name: "per-user-requests", key: "user", requests: { limit: 60, window: "1m" } },
      ],
      routing: { defaultProvider: "openai" },
    });
  });

  it("uses JSON literals for arrays, booleans, numbers and ambiguous strings", () => {
    const document = environmentConfigDocument({
      OMNI__SERVER__TRUST_PROXY_HEADERS: "true",
      OMNI__SERVER__MAX_BODY_BYTES: "3000000",
      OMNI__PROVIDERS__EXAMPLE__API_KEY: '"123"',
      OMNI__ROUTING: '{"defaultProvider":"provider-with-an-arbitrary-id"}',
    });

    expect(document).toEqual({
      server: { trustProxyHeaders: true, maxBodyBytes: 3_000_000 },
      providers: { example: { apiKey: "123" } },
      routing: { defaultProvider: "provider-with-an-arbitrary-id" },
    });
  });

  it("merges whole documents, named JSON blocks, aliases, and path overrides in precedence order", () => {
    const config = parseEnvironmentConfig({
      OPENAI_API_KEY: "sk-test",
      OMNI_CONFIG_JSON: JSON.stringify({
        version: 1,
        storage: { type: "memory" },
        security: { providers: [{ type: "jwt", secret: "test", algorithms: ["HS256"] }] },
        providers: { openai: { type: "openai", apiKey: OPENAI_API_KEY_REFERENCE } },
        routing: { defaultProvider: "openai" },
      }),
      OMNI_SERVER_JSON: '{"logLevel":"warn","cors":{"allowOrigins":["https://base.example"]}}',
      OMNI_PROVIDERS_JSON: `{"fast":{"type":"openai-compatible","baseUrl":"https://api.example.com/v1","apiKey":"${OPENAI_API_KEY_REFERENCE}"}}`,
      OMNI_LOG_LEVEL: "error",
      OMNI__SERVER__CORS__ALLOW_ORIGINS: '["https://override.example"]',
      OMNI__ROUTING__DEFAULT_PROVIDER: "fast",
    });

    expect(config.server).toMatchObject({
      logLevel: "error",
      cors: { allowOrigins: ["https://override.example"] },
    });
    expect(config.providers).toMatchObject({
      openai: { type: "openai", apiKey: "sk-test" },
      fast: { type: "openai-compatible", baseUrl: "https://api.example.com/v1" },
    });
    expect(config.routing.defaultProvider).toBe("fast");
  });

  it("rejects JSON blocks with an invalid shape", () => {
    expect(() => environmentConfigDocument({ OMNI_CONFIG_JSON: "[]" })).toThrow(
      /full configuration must be a JSON object/,
    );
    expect(() => environmentConfigDocument({ OMNI_PROVIDERS_JSON: "not-json" })).toThrow(
      /expected valid JSON/,
    );
  });

  it("recognizes only the dedicated environment configuration prefix", () => {
    expect(hasEnvironmentConfig({ OPENAI_API_KEY: "sk-test", OMNI_JWT_SECRET: "secret" })).toBe(
      false,
    );
    expect(hasEnvironmentConfig({ OMNI__STORAGE__TYPE: "memory" })).toBe(true);
  });

  it("rejects malformed paths and conflicting path shapes", () => {
    expect(() => environmentConfigDocument({ OMNI__: "memory" })).toThrow(ConfigError);
    expect(() =>
      environmentConfigDocument({
        OMNI__STORAGE: "memory",
        OMNI__STORAGE__TYPE: "memory",
      }),
    ).toThrow(ConfigError);
  });
});
