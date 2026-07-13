import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

describe("rate limiting flow", () => {
  it("rejects the third request in a 2/1m window with a full 429", async () => {
    const yaml = `
version: 1
rateLimits:
  - name: burst
    key: user
    requests: { limit: 2, window: 1m }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({ yaml, storage });

    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);

    const third = await app.fetch(chatRequest(CHAT_BODY));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(third.headers.get("x-ratelimit-limit")).toBe("2");
    expect(third.headers.get("x-ratelimit-rule")).toBe("burst");

    const body = (await third.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain('"burst"');
  });

  it("rejects with a token-budget 429 once the budget is exhausted", async () => {
    const yaml = `
version: 1
rateLimits:
  - name: tiny-budget
    key: user
    tokens: { limit: 10, window: 1h }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({ yaml, storage });

    // First request passes (budget untouched) and records 15 tokens of usage.
    const first = await app.fetch(chatRequest(CHAT_BODY));
    expect(first.status).toBe(200);
    await collector.flush();

    const second = await app.fetch(chatRequest(CHAT_BODY));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(second.headers.get("x-ratelimit-rule")).toBe("tiny-budget");
    const body = (await second.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("Token budget exceeded");
  });

  it("scopes user-keyed limits to the authenticated user", async () => {
    const yaml = `
version: 1
security:
  providers:
    - type: fake-auth
rateLimits:
  - name: per-user
    key: user
    requests: { limit: 1, window: 1m }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({ yaml, storage });

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }))).status).toBe(200);
    // Alice is over her limit; Bob is unaffected.
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }))).status).toBe(429);
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "bob" }))).status).toBe(200);
  });

  it("applies conditional rules only when their `when` matches", async () => {
    const yaml = `
version: 1
security:
  providers:
    - type: fake-auth
rateLimits:
  - name: free-tier
    when: 'user.claims.tier == "free"'
    key: user
    requests: { limit: 1, window: 1m }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app } = await createTestApp({ yaml, storage });

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "free" }))).status).toBe(200);
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "free" }))).status).toBe(429);
    // "pro" users never match the rule, so they are not limited by it.
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "pro" }))).status).toBe(200);
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "pro" }))).status).toBe(200);
  });
});
