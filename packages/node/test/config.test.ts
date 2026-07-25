import {
  ConfigError,
  createOmniApp,
  MemoryStorageAdapter,
  parseConfigObject,
  silentLogger,
} from "@omni-model/core";
import { describe, expect, it } from "vitest";
import { resolveConfigSource } from "../src/config.js";

describe("resolveConfigSource", () => {
  it("combines full JSON, named JSON blocks and flat overrides", () => {
    const result = resolveConfigSource({
      env: {
        OMNI_CONFIG_JSON: '{"storage":{"type":"memory"},"security":{"providers":[]}}',
        OMNI_SECURITY_PROVIDERS_JSON: '[{"type":"jwt","secret":"test-jwt-secret"}]',
        OMNI_PROVIDERS_JSON: '{"main":{"type":"openai","apiKey":"sk-test"}}',
        OMNI_DEFAULT_PROVIDER: "main",
        OMNI__SERVER__LOG_LEVEL: "silent",
      },
    });

    expect(result.source).toBe("environment variables");
    expect(result.config).toMatchObject({
      storage: { type: "memory" },
      security: { providers: [{ type: "jwt" }] },
      providers: { main: { type: "openai" } },
      routing: { defaultProvider: "main" },
      server: { logLevel: "silent" },
    });
  });

  it("treats an empty environment as unconfigured rather than an error", () => {
    // Booting unconfigured is a valid state now: the proxy serves /healthz,
    // answers /v1 with 503, and waits to be configured.
    expect(resolveConfigSource({ env: {} })).toEqual({ config: undefined, source: "none" });
  });

  it("rejects removed variables instead of silently ignoring them", () => {
    // Ignoring these would look like the setting had been applied.
    expect(() => resolveConfigSource({ env: { OMNI_CONFIG: "version: 1" } })).toThrow(ConfigError);
    expect(() => resolveConfigSource({ env: { OMNI_CONFIG: "version: 1" } })).toThrow(
      /OMNI_CONFIG_JSON/,
    );
    expect(() => resolveConfigSource({ env: { OMNI_CONFIG_PATH: "/etc/omni.yaml" } })).toThrow(
      /OMNI_CONFIG_JSON/,
    );
  });
});

describe("container starter configuration", () => {
  /**
   * The documented Docker starter env: Postgres storage, one OpenAI-compatible
   * upstream, App Check plus a JWT fallback. Asserts the env shortcuts still
   * compose into a config that boots — this is the path every `docker run`
   * takes, so a broken shortcut is a broken deploy.
   */
  const starterEnv = (): Record<string, string> => ({
    OMNI_STORAGE_TYPE: "postgres",
    OMNI_STORAGE_POSTGRES_URL: "postgres://localhost:5432/omni",
    OMNI_SECURITY_JWT_ENABLED: "true",
    OMNI_SECURITY_JWT_SECRET: "test-jwt-secret",
    OMNI_SECURITY_JWT_ALGORITHMS: '["HS256"]',
    OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "true",
    OMNI_SECURITY_FIREBASE_APPCHECK_PROJECT_NUMBER: "1234567890",
    OMNI_SECURITY_MODE: "any",
    OMNI_PROVIDERS_DEFAULT_TYPE: "openai-compatible",
    OMNI_PROVIDERS_DEFAULT_BASE_URL: "https://api.openai.com/v1",
    OMNI_PROVIDERS_DEFAULT_API_KEY: "sk-test",
  });

  it("composes storage, providers and both verifiers from environment shortcuts", () => {
    const env = starterEnv();
    const config = parseConfigObject(resolveConfigSource({ env }).config, env);

    expect(config.storage).toMatchObject({
      type: "postgres",
      url: "postgres://localhost:5432/omni",
    });
    expect(config.security.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "jwt" }),
        expect.objectContaining({ type: "firebase-app-check" }),
      ]),
    );
    expect(config.providers.default).toEqual({
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    });
    expect(config.routing.defaultProvider).toBe("default");
  });

  it("boots an app that serves /healthz", async () => {
    // Drop App Check so the app builds without a Firebase Admin token consumer,
    // and swap in memory storage so no database is required.
    const env = { ...starterEnv(), OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "false" };
    const config = parseConfigObject(resolveConfigSource({ env }).config, env);
    expect(config.security.providers).toMatchObject([{ type: "jwt" }]);

    const app = await createOmniApp({
      config,
      env,
      logger: silentLogger,
      storage: new MemoryStorageAdapter(),
    });
    const response = await app.request("http://omni.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
