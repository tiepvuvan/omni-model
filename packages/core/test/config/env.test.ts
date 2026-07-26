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
  OMNI__SECURITY__USER_AUTH__TYPE: "jwt",
  OMNI__SECURITY__USER_AUTH__SECRET: JWT_SECRET_REFERENCE,
  OMNI__SECURITY__USER_AUTH__ALGORITHMS: '["HS256"]',
  OMNI__ROUTING__RULES__0__ID: "default",
  OMNI__ROUTING__RULES__0__WHEN: '"true"',
  OMNI__ROUTING__RULES__0__TARGET__TYPE: "openai",
  OMNI__ROUTING__RULES__0__TARGET__API_KEY: OPENAI_API_KEY_REFERENCE,
  OMNI__RATE_LIMITS__0__NAME: "per-user-tokens",
  OMNI__RATE_LIMITS__0__TOKENS__LIMIT: "60000",
  OMNI__RATE_LIMITS__0__TOKENS__WINDOW: "1h",
};

describe("environment configuration", () => {
  it("builds and validates a complete nested config from environment variables", () => {
    const config = parseEnvironmentConfig(STARTER_ENV);

    expect(config).toMatchObject({
      server: { logLevel: "silent", cors: { allowOrigins: ["https://app.example.com"] } },
      storage: { type: "memory" },
      security: { userAuth: { type: "jwt", secret: "test-jwt-secret", algorithms: ["HS256"] } },
      rateLimits: [{ name: "per-user-tokens", tokens: { limit: 60_000, window: "1h" } }],
      routing: {
        rules: [{ id: "default", when: "true", target: { type: "openai", apiKey: "sk-test" } }],
      },
    });
  });

  it("uses JSON literals for arrays, booleans, numbers and ambiguous strings", () => {
    const document = environmentConfigDocument({
      OMNI__SERVER__TRUST_PROXY_HEADERS: "true",
      OMNI__SERVER__MAX_BODY_BYTES: "3000000",
      OMNI__ROUTING__ALLOWED_MODELS: '["smart"]',
      OMNI__ROUTING__RULES: '[{"id":"a","when":"true","target":{"type":"openai"}}]',
    });

    expect(document).toEqual({
      server: { trustProxyHeaders: true, maxBodyBytes: 3_000_000 },
      routing: {
        allowedModels: ["smart"],
        rules: [{ id: "a", when: "true", target: { type: "openai" } }],
      },
    });
  });

  it("merges whole documents, named JSON blocks, aliases, and path overrides in precedence order", () => {
    const config = parseEnvironmentConfig({
      OPENAI_API_KEY: "sk-test",
      OMNI_CONFIG_JSON: JSON.stringify({
        version: 1,
        storage: { type: "memory" },
        security: { userAuth: { type: "jwt", secret: "test", algorithms: ["HS256"] } },
        routing: {
          rules: [
            {
              id: "slow",
              when: "true",
              target: { type: "openai", apiKey: OPENAI_API_KEY_REFERENCE },
            },
          ],
        },
      }),
      OMNI_SERVER_JSON: '{"logLevel":"warn","cors":{"allowOrigins":["https://base.example"]}}',
      OMNI_ROUTING_JSON: `{"rules":[{"id":"fast","when":"true","target":{"type":"openai-compatible","baseUrl":"https://api.example.com/v1","apiKey":"${OPENAI_API_KEY_REFERENCE}"}}]}`,
      OMNI_LOG_LEVEL: "error",
      OMNI__SERVER__CORS__ALLOW_ORIGINS: '["https://override.example"]',
      OMNI__ROUTING__ALLOWED_MODELS: '["only-this"]',
    });

    expect(config.server).toMatchObject({
      logLevel: "error",
      cors: { allowOrigins: ["https://override.example"] },
    });
    // The named JSON block replaced the whole-document rules, and the path
    // override then added to the block it did not touch.
    expect(config.routing.rules).toMatchObject([
      { id: "fast", target: { type: "openai-compatible", apiKey: "sk-test" } },
    ]);
    expect(config.routing.allowedModels).toEqual(["only-this"]);
  });

  it("builds storage, a default provider, Firebase Auth, and App Check from ergonomic variables", () => {
    const config = parseEnvironmentConfig({
      OMNI_STORAGE_TYPE: "postgres",
      OMNI_STORAGE_POSTGRES_URL: "postgres://localhost:5432/omni",
      OMNI_STORAGE_POSTGRES_MIGRATE: "false",
      OMNI_TARGET_TYPE: "openai-compatible",
      OMNI_TARGET_BASE_URL: "https://gateway.example.com/v1",
      OMNI_TARGET_API_KEY: "gateway-key",
      OMNI_TARGET_MODEL: "gpt-4o-mini",
      OMNI_SECURITY_MODE: "all",
      OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID: "my-firebase-project",
      OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER: "1234567890",
      OMNI_SECURITY_FIREBASE_APPCHECK_APP_ID: "1:1234567890:ios:abc123",
      OMNI_SECURITY_FIREBASE_APPCHECK_CONSUME: "true",
      OMNI_ROUTING_ALLOWED_MODELS: '["smart","embeddings"]',
    });

    expect(config.storage).toMatchObject({
      type: "postgres",
      url: "postgres://localhost:5432/omni",
      migrate: false,
    });
    // One catch-all rule, so the commonest deployment stays the simplest to
    // express: one provider, one key, send everything there.
    expect(config.routing).toMatchObject({
      allowedModels: ["smart", "embeddings"],
      rules: [
        {
          id: "default",
          when: "true",
          target: {
            type: "openai-compatible",
            baseUrl: "https://gateway.example.com/v1",
            apiKey: "gateway-key",
            model: "gpt-4o-mini",
          },
        },
      ],
    });
    // The two layers land in their own halves: Firebase Auth is who the user is,
    // App Check is which app it came from.
    expect(config.security).toMatchObject({
      userAuth: { type: "firebase-auth", projectId: "my-firebase-project" },
      appAuth: {
        mode: "all",
        providers: [
          {
            type: "firebase-app-check",
            projectNumber: "1234567890",
            appIds: ["1:1234567890:ios:abc123"],
            consume: true,
          },
        ],
      },
    });
  });

  it("only adds an enabled security profile and validates its boolean switch", () => {
    const disabled = environmentConfigDocument({
      OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "false",
    });
    expect(disabled.security).toBeUndefined();

    expect(() => environmentConfigDocument({ OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "yes" })).toThrow(
      /expected true or false/,
    );
  });

  it("defaults a layered app scheme to requiring every credential", () => {
    const config = parseEnvironmentConfig({
      OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID: "my-firebase-project",
      OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER: "1234567890",
    });

    expect(config.security.appAuth.mode).toBe("all");
  });

  it("refuses two user authentication methods rather than picking one", () => {
    // Whichever won would own `user.id`, and `user.id` is whose token budget a
    // request spends — too consequential to decide by variable ordering.
    expect(() =>
      parseEnvironmentConfig({
        OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "true",
        OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID: "my-firebase-project",
        OMNI_SECURITY_JWT_ENABLED: "true",
        OMNI_SECURITY_JWT_SECRET: "s".repeat(40),
      }),
    ).toThrow(/exactly one user authentication method/);
  });

  it("applies the default per-user token budget when omitted", () => {
    const config = parseEnvironmentConfig({
      OMNI_SECURITY_FIREBASE_AUTH_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_AUTH_PROJECT_ID: "my-firebase-project",
    });

    expect(config.rateLimits).toEqual([
      { name: "per-user-daily-tokens", tokens: { limit: 30_000, window: "1d" } },
    ]);
  });

  it("omits empty optional compatible-provider credentials and App Check app IDs", () => {
    const config = parseEnvironmentConfig({
      OMNI_TARGET_TYPE: "openai-compatible",
      OMNI_TARGET_BASE_URL: "https://gateway.example.com/v1",
      OMNI_TARGET_API_KEY: "",
      OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "true",
      OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER: "1234567890",
      OMNI_SECURITY_FIREBASE_APPCHECK_APP_ID: "",
    });

    expect(config.routing.rules[0]?.target).toEqual({
      type: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
    });
    expect(config.security.appAuth.providers).toEqual([
      { type: "firebase-app-check", projectNumber: "1234567890" },
    ]);
  });

  it("rejects JSON blocks with an invalid shape", () => {
    expect(() => environmentConfigDocument({ OMNI_CONFIG_JSON: "[]" })).toThrow(
      /full configuration must be a JSON object/,
    );
    expect(() => environmentConfigDocument({ OMNI_ROUTING_JSON: "not-json" })).toThrow(
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

describe("logging configuration from the environment", () => {
  it("accepts a JSON block", () => {
    // Regression: the `logging` block existed in the schema with no env block, so
    // OMNI_LOGGING_JSON was silently ignored and content capture never turned on.
    const config = parseEnvironmentConfig({
      OMNI_STORAGE_TYPE: "memory",
      OMNI_LOGGING_JSON: '{"content":true,"contentRetention":"1d","maxContentBytes":1024}',
    });
    expect(config.logging).toMatchObject({
      requests: true,
      content: true,
      contentRetention: "1d",
      maxContentBytes: 1024,
    });
  });

  it("accepts scalar shortcuts, coercing booleans", () => {
    const config = parseEnvironmentConfig({
      OMNI_STORAGE_TYPE: "memory",
      OMNI_LOGGING_REQUESTS: "false",
      OMNI_LOGGING_CONTENT: "true",
      OMNI_LOGGING_RETENTION: "90d",
    });
    expect(config.logging).toMatchObject({
      requests: false,
      content: true,
      retention: "90d",
    });
  });

  it("defaults to metadata on and content off", () => {
    const config = parseEnvironmentConfig({ OMNI_STORAGE_TYPE: "memory" });
    expect(config.logging).toMatchObject({ requests: true, content: false });
  });
});
