import { describe, expect, it } from "vitest";
import type { OmniConfig } from "../../src/config/schema.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import { createRegistry } from "../../src/registry.js";
import { createOmniApp } from "../../src/server/app.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

const MINIMAL_YAML = `
version: 1
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;

describe("createOmniApp startup validation", () => {
  it("rejects an unknown storage type, listing registered types", async () => {
    const yaml = `
version: 1
storage:
  type: bogus-store
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    await expect(createTestApp({ yaml })).rejects.toThrowError(ConfigError);
    await expect(createTestApp({ yaml })).rejects.toThrowError(/bogus-store.*memory/s);
  });

  it("rejects an unknown auth provider type, listing registered types", async () => {
    const yaml = `
version: 1
security:
  providers:
    - type: nonexistent-auth
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    await expect(createTestApp({ yaml })).rejects.toThrowError(/nonexistent-auth.*fake-auth/s);
  });

  it("rejects an unknown model provider type, listing registered types", async () => {
    const yaml = `
version: 1
providers:
  main:
    type: no-such-provider
routing:
  defaultProvider: main
`;
    await expect(createTestApp({ yaml })).rejects.toThrowError(/no-such-provider.*fake/s);
  });

  it("rejects a malformed config object passed directly", async () => {
    const config = { version: 1, bogusKey: true } as unknown as OmniConfig;
    await expect(
      createOmniApp({ config, registry: createRegistry(), logger: silentLogger }),
    ).rejects.toThrowError(ConfigError);
  });

  it("applies defaults to a minimal programmatic config", async () => {
    // memory storage, empty providers/routing all defaulted in. Security is the
    // one block with no safe default: a verifier is mandatory (see
    // auth.test.ts), so even a minimal config must configure one.
    const config = {
      version: 1,
      security: { providers: [{ type: "jwt", secret: "dev-secret", algorithms: ["HS256"] }] },
    } as unknown as OmniConfig;
    const app = await createOmniApp({ config, logger: silentLogger, now: () => FIXED_NOW });
    const health = await app.fetch(new Request("http://local/healthz"));
    expect(health.status).toBe(200);
  });

  it("refuses a config that would serve /v1 with no verifier", async () => {
    const config = { version: 1 } as unknown as OmniConfig;
    await expect(
      createOmniApp({ config, logger: silentLogger, now: () => FIXED_NOW }),
    ).rejects.toThrowError(ConfigError);
  });
});

describe("app basics", () => {
  it("serves /healthz", async () => {
    const { app } = await createTestApp({ yaml: MINIMAL_YAML });
    const response = await app.fetch(new Request("http://local/healthz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns an OpenAI-style 404 for unknown paths", async () => {
    const { app } = await createTestApp({ yaml: MINIMAL_YAML });
    const response = await app.fetch(new Request("http://local/nope"));
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("unknown_url");
    expect(body.error.message).toContain("/nope");
  });

  it("mounts verifier-contributed routes with storage access", async () => {
    const yaml = `
version: 1
security:
  providers:
    - type: fake-auth
      challengeRoute: true
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({ yaml, storage });
    const response = await app.fetch(new Request("http://local/auth/fake/challenge"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "abc" });
    // The route handler received a VerifyContext wired to the app's storage.
    expect(await storage.get("last-challenge")).toBe("abc");
  });
});

describe("CORS", () => {
  it("answers preflight with the configured origin", async () => {
    const yaml = `
version: 1
server:
  cors:
    allowOrigins: ["https://app.example.com"]
    allowHeaders: ["authorization", "content-type"]
security:
  providers:
    - type: fake-auth
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml });
    const response = await app.fetch(
      new Request("http://local/v1/chat/completions", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
        },
      }),
    );
    // Preflight succeeds without credentials even though auth is configured.
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
  });

  it("supports wildcard origins and decorates actual responses", async () => {
    const yaml = `
version: 1
server:
  cors:
    allowOrigins: ["*"]
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { origin: "https://anywhere.example" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sends no CORS headers when cors is not configured", async () => {
    const { app } = await createTestApp({ yaml: MINIMAL_YAML });
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { origin: "https://anywhere.example" }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
