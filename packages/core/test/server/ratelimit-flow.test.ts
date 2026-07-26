import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

/**
 * Rate limiting through the whole pipeline.
 *
 * The fake provider reports 15 tokens per response, so a 10-token budget is spent
 * by one request — which is the shape every test here uses. `collector.flush()`
 * stands in for the post-response `waitUntil` that records usage: without it the
 * spend has not landed yet, exactly as in production.
 */
describe("rate limiting flow", () => {
  const budget = (limit: number, extra = ""): string => `
version: 1
${extra}rateLimits:
  - name: tiny-budget
    tokens: { limit: ${limit}, window: 1h }
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

  it("rejects with a full 429 once the budget is spent", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({ yaml: budget(10), storage });

    // The first request is admitted on an untouched budget and then spends 15.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
    await collector.flush();

    const rejected = await app.fetch(chatRequest(CHAT_BODY));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(rejected.headers.get("x-ratelimit-limit")).toBe("10");
    expect(rejected.headers.get("x-ratelimit-rule")).toBe("tiny-budget");

    const body = (await rejected.json()) as {
      error: { message: string; type: string; code: string };
    };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("Token budget exceeded");
    expect(body.error.message).toContain('"tiny-budget"');
  });

  it("charges nothing for a request it rejects", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({ yaml: budget(10), storage });
    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();

    // A 429 reaches no upstream, so there is nothing to charge — and hammering an
    // exhausted budget must not push its reset further away.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(429);
    }
    await collector.flush();

    const windowStart = Math.floor(FIXED_NOW / 3_600_000) * 3_600_000;
    expect(await storage.getCounter(`rl:tok:tiny-budget:test-user:${windowStart}`)).toBe(15);
  });

  it("gives each authenticated user their own budget", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({
      yaml: budget(10, "security:\n  userAuth:\n    type: fake-auth\n"),
      storage,
    });

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }))).status).toBe(200);
    await collector.flush();

    // Alice has spent hers; Bob is untouched.
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "alice" }))).status).toBe(429);
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "bob" }))).status).toBe(200);
  });

  it("applies conditional rules only when their `when` matches", async () => {
    const yaml = `
version: 1
security:
  userAuth:
    type: fake-auth
rateLimits:
  - name: free-tier
    when: 'user.claims.tier == "free"'
    tokens: { limit: 10, window: 1h }
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({ yaml, storage });

    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "free" }))).status).toBe(200);
    await collector.flush();
    expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "free" }))).status).toBe(429);

    // A "pro" user never matches the rule, so it never limits them.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "pro" }))).status).toBe(200);
      await collector.flush();
    }
  });
});
