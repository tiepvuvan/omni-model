import { describe, expect, it } from "vitest";
import { promptCacheKey } from "../../src/cache/key.js";
import { MemoryPromptCache } from "../../src/cache/memory.js";
import { createMemoryRequestLogSink } from "../../src/logs/buffer.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { CHAT_BODY, chatRequest, createTestApp, FIXED_NOW } from "./helpers.js";

/**
 * The response cache, end to end.
 *
 * The property that matters is that a hit is indistinguishable from a fresh call
 * *except* for what it did not do: no upstream request, no tokens charged. Anything
 * else — a stale id, a missing usage record, a half-replayed stream — is a cache
 * that cannot be trusted, and an untrustworthy cache is worse than none.
 */
describe("prompt caching", () => {
  const fixture = (extra = ""): string => `
version: 1
cache: { enabled: true, ttl: 1h }
rateLimits: []
${extra}routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;

  const setup = async (options: { yaml?: string; behaviors?: never } = {}) => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const app = await createTestApp({
      yaml: options.yaml ?? fixture(),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache },
    });
    return { ...app, cache };
  };

  it("calls the upstream once for two identical requests", async () => {
    const { app, providers, collector, cache } = await setup();

    const first = await app.fetch(chatRequest(CHAT_BODY));
    expect(first.status).toBe(200);
    expect(first.headers.get("x-omni-cache")).toBe("miss");
    // Storing happens off the response path, so the entry lands with the rest of
    // the post-response work.
    await collector.flush();
    expect((await cache.stats()).entries).toBe(1);

    const second = await app.fetch(chatRequest(CHAT_BODY));

    expect(second.status).toBe(200);
    expect(second.headers.get("x-omni-cache")).toBe("hit");
    expect(providers.get("fake")?.chatCalls).toHaveLength(1);

    const live = (await first.json()) as { id: string; choices: unknown };
    const replay = (await second.json()) as { id: string; choices: unknown };
    // The same answer...
    expect(replay.choices).toEqual(live.choices);
    // ...with this request's own identifiers, not the first request's. What is
    // stored is the upstream's answer, so a replay is redacted afresh rather than
    // handing a second caller someone else's completion id.
    expect(replay.id).not.toBe(live.id);
  });

  it("does not charge a cache hit against a token budget", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({
      yaml: `
version: 1
cache: { enabled: true, ttl: 1h }
rateLimits:
  - name: budget
    tokens: { limit: 20, window: 1h }
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`,
      storage,
      initOverrides: { promptCache: cache },
    });

    // The first call spends 15 of 20.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
    await collector.flush();

    // The second is a hit: no upstream, nothing spent, so the budget is untouched
    // and a third still fits. Charging for work nobody did would make the cache
    // invisible to the thing it exists to protect.
    expect((await app.fetch(chatRequest(CHAT_BODY))).headers.get("x-omni-cache")).toBe("hit");
    await collector.flush();
    const windowStart = Math.floor(FIXED_NOW / 3_600_000) * 3_600_000;
    expect(await storage.getCounter(`rl:tok:budget:test-user:${windowStart}`)).toBe(15);
  });

  it("marks a cache hit in the request log, so a zero-token row explains itself", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const sink = createMemoryRequestLogSink({ batchSize: 1 });
    const { app, collector } = await createTestApp({
      yaml: fixture(),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache, requestLogs: sink },
    });

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    await sink.flush();

    const rows = sink.writer.entries;
    expect(rows).toHaveLength(2);
    // Not cosmetic: without it a hit is a row with no tokens and no reason, which
    // reads as a request that failed to account for itself.
    expect(rows[0]?.cached).toBe(false);
    expect(rows[1]?.cached).toBe(true);
    expect(rows[1]?.status).toBe(200);
  });

  it("keeps a different prompt separate", async () => {
    const { app, providers, collector } = await setup();

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    const other = await app.fetch(
      chatRequest({ ...CHAT_BODY, messages: [{ role: "user", content: "something else" }] }),
    );

    expect(other.headers.get("x-omni-cache")).toBe("miss");
    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
  });

  it("treats a changed parameter as a different request", async () => {
    const { app, providers, collector } = await setup();

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    // `temperature` changes the answer, so it cannot be excluded from the key just
    // because the messages match.
    await app.fetch(chatRequest({ ...CHAT_BODY, temperature: 0.9 }));

    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
  });

  it("replays a streamed answer as a stream", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const { app, providers, collector } = await createTestApp({
      yaml: fixture(),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache },
      behaviors: {
        fake: {
          streamChunks: [
            {
              id: "up-1",
              object: "chat.completion.chunk",
              created: 1,
              model: "fake",
              choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
            },
          ],
          streamUsage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      },
    });

    const live = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    const liveText = await live.text();
    await collector.flush();

    const replayed = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    const replayedText = await replayed.text();

    expect(replayed.headers.get("x-omni-cache")).toBe("hit");
    expect(providers.get("fake")?.chatCalls).toHaveLength(1);
    expect(replayedText).toContain("hello");
    expect(replayedText).toContain("[DONE]");
    // What was stored is the *upstream's* bytes, so the replay runs the same
    // redaction a live answer does: the upstream's own chunk id never reaches a
    // client, and the replay carries fresh identifiers rather than the first
    // request's.
    expect(replayedText).not.toContain("up-1");
    expect(liveText).not.toContain("up-1");
    const idOf = (text: string) => /"id":"(chatcmpl-[^"]+)"/.exec(text)?.[1];
    expect(idOf(replayedText)).toBeDefined();
    expect(idOf(replayedText)).not.toBe(idOf(liveText));
  });

  it("keeps a streaming and a non-streaming request apart", async () => {
    const { app, providers, collector } = await setup();

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    // An answer is replayed in the shape it was captured in, so the two shapes are
    // two entries rather than one that has to be converted.
    const streamed = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));

    expect(streamed.headers.get("x-omni-cache")).toBe("miss");
    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
  });

  it("never caches an upstream error", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const { app, collector } = await createTestApp({
      yaml: fixture(),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache },
      behaviors: {
        fake: { error: { status: 502, body: { error: { message: "upstream down" } } } },
      },
    });

    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(502);
    await collector.flush();

    // An error is not an answer. Caching one would turn a blip into an outage that
    // lasts as long as the TTL.
    expect((await cache.stats()).entries).toBe(0);
  });

  it("does nothing once caching is switched off", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const { app, providers, collector } = await createTestApp({
      yaml: `
version: 1
cache: { enabled: false }
rateLimits: []
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`,
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache },
    });

    const first = await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    await app.fetch(chatRequest(CHAT_BODY));

    // Off means off, all the way: no header at all (rather than a permanent
    // `miss`), no entry written, and every request reaching the upstream.
    expect(first.headers.get("x-omni-cache")).toBeNull();
    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
    expect((await cache.stats()).entries).toBe(0);
  });

  it("caches without being configured at all", async () => {
    const cache = new MemoryPromptCache(() => FIXED_NOW);
    const { app, providers, collector } = await createTestApp({
      yaml: `
version: 1
rateLimits: []
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`,
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: cache },
    });

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    const second = await app.fetch(chatRequest(CHAT_BODY));

    // On by default: saving the operator's credits is why this proxy exists, and a
    // duplicate request is the cheapest saving available.
    expect(second.headers.get("x-omni-cache")).toBe("hit");
    expect(providers.get("fake")?.chatCalls).toHaveLength(1);
  });

  it("expires an entry after five minutes by default", async () => {
    let now = FIXED_NOW;
    const cache = new MemoryPromptCache(() => now);
    const { app, providers, collector } = await createTestApp({
      yaml: `
version: 1
rateLimits: []
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`,
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      now: () => now,
      initOverrides: { promptCache: cache },
    });

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();

    now += 4 * 60_000;
    expect((await app.fetch(chatRequest(CHAT_BODY))).headers.get("x-omni-cache")).toBe("hit");

    // Short on purpose: long enough to absorb a retry or a double-tap, short enough
    // that a change made upstream is not masked for the rest of the afternoon.
    now += 2 * 60_000;
    expect((await app.fetch(chatRequest(CHAT_BODY))).headers.get("x-omni-cache")).toBe("miss");
    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
  });

  it("serves nothing once the entry has expired", async () => {
    let now = FIXED_NOW;
    const cache = new MemoryPromptCache(() => now);
    const { app, providers, collector } = await createTestApp({
      yaml: `
version: 1
cache: { enabled: true, ttl: 1m }
rateLimits: []
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`,
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      now: () => now,
      initOverrides: { promptCache: cache },
    });

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    now += 61_000;

    expect((await app.fetch(chatRequest(CHAT_BODY))).headers.get("x-omni-cache")).toBe("miss");
    expect(providers.get("fake")?.chatCalls).toHaveLength(2);
  });

  it("survives a cache that throws on every call", async () => {
    const broken = {
      get: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
      purge: async () => 0,
      stats: async () => ({ entries: 0, oldestAt: null, bytes: null }),
      evict: async () => 0,
    };
    const { app, collector } = await createTestApp({
      yaml: fixture(),
      storage: new MemoryStorageAdapter(() => FIXED_NOW),
      initOverrides: { promptCache: broken },
    });

    // A cache that can fail a request would be worse than no cache, so a broken
    // backend reads as a permanent miss.
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
    await collector.flush();
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(200);
  });
});

describe("the cache key", () => {
  const base = {
    providerType: "openai",
    routeName: "default",
    model: "gpt-4o-mini",
    body: { model: "smart", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    endpoint: "chat" as const,
  };

  it("ignores key order in the body", async () => {
    const reordered = { messages: [{ content: "hi", role: "user" }], model: "smart" };
    expect(await promptCacheKey(base)).toBe(await promptCacheKey({ ...base, body: reordered }));
  });

  it("separates two rules that resolve the same client model differently", async () => {
    // Two routing rules can serve one client-facing name from different upstreams.
    // Sharing an entry between them would answer with the wrong model's output.
    expect(await promptCacheKey(base)).not.toBe(
      await promptCacheKey({ ...base, providerType: "anthropic" }),
    );
    expect(await promptCacheKey(base)).not.toBe(await promptCacheKey({ ...base, model: "gpt-4o" }));
    expect(await promptCacheKey(base)).not.toBe(
      await promptCacheKey({ ...base, routeName: "other" }),
    );
  });

  it("separates the two endpoints and the two response shapes", async () => {
    expect(await promptCacheKey(base)).not.toBe(await promptCacheKey({ ...base, stream: true }));
    expect(await promptCacheKey(base)).not.toBe(
      await promptCacheKey({ ...base, endpoint: "embeddings" }),
    );
  });
});
