import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestProxy, FIXED_NOW } from "../server/helpers.js";

/**
 * Reconfiguring a *running* app.
 *
 * These are the tests that justify the bundle indirection: each one covers a
 * place where configuration used to be captured at startup and would therefore
 * have silently ignored a reload.
 */

const BASE = `
version: 1
storage: { type: memory }
routing:
  rules:
    - { id: main, when: "true", target: { type: fake } }
`;

describe("reloading configuration", () => {
  it("serves 503 until configured, then serves, then refuses again", async () => {
    const proxy = await createTestProxy();

    expect(proxy.holder.current()).toBeNull();
    const before = await proxy.app.fetch(chatRequest(CHAT_BODY));
    expect(before.status).toBe(503);
    expect((await before.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_configured" },
    });

    expect((await proxy.reload(BASE)).ok).toBe(true);
    expect((await proxy.app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);

    // A rejected reload must leave the working bundle in place, not blank it.
    const rejected = await proxy.reloadRaw({ version: 1, providers: { x: { type: "nope" } } });
    expect(rejected.ok).toBe(false);
    expect((await proxy.app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("keeps the previous bundle and reports why when a reload is rejected", async () => {
    const proxy = await createTestProxy({ yaml: BASE });
    const before = proxy.holder.current();

    const result = await proxy.reloadRaw({ version: 1, security: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/security\.userAuth is not set/);
    // Same object identity: nothing was rebuilt.
    expect(proxy.holder.current()).toBe(before);
    expect(proxy.holder.status()).toMatchObject({ configured: true, revision: 1 });
    expect(proxy.holder.status().lastError).toMatch(/security\.userAuth is not set/);
  });

  it("mounts and unmounts verifier-contributed routes", async () => {
    // Hono cannot unregister a route, so these are dispatched from the bundle.
    // Without that, removing a verifier would leave its endpoint live forever.
    const withRoute = `${BASE}security:
  userAuth:
    type: fake-auth
    challengeRoute: true
`;
    const proxy = await createTestProxy({ yaml: withRoute, injectVerifier: false });

    const open = await proxy.app.fetch(new Request("http://local/auth/fake/challenge"));
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ challenge: "abc" });

    await proxy.reload(`${BASE}security:
  userAuth:
    type: fake-auth
`);

    const closed = await proxy.app.fetch(new Request("http://local/auth/fake/challenge"));
    expect(closed.status).toBe(404);
  });

  it("applies allowedModels to both /v1/models and the routing gate", async () => {
    // Enforced in two places; a reload that updated only one would advertise a
    // model that 404s, or hide one that works.
    const proxy = await createTestProxy({
      yaml: `${BASE}`,
      behaviors: {
        main: { models: [{ id: "smart", object: "model", created: 0, owned_by: "x" }] },
      },
    });

    await proxy.reload(`${BASE}  allowedModels: [only-this]
`);

    const list = await proxy.app.fetch(new Request("http://local/v1/models"));
    expect(((await list.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual([
      "only-this",
    ]);
    const blocked = await proxy.app.fetch(chatRequest({ ...CHAT_BODY, model: "smart" }));
    expect(blocked.status).toBe(404);

    // ...and removing the allowlist re-opens both.
    await proxy.reload(BASE);
    const reopened = await proxy.app.fetch(chatRequest({ ...CHAT_BODY, model: "smart" }));
    expect(reopened.status).toBe(200);
  });

  it("applies a changed maxBodyBytes", async () => {
    const proxy = await createTestProxy({ yaml: BASE });
    const body = { ...CHAT_BODY, messages: [{ role: "user", content: "x".repeat(2000) }] };
    expect((await proxy.app.fetch(chatRequest(body))).status).toBe(200);

    await proxy.reload(`${BASE}server:
  maxBodyBytes: 100
`);

    expect((await proxy.app.fetch(chatRequest(body))).status).toBe(413);
  });

  it("adds and removes CORS", async () => {
    const proxy = await createTestProxy({ yaml: BASE });
    const origin = { origin: "https://app.example" };

    const without = await proxy.app.fetch(chatRequest(CHAT_BODY, origin));
    expect(without.headers.get("access-control-allow-origin")).toBeNull();

    await proxy.reload(`${BASE}server:
  cors:
    allowOrigins: ["https://app.example"]
`);
    const with_ = await proxy.app.fetch(chatRequest(CHAT_BODY, origin));
    expect(with_.headers.get("access-control-allow-origin")).toBe("https://app.example");

    await proxy.reload(BASE);
    const removed = await proxy.app.fetch(chatRequest(CHAT_BODY, origin));
    expect(removed.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("swaps verifiers, so a credential that worked stops working", async () => {
    const proxy = await createTestProxy({
      yaml: `${BASE}security:
  userAuth:
    type: fake-auth
    header: x-old
`,
      injectVerifier: false,
    });
    expect((await proxy.app.fetch(chatRequest(CHAT_BODY, { "x-old": "u1" }))).status).toBe(200);

    await proxy.reload(`${BASE}security:
  userAuth:
    type: fake-auth
    header: x-new
`);

    expect((await proxy.app.fetch(chatRequest(CHAT_BODY, { "x-old": "u1" }))).status).toBe(401);
    expect((await proxy.app.fetch(chatRequest(CHAT_BODY, { "x-new": "u1" }))).status).toBe(200);
  });

  it("preserves counters when a rule is renamed but keeps its id", async () => {
    // Counter keys are namespaced by `id`. If they used the display name, a
    // rename from a dashboard would silently hand everyone a fresh quota.
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const rule = (name: string): string => `${BASE}rateLimits:
  - id: per-user
    name: ${name}
    tokens: { limit: 10, window: 1h }
`;
    const proxy = await createTestProxy({ yaml: rule("original"), storage });

    expect((await proxy.app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
    await proxy.collector.flush();

    await proxy.reload(rule("renamed-by-an-admin"));

    // The spend survived the rename; only the reported name changed.
    const rejected = await proxy.app.fetch(chatRequest(CHAT_BODY));
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("x-ratelimit-rule")).toBe("renamed-by-an-admin");
  });

  it("gives a rule a fresh keyspace when its id changes", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const rule = (id: string): string => `${BASE}rateLimits:
  - id: ${id}
    name: per-user
    tokens: { limit: 10, window: 1h }
`;
    const proxy = await createTestProxy({ yaml: rule("v1"), storage });
    await proxy.app.fetch(chatRequest(CHAT_BODY));
    await proxy.collector.flush();

    await proxy.reload(rule("v2"));

    // A deliberate id change is the documented way to reset a limit.
    expect((await proxy.app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });

  it("lets an in-flight stream finish on the bundle it started with", async () => {
    // The strongest property: a response already streaming must not notice that
    // its provider, router and limiter were replaced underneath it.
    const proxy = await createTestProxy({
      yaml: BASE,
      behaviors: {
        main: {
          streamChunks: [
            { id: "1", object: "chat.completion.chunk", created: 0, model: "m", choices: [] },
          ],
        },
      },
    });

    const response = await proxy.app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(response.status).toBe(200);

    // Reconfigure to something that would reject this very request.
    await proxy.reload(`${BASE}  allowedModels: [something-else]
`);

    const text = await response.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  it("serves every request while being reconfigured under concurrent load", async () => {
    /*
     * Both limits off, to isolate the property under test.
     *
     * A default token budget would answer 429 and hide whether a reload dropped
     * anything, and the default in-flight bound of 3 would refuse 57 of these 60 —
     * which is the bound working, not a reload failing.
     */
    const unlimited = `${BASE}rateLimits: []
concurrency: { perUser: 0 }
`;
    const proxy = await createTestProxy({ yaml: unlimited });

    const inFlight: Promise<Response>[] = [];
    for (let i = 0; i < 60; i += 1) {
      inFlight.push(proxy.app.fetch(chatRequest(CHAT_BODY)));
      if (i % 10 === 0) {
        // Alternate between two valid configurations mid-flight.
        void proxy.reload(
          i % 20 === 0 ? `${unlimited}server:\n  maxBodyBytes: 65536\n` : unlimited,
        );
      }
    }
    const statuses = await Promise.all(inFlight.map(async (p) => (await p).status));

    expect(statuses).toHaveLength(60);
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it("keeps rate-limit counters exact across reloads under load", async () => {
    // Reloading rebuilds the limiter. If a rebuild reset or double-counted its
    // counters, the recorded total would not land exactly on what was spent.
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    // The in-flight bound is off for the same reason as the test above: 60 at once
    // is the point, and three of them is not a measurement of anything.
    const limited = `${BASE}concurrency: { perUser: 0 }
rateLimits:
  - id: per-user
    name: per-user
    tokens: { limit: 100000, window: 1h }
`;
    const proxy = await createTestProxy({ yaml: limited, storage });

    const inFlight: Promise<Response>[] = [];
    for (let i = 0; i < 60; i += 1) {
      inFlight.push(proxy.app.fetch(chatRequest(CHAT_BODY)));
      if (i % 10 === 0) void proxy.reload(limited);
    }
    const statuses = await Promise.all(inFlight.map(async (p) => (await p).status));
    await proxy.collector.flush();

    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    // 60 responses at 15 tokens each, whatever the limiter was rebuilt on top of.
    const windowStart = Math.floor(FIXED_NOW / 3_600_000) * 3_600_000;
    expect(await storage.getCounter(`rl:tok:per-user:test-user:${windowStart}`)).toBe(900);
  });
});

describe("logger reconfiguration", () => {
  it("rebuilds the logger so server.logLevel takes effect", async () => {
    // createConsoleLogger captures its threshold, so the logger has to be
    // rebuilt per bundle rather than reused.
    const proxy = await createTestProxy({ yaml: BASE, logger: undefined });
    const first = proxy.holder.current();

    await proxy.reload(`${BASE}server:
  logLevel: error
`);

    expect(proxy.holder.current()).not.toBe(first);
    expect(proxy.holder.current()?.config.server.logLevel).toBe("error");
  });
});
