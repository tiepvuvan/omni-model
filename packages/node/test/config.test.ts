import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

  it("rejects missing environment configuration and ignores removed YAML variables", () => {
    expect(() => resolveConfigSource({ env: {} })).toThrow(ConfigError);
    expect(() => resolveConfigSource({ env: { OMNI_CONFIG: "version: 1" } })).toThrow(
      /OMNI_CONFIG_JSON/,
    );
  });
});

describe("Cloud Run deploy button", () => {
  it("ships a valid GCP-oriented, environment-only starter configuration", async () => {
    const appJsonPath = fileURLToPath(new URL("../../../app.json", import.meta.url));
    const appJson = JSON.parse(await readFile(appJsonPath, "utf8")) as {
      env: Record<string, { required?: boolean; value?: string }>;
      options: { "max-instances"?: number };
      repository: string;
    };

    expect(appJson.repository).toBe("https://github.com/tiepvuvan/omni-model");
    expect(appJson.options["max-instances"]).toBe(1);
    expect(appJson.env.OMNI_STORAGE_TYPE?.value).toBe("firestore");
    expect(appJson.env.OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED?.value).toBe("true");
    expect(appJson.env.OMNI_SECURITY_FIREBASE_APPCHECK_CONSUME?.value).toBe("false");
    expect(appJson.env.OMNI_PROVIDERS_DEFAULT_TYPE?.value).toBe("openai-compatible");
    expect(appJson.env.OMNI_PROVIDERS_DEFAULT_API_KEY?.required).toBe(false);
    expect(appJson.env.OMNI_CONFIG).toBeUndefined();

    const env = Object.fromEntries(
      Object.entries(appJson.env).map(([key, definition]) => [key, definition.value]),
    );
    env.OMNI_JWT_SECRET = "test-jwt-secret";
    env.OMNI_GCP_PROJECT_NUMBER = "1234567890";
    const source = resolveConfigSource({ env });
    const config = parseConfigObject(source.config, env);

    expect(config.storage.type).toBe("firestore");
    expect(config.security.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "jwt" }),
        expect.objectContaining({ type: "firebase-app-check" }),
      ]),
    );
    expect(config.providers.default).toEqual({
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
    });

    const evaluationEnv = {
      ...env,
      OMNI_STORAGE_TYPE: "memory",
      OMNI_SECURITY_FIREBASE_APPCHECK_ENABLED: "false",
    };
    const evaluationConfig = parseConfigObject(
      resolveConfigSource({ env: evaluationEnv }).config,
      evaluationEnv,
    );
    expect(evaluationConfig.storage.type).toBe("memory");
    expect(evaluationConfig.security.providers).toMatchObject([{ type: "jwt" }]);

    const app = await createOmniApp({
      config,
      env,
      logger: silentLogger,
      storage: new MemoryStorageAdapter(),
    });
    expect(app.request("http://omni.test/healthz")).toMatchObject({ status: 200 });
  });
});
