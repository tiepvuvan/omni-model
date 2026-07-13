import { ConfigError, silentLogger } from "@omni-model/core";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server.js";

/**
 * Memory storage, a jwt verifier with a static secret (to prove verifiers
 * construct in the real registry) and a dummy OpenAI provider. No request in
 * this suite ever reaches the upstream, so the key is never used.
 */
const CONFIG_YAML = `
version: 1
server:
  logLevel: silent
storage:
  type: memory
security:
  providers:
    - type: jwt
      secret: test-shared-secret
providers:
  main:
    type: openai
    apiKey: sk-test
routing:
  defaultProvider: main
`;

describe("startServer", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it("binds an ephemeral port, serves the app and closes cleanly", async () => {
    running = await startServer({
      configYaml: CONFIG_YAML,
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

  it("rejects an unknown storage type, listing redis and postgres as registered", async () => {
    const yaml = `
version: 1
server:
  logLevel: silent
storage:
  type: no-such-storage
providers:
  main:
    type: openai
    apiKey: sk-test
routing:
  defaultProvider: main
`;
    const error: unknown = await startServer({
      configYaml: yaml,
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

  it("rejects invalid YAML with ConfigError before binding a port", async () => {
    const error: unknown = await startServer({
      configYaml: "version: [unclosed",
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
