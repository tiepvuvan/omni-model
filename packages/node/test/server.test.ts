import { ConfigError, silentLogger } from "@omni-model/core";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.js";

/**
 * Memory storage, a jwt verifier with a static secret (to prove verifiers
 * construct in the real registry) and a dummy OpenAI provider. No request in
 * this suite ever reaches the upstream, so the key is never used.
 */
const CONFIG = {
  version: 1,
  server: { logLevel: "silent" },
  storage: { type: "memory" },
  security: { providers: [{ type: "jwt", secret: "test-shared-secret" }] },
  providers: { main: { type: "openai", apiKey: "sk-test" } },
  routing: { defaultProvider: "main" },
};

const GCP_APP_CHECK_CONFIG = {
  version: 1,
  server: { logLevel: "silent" },
  storage: { type: "memory" },
  security: { providers: [{ type: "firebase-app-check" }] },
  providers: { main: { type: "openai", apiKey: "sk-test" } },
  routing: { defaultProvider: "main" },
};

const GCP_CONSUMING_APP_CHECK_CONFIG = {
  ...GCP_APP_CHECK_CONFIG,
  security: {
    providers: [{ type: "firebase-app-check", projectNumber: "1234567890", consume: true }],
  },
};

const METADATA_HOST = "metadata.test";
const METADATA_BASE_URL = `http://${METADATA_HOST}/computeMetadata/v1/project/`;

describe("startServer", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("binds an ephemeral port, serves the app and closes cleanly", async () => {
    running = await startServer({
      config: CONFIG,
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(running.port).toBeGreaterThan(0);
    expect(running.hostname).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${running.port}`;

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    // The jwt verifier is live: unauthenticated /v1 requests are rejected.
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(401);
    const body = (await chat.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");

    await running.close();
    running = undefined;
    await expect(fetch(`${base}/healthz`)).rejects.toThrowError();
  });

  it("binds an ephemeral port when PORT=0 in the environment", async () => {
    // Regression: `Number(env.PORT) || 8787` coerced an explicit "0" to 8787.
    running = await startServer({
      config: CONFIG,
      env: { PORT: "0" },
      hostname: "127.0.0.1",
      logger: silentLogger,
    });
    expect(running.port).toBeGreaterThan(0);
    expect(running.port).not.toBe(8787);
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    expect(health.status).toBe(200);
  });

  it("discovers the App Check project number from GCP metadata before startup", async () => {
    const metadataCalls: string[] = [];
    const metadataFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      metadataCalls.push(url);
      if (url === `${METADATA_BASE_URL}project-id`) return new Response("omni-firebase-project");
      if (url === `${METADATA_BASE_URL}numeric-project-id`) return new Response("1234567890");
      throw new Error(`unexpected fetch: ${url}`);
    };

    running = await startServer({
      config: GCP_APP_CHECK_CONFIG,
      env: { GCE_METADATA_HOST: METADATA_HOST },
      fetch: metadataFetch,
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(running.port).toBeGreaterThan(0);
    expect(metadataCalls.sort()).toEqual([
      `${METADATA_BASE_URL}numeric-project-id`,
      `${METADATA_BASE_URL}project-id`,
    ]);
  });

  it("injects the Firebase Admin consumer when App Check replay protection is enabled", async () => {
    const metadataFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${METADATA_BASE_URL}project-id`) return new Response("omni-firebase-project");
      if (url === `${METADATA_BASE_URL}numeric-project-id`) return new Response("1234567890");
      throw new Error(`unexpected fetch: ${url}`);
    };

    running = await startServer({
      config: GCP_CONSUMING_APP_CHECK_CONFIG,
      env: { GCE_METADATA_HOST: METADATA_HOST },
      fetch: metadataFetch,
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(running.port).toBeGreaterThan(0);
  });

  it("rejects an unknown storage type, listing redis and postgres as registered", async () => {
    const error: unknown = await startServer({
      config: {
        server: { logLevel: "silent" },
        storage: { type: "no-such-storage" },
        security: { providers: [{ type: "jwt", secret: "test-shared-secret" }] },
        providers: { main: { type: "openai", apiKey: "sk-test" } },
        routing: { defaultProvider: "main" },
      },
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    }).then(
      () => {
        throw new Error("expected startServer to reject");
      },
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('unknown type "no-such-storage"');
    expect(message).toContain("memory");
    expect(message).toContain("postgres");
    expect(message).toContain("redis");
  });

  it("rejects an invalid environment-derived config before binding a port", async () => {
    const error: unknown = await startServer({
      config: { version: 2 },
      port: 0,
      logger: silentLogger,
    }).then(
      () => {
        throw new Error("expected startServer to reject");
      },
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ConfigError);
  });
});
