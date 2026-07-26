import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

/*
 * Budgets are per user, and the IP is the last fallback when a request carries an
 * authenticated caller with no subject. That fallback is the one an attacker can
 * try to split by choosing a header value, so it gets the spoofing tests.
 */
const IP_LIMIT_YAML = `
version: 1
server:
  trustProxyHeaders: __TRUST__
security:
  userAuth:
    type: test-anonymous
rateLimits:
  - name: per-caller
    tokens: { limit: 10, window: 1m }
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

describe("rate-limit key derivation and header spoofing", () => {
  const setup = (trust: "true" | "false") =>
    createTestApp({
      yaml: IP_LIMIT_YAML.replace("__TRUST__", trust),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      injectVerifier: false,
    });

  it("does not let a spoofed x-forwarded-for split the bucket when proxy headers are untrusted", async () => {
    // trustProxyHeaders defaults to false: the two requests carry different
    // (attacker-chosen) x-forwarded-for values but must share one bucket.
    const { app, collector } = await setup("false");

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }))).status).toBe(
      200,
    );
    await collector.flush();

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "2.2.2.2" }))).status).toBe(
      429,
    );
  });

  it("honors x-forwarded-for as the key only when proxy headers are trusted", async () => {
    const { app, collector } = await setup("true");

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }))).status).toBe(
      200,
    );
    await collector.flush();

    // Distinct trusted IP -> distinct bucket -> not limited.
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "2.2.2.2" }))).status).toBe(
      200,
    );
    // Same IP as the first request -> shares its now-spent bucket.
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-forwarded-for": "1.1.1.1" }))).status).toBe(
      429,
    );
  });
});

describe("request body size limit", () => {
  const yaml = `
version: 1
server:
  maxBodyBytes: 200
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
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
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
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
