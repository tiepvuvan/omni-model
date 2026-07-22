import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ConfigError, createOmniApp, parseConfigObject, silentLogger } from "@omni-model/core";
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
  it("ships a valid authenticated environment-only starter configuration", async () => {
    const appJsonPath = fileURLToPath(new URL("../../../app.json", import.meta.url));
    const appJson = JSON.parse(await readFile(appJsonPath, "utf8")) as {
      env: Record<string, { required?: boolean; value?: string }>;
      options: { "max-instances"?: number };
      repository: string;
    };

    expect(appJson.repository).toBe("https://github.com/tiepvuvan/omni-model");
    expect(appJson.options["max-instances"]).toBe(1);
    expect(appJson.env.OPENAI_API_KEY?.required).toBe(true);
    expect(appJson.env.OMNI_JWT_SECRET?.required).toBe(true);
    expect(appJson.env.OMNI_CONFIG).toBeUndefined();

    const env = Object.fromEntries(
      Object.entries(appJson.env).map(([key, definition]) => [key, definition.value]),
    );
    env.OPENAI_API_KEY = "sk-test";
    env.OMNI_JWT_SECRET = "test-jwt-secret";
    const source = resolveConfigSource({ env });
    const config = parseConfigObject(source.config, env);

    expect(config.storage.type).toBe("memory");
    expect(config.security.providers).toMatchObject([{ type: "jwt" }]);

    const app = await createOmniApp({ config, env, logger: silentLogger });
    expect(app.request("http://omni.test/healthz")).toMatchObject({ status: 200 });
  });
});
