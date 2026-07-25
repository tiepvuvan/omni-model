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

const APP_CHECK_WITHOUT_PROJECT_NUMBER = {
  version: 1,
  server: { logLevel: "silent" },
  storage: { type: "memory" },
  security: { providers: [{ type: "firebase-app-check" }] },
  providers: { main: { type: "openai", apiKey: "sk-test" } },
  routing: { defaultProvider: "main" },
};

const CONSUMING_APP_CHECK_CONFIG = {
  ...APP_CHECK_WITHOUT_PROJECT_NUMBER,
  security: {
    providers: [{ type: "firebase-app-check", projectNumber: "1234567890", consume: true }],
  },
};

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

  it("boots unconfigured when App Check has no project number, and says why", async () => {
    // A container has no GCE metadata server, so `projectNumber` (or
    // OMNI_GCP_PROJECT_NUMBER) must be supplied. The proxy now stays up and
    // refuses traffic rather than crash-looping, so an operator can read
    // /readyz and fix it — but /v1 must not serve while it is broken.
    const bannedFetch: typeof fetch = () => Promise.reject(new Error("no network in this test"));

    running = await startServer({
      config: APP_CHECK_WITHOUT_PROJECT_NUMBER,
      env: {},
      fetch: bannedFetch,
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });
    const base = `http://127.0.0.1:${running.port}`;

    // Liveness still passes: the platform must not restart it in a loop.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    const readyBody = (await ready.json()) as { status: string; error: string | null };
    expect(readyBody.status).toBe("not_configured");
    expect(readyBody.error).toMatch(/projectNumber/);

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(503);
    const chatBody = (await chat.json()) as { error: { code: string } };
    expect(chatBody.error.code).toBe("not_configured");
    // The public error must not leak configuration detail to an unauthenticated caller.
    expect(JSON.stringify(chatBody)).not.toMatch(/projectNumber/);
  });

  it("nothing was seeded when the environment configuration is unusable", async () => {
    // A rejected seed must not become revision 1: the next boot would then load
    // a broken revision from the database instead of retrying the environment.
    running = await startServer({
      config: APP_CHECK_WITHOUT_PROJECT_NUMBER,
      env: {},
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(await running.configStore.loadActive()).toBeNull();
    expect(await running.configStore.history()).toEqual([]);
  });

  it("reads the App Check project number from OMNI_GCP_PROJECT_NUMBER", async () => {
    running = await startServer({
      config: APP_CHECK_WITHOUT_PROJECT_NUMBER,
      env: { OMNI_GCP_PROJECT_NUMBER: "1234567890", FIREBASE_PROJECT_ID: "omni-test-project" },
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(running.port).toBeGreaterThan(0);
  });

  it("injects the Firebase Admin consumer when App Check replay protection is enabled", async () => {
    running = await startServer({
      config: CONSUMING_APP_CHECK_CONFIG,
      env: { FIREBASE_PROJECT_ID: "omni-test-project" },
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });

    expect(running.port).toBeGreaterThan(0);
  });

  it("rejects an unknown storage type, listing memory and postgres as registered", async () => {
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
  });

  it("binds a port even when the configuration is invalid, refusing /v1", async () => {
    // Distinguishing "unconfigured" from "misconfigured" is the operator's job,
    // not the platform's: both keep the process alive and both close /v1.
    running = await startServer({
      config: { version: 2 },
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });
    const base = `http://127.0.0.1:${running.port}`;

    expect(running.port).toBeGreaterThan(0);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/v1/models`)).status).toBe(503);
    expect(running.holder.status().lastError).toMatch(/version/);
  });

  it("becomes ready once a usable configuration is saved, with no restart", async () => {
    running = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      logger: silentLogger,
    });
    const base = `http://127.0.0.1:${running.port}`;
    expect((await fetch(`${base}/readyz`)).status).toBe(503);

    await running.configStore.save(CONFIG);
    // The watcher is what applies it; give the in-process notification a tick.
    await new Promise((resolve) => setImmediate(resolve));

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", revision: 1 });

    // /v1 is live, and closed to unauthenticated callers.
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.status).toBe(401);
  });
});
