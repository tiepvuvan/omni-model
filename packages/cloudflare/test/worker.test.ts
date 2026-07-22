import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatProvider,
  ProviderFactory,
  Usage,
} from "@omni-model/core";
import { createDefaultRegistry, silentLogger, sseStreamFromChunks } from "@omni-model/core";
import { describe, expect, it, vi } from "vitest";
import type {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  DurableObjectStubLike,
  KVNamespaceLike,
} from "../src/cf-types.js";
import { DurableObjectStorageAdapter, OmniStorageDurableObject } from "../src/durable-object.js";
import { createWorker, type WorkerEnv } from "../src/worker.js";

const OPENAI_API_KEY_REFERENCE = "$" + "{OPENAI_API_KEY}";

const MEMORY_CONFIG = {
  version: 1,
  security: { providers: [{ type: "test-authenticated" }] },
  storage: { type: "memory" },
  providers: { openai: { type: "openai", apiKey: OPENAI_API_KEY_REFERENCE } },
  routing: { defaultProvider: "openai" },
};

// 1h windows keep both chat calls inside one fixed window without an
// injectable clock (createWorker uses the platform clock).
const DO_CONFIG = {
  version: 1,
  security: { providers: [{ type: "test-authenticated" }] },
  storage: { type: "durable-object", binding: "OMNI_DO" },
  rateLimits: [
    { name: "burst", key: "user", requests: { limit: 1, window: "1h" } },
    { name: "budget", key: "user", tokens: { limit: 1000, window: "1h" } },
  ],
  providers: { fake: { type: "fake" } },
  routing: { defaultProvider: "fake" },
};

/**
 * A verifier is mandatory, so every fixture declares one. These tests exercise
 * worker plumbing (config resolution, DO/KV storage, streaming) rather than
 * auth, so this stands in for "the caller is authenticated".
 */
const alwaysAuthenticated = {
  type: "test-authenticated",
  create() {
    return {
      type: "test-authenticated",
      name: "test-authenticated",
      async verify() {
        return {
          ok: true as const,
          identity: { provider: "test-authenticated", userId: "test-user", claims: {} },
        };
      },
    };
  },
};

const FAKE_USAGE_TOTAL = 7;

function configEnv(config: Record<string, unknown>): WorkerEnv {
  return { OMNI_CONFIG_JSON: JSON.stringify(config) };
}

// durable-object storage + a token budget: lets the streaming test read back
// the counter the post-response usage recording wrote.
const STREAM_DO_CONFIG = {
  version: 1,
  security: { providers: [{ type: "test-authenticated" }] },
  storage: { type: "durable-object", binding: "OMNI_DO" },
  rateLimits: [{ name: "budget", key: "user", tokens: { limit: 1000, window: "1h" } }],
  providers: { "fake-stream": { type: "fake-stream" } },
  routing: { defaultProvider: "fake-stream" },
};

function fakeCompletion(model: string): ChatCompletion {
  return {
    id: "chatcmpl-worker-test",
    object: "chat.completion",
    created: 1_750_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: FAKE_USAGE_TOTAL },
  };
}

function createFakeProviderFactory(): ProviderFactory {
  return {
    type: "fake",
    create: (id): ChatProvider => ({
      id,
      type: "fake",
      async chat(request) {
        return { kind: "completion", completion: fakeCompletion(request.model) };
      },
    }),
  };
}

function streamChunk(
  model: string,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finish: string | null = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-worker-stream",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** Provider that returns an SSE stream plus an already-resolved usage promise. */
function createFakeStreamingProviderFactory(): ProviderFactory {
  return {
    type: "fake-stream",
    create: (id): ChatProvider => ({
      id,
      type: "fake-stream",
      async chat(request) {
        async function* chunks(): AsyncGenerator<ChatCompletionChunk> {
          yield streamChunk(request.model, { role: "assistant", content: "" });
          yield streamChunk(request.model, { content: "Hel" });
          yield streamChunk(request.model, { content: "lo" });
          yield streamChunk(request.model, {}, "stop");
        }
        const usage: Usage = {
          prompt_tokens: 3,
          completion_tokens: 4,
          total_tokens: FAKE_USAGE_TOTAL,
        };
        return {
          kind: "stream",
          sse: sseStreamFromChunks(chunks()),
          usage: Promise.resolve(usage),
        };
      },
    }),
  };
}

function fakeState(): DurableObjectStateLike {
  const entries = new Map<string, unknown>();
  return {
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return entries.get(key) as T | undefined;
      },
      async put(key: string, value: unknown): Promise<void> {
        entries.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return entries.delete(key);
      },
    },
  };
}

/** Namespace double routing each object name to a real OmniStorageDurableObject. */
class FakeNamespace implements DurableObjectNamespaceLike {
  readonly names: string[] = [];
  private readonly objects = new Map<string, OmniStorageDurableObject>();

  idFromName(name: string): unknown {
    this.names.push(name);
    return { name };
  }

  get(id: unknown): DurableObjectStubLike {
    const { name } = id as { name: string };
    let object = this.objects.get(name);
    if (object === undefined) {
      object = new OmniStorageDurableObject(fakeState());
      this.objects.set(name, object);
    }
    const target = object;
    return { fetch: (input, init) => target.fetch(new Request(input, init)) };
  }
}

function fakeKVNamespace(): KVNamespaceLike {
  const entries = new Map<string, string>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

/** waitUntil collector standing in for the Workers ExecutionContext. */
function createCtx() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>): void => {
        promises.push(promise);
      },
    },
    flush: async (): Promise<void> => {
      await Promise.allSettled(promises);
    },
  };
}

function healthzRequest(): Request {
  return new Request("https://omni.test/healthz");
}

function chatRequest(stream = false): Request {
  return new Request("https://omni.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "any", messages: [{ role: "user", content: "hi" }], stream }),
  });
}

async function errorBody(response: Response): Promise<{ message: string; type: string }> {
  const payload = (await response.json()) as { error: { message: string; type: string } };
  return payload.error;
}

describe("createWorker", () => {
  it("boots from OMNI_CONFIG_JSON and serves /healthz", async () => {
    const registry = createDefaultRegistry();
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ logger: silentLogger, registry });
    const env: WorkerEnv = {
      ...configEnv(MEMORY_CONFIG),
      OPENAI_API_KEY: "sk-test",
      // Non-string bindings must be filtered out of the interpolation env.
      SOME_BINDING: { get: () => null },
    };
    const response = await worker.fetch(healthzRequest(), env, createCtx().ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("boots entirely from OMNI__ environment variables", async () => {
    const registry = createDefaultRegistry();
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ logger: silentLogger, registry });
    const env: WorkerEnv = {
      OPENAI_API_KEY: "sk-test",
      OMNI__STORAGE__TYPE: "memory",
      OMNI__SECURITY__PROVIDERS__0__TYPE: "test-authenticated",
      OMNI__PROVIDERS__OPENAI__TYPE: "openai",
      OMNI__PROVIDERS__OPENAI__API_KEY: OPENAI_API_KEY_REFERENCE,
      OMNI__ROUTING__DEFAULT_PROVIDER: "openai",
    };
    const response = await worker.fetch(healthzRequest(), env, createCtx().ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("serves /healthz with durable-object storage bound from env", async () => {
    const registry = createDefaultRegistry();
    registry.providers.set("fake", createFakeProviderFactory());
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ registry, logger: silentLogger });
    const env: WorkerEnv = { ...configEnv(DO_CONFIG), OMNI_DO: new FakeNamespace() };
    const response = await worker.fetch(healthzRequest(), env, createCtx().ctx);
    expect(response.status).toBe(200);
  });

  it("flows rate-limit counters through the Durable Object namespace", async () => {
    const namespace = new FakeNamespace();
    const registry = createDefaultRegistry();
    registry.providers.set("fake", createFakeProviderFactory());
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ registry, logger: silentLogger });
    const env: WorkerEnv = { ...configEnv(DO_CONFIG), OMNI_DO: namespace };
    const { ctx, flush } = createCtx();

    const first = await worker.fetch(chatRequest(), env, ctx);
    expect(first.status).toBe(200);
    // Usage recording runs post-response through ctx.waitUntil.
    await flush();

    // The request-window counter was incremented inside the DO fake...
    expect(namespace.names.some((name) => name.startsWith("rl:req:burst:"))).toBe(true);
    // ...and the recorded token usage landed in the DO-backed budget counter.
    const tokenKey = namespace.names.find((name) => name.startsWith("rl:tok:budget:"));
    expect(tokenKey).toBeDefined();
    if (tokenKey === undefined) throw new Error("unreachable");
    const reader = new DurableObjectStorageAdapter(namespace);
    expect(await reader.getCounter(tokenKey)).toBe(FAKE_USAGE_TOTAL);

    // Second request in the same window trips the 1-request limit, proving
    // the count persisted across requests via the shared namespace.
    const second = await worker.fetch(chatRequest(), env, ctx);
    expect(second.status).toBe(429);
    expect(second.headers.get("x-ratelimit-rule")).toBe("burst");
  });

  it("streams SSE through the worker and records usage via executionCtx.waitUntil", async () => {
    const namespace = new FakeNamespace();
    const registry = createDefaultRegistry();
    registry.providers.set("fake-stream", createFakeStreamingProviderFactory());
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ registry, logger: silentLogger });
    const env: WorkerEnv = { ...configEnv(STREAM_DO_CONFIG), OMNI_DO: namespace };
    const { ctx, flush } = createCtx();

    const response = await worker.fetch(chatRequest(true), env, ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    // The body is a live ReadableStream, not a buffered string.
    expect(response.body).toBeInstanceOf(ReadableStream);

    const text = await response.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // Post-response token accounting is scheduled on the execution context and
    // runs after the stream is consumed; it must land in the DO-backed budget.
    await flush();
    const tokenKey = namespace.names.find((name) => name.startsWith("rl:tok:budget:"));
    expect(tokenKey).toBeDefined();
    if (tokenKey === undefined) throw new Error("unreachable");
    const reader = new DurableObjectStorageAdapter(namespace);
    expect(await reader.getCounter(tokenKey)).toBe(FAKE_USAGE_TOTAL);
  });

  it("serves requests with cloudflare-kv storage under a custom binding name", async () => {
    const config = {
      security: { providers: [{ type: "test-authenticated" }] },
      storage: { type: "cloudflare-kv", binding: "MY_KV" },
      providers: { openai: { type: "openai", apiKey: "sk-test" } },
      routing: { defaultProvider: "openai" },
    };
    const registry = createDefaultRegistry();
    registry.auth.set("test-authenticated", alwaysAuthenticated);
    const worker = createWorker({ logger: silentLogger, registry });
    const env: WorkerEnv = { ...configEnv(config), MY_KV: fakeKVNamespace() };
    const response = await worker.fetch(healthzRequest(), env, createCtx().ctx);
    expect(response.status).toBe(200);
  });

  it("returns a 500 ConfigError naming the missing Durable Object binding", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const worker = createWorker({ logger: silentLogger });
      const response = await worker.fetch(
        healthzRequest(),
        configEnv({
          security: { providers: [{ type: "test-authenticated" }] },
          storage: { type: "durable-object" },
          providers: { openai: { type: "openai", apiKey: "sk-test" } },
          routing: { defaultProvider: "openai" },
        }),
        createCtx().ctx,
      );
      expect(response.status).toBe(500);
      const error = await errorBody(response);
      expect(error.type).toBe("api_error");
      expect(error.message).toContain('"OMNI_DO"');
      expect(error.message).toContain("wrangler.jsonc");
      expect(errorSpy).toHaveBeenCalled();

      // The failure is memoized: a later request with a valid binding still
      // reports the cached init error (config mistakes need a redeploy).
      const retry = await worker.fetch(
        healthzRequest(),
        { OMNI_DO: new FakeNamespace() },
        createCtx().ctx,
      );
      expect(retry.status).toBe(500);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a 500 ConfigError naming the missing KV binding", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const worker = createWorker({ logger: silentLogger });
      // Present but wrong-shaped: without get/put functions the binding does
      // not look like a KV namespace and must be rejected.
      const env: WorkerEnv = {
        ...configEnv({
          security: { providers: [{ type: "test-authenticated" }] },
          storage: { type: "cloudflare-kv" },
          providers: { openai: { type: "openai", apiKey: "sk-test" } },
          routing: { defaultProvider: "openai" },
        }),
        OMNI_KV: { idFromName: () => null },
      };
      const response = await worker.fetch(healthzRequest(), env, createCtx().ctx);
      expect(response.status).toBe(500);
      const error = await errorBody(response);
      expect(error.type).toBe("api_error");
      expect(error.message).toContain('"OMNI_KV"');
      expect(error.message).toContain("wrangler.jsonc");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns a helpful 500 when no configuration exists anywhere", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const worker = createWorker();
      const response = await worker.fetch(healthzRequest(), {}, createCtx().ctx);
      expect(response.status).toBe(500);
      const error = await errorBody(response);
      expect(error.type).toBe("api_error");
      expect(error.message).toContain("OMNI_CONFIG_JSON");
      expect(error.message).toContain("OMNI_STORAGE_TYPE");
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
