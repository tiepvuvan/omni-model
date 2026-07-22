import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

const IP_LIMIT_YAML = `
version: 1
server:
  trustProxyHeaders: __TRUST__
rateLimits:
  - name: per-ip
    key: ip
    requests: { limit: 1, window: 1m }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;

describe("IP-based rate limiting and header spoofing", () => {
  it("does not let a spoofed x-forwarded-for evade an ip limit when proxy headers are untrusted", async () => {
    // trustProxyHeaders defaults to false: the two requests carry different
    // (attacker-chosen) x-forwarded-for values but must share one bucket.
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({
      yaml: IP_LIMIT_YAML.replace("__TRUST__", "false"),
      storage,
    });

    const first = await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }));
    expect(first.status).toBe(200);
    const second = await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "2.2.2.2" }));
    expect(second.status).toBe(429);
  });

  it("honors x-forwarded-for as the ip key only when proxy headers are trusted", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({
      yaml: IP_LIMIT_YAML.replace("__TRUST__", "true"),
      storage,
    });

    const first = await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }));
    expect(first.status).toBe(200);
    // Distinct trusted IP -> distinct bucket -> not rate limited.
    const second = await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "2.2.2.2" }));
    expect(second.status).toBe(200);
    // Same IP as the first request -> shares its (now-exhausted) bucket.
    const third = await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }));
    expect(third.status).toBe(429);
  });
});

describe("request body size limit", () => {
  const yaml = `
version: 1
server:
  maxBodyBytes: 200
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;

  it("rejects a body larger than server.maxBodyBytes with a 413", async () => {
    const { app } = await createTestApp({ yaml });
    const bigBody = { ...CHAT_BODY, messages: [{ role: "user", content: "x".repeat(500) }] };
    const response = await app.fetch(chatRequest(bigBody));
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("accepts a body under the limit", async () => {
    const { app } = await createTestApp({ yaml });
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("defaults to a 128 KiB limit when server.maxBodyBytes is omitted", async () => {
    const defaultYaml = `
version: 1
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml: defaultYaml });
    const body = { ...CHAT_BODY, messages: [{ role: "user", content: "x".repeat(128 * 1024) }] };
    expect((await app.fetch(chatRequest(body))).status).toBe(413);
  });

  it("rejects when content-length lies but the actual body is oversized", async () => {
    const { app } = await createTestApp({ yaml });
    const bigBody = JSON.stringify({
      ...CHAT_BODY,
      messages: [{ role: "user", content: "x".repeat(500) }],
    });
    const request = new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: bigBody,
    });
    expect((await app.fetch(request)).status).toBe(413);
  });
});
