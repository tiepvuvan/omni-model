import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import type { ChatCompletion, ChatCompletionRequest } from "../../src/openai/types.js";
import {
  openAICompatibleProviderFactory,
  openAIProviderFactory,
} from "../../src/providers/openai.js";
import type { RuntimeContext } from "../../src/types.js";

const FIXED_NOW = 1_700_000_000_000;
const encoder = new TextEncoder();

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | undefined;
}

interface TestHarness {
  ctx: RuntimeContext;
  calls: CapturedCall[];
}

function makeCtx(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): TestHarness {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : null,
      signal: init?.signal ?? undefined,
    });
    return handler(url, init);
  }) as typeof fetch;
  return {
    ctx: {
      env: {},
      fetch: fetchImpl,
      now: () => FIXED_NOW,
      waitUntil: () => {},
      log: silentLogger,
    },
    calls,
  };
}

const rejectingCtx = makeCtx(() => {
  throw new TypeError("fetch failed");
}).ctx;

function chatRequest(extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
}

const completionFixture: ChatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-4o-mini",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

function sseChunk(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** The upstream SSE fixture: role delta, two content deltas, finish, usage, DONE. */
const streamParts: string[] = [
  sseChunk({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  }),
  sseChunk({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }],
  }),
  sseChunk({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
  }),
  sseChunk({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }),
  sseChunk({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-4o-mini",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  }),
  "data: [DONE]\n\n",
];

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index];
      if (part === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(part));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeProvider(options: Record<string, unknown> = {}) {
  return openAIProviderFactory.create(
    "openai-main",
    { apiKey: "sk-test", ...options },
    rejectingCtx,
  );
}

describe("openai provider: chat (non-stream)", () => {
  it("forwards the body verbatim with auth headers and returns the completion", async () => {
    const { ctx, calls } = makeCtx(() => Response.json(completionFixture));
    const provider = makeProvider({ organization: "org-42", headers: { "x-extra": "1" } });
    const request = chatRequest({ temperature: 0.5, custom_field: "kept" });

    const result = await provider.chat(request, ctx);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call?.method).toBe("POST");
    expect(call?.headers.authorization).toBe("Bearer sk-test");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.headers["openai-organization"]).toBe("org-42");
    expect(call?.headers["x-extra"]).toBe("1");
    expect(JSON.parse(call?.body ?? "")).toEqual(request);

    expect(result.kind).toBe("completion");
    if (result.kind === "completion") {
      expect(result.completion).toEqual(completionFixture);
    }
  });

  it("passes the abort signal to fetch", async () => {
    const { ctx, calls } = makeCtx(() => Response.json(completionFixture));
    const controller = new AbortController();
    await makeProvider().chat(chatRequest(), ctx, { signal: controller.signal });
    expect(calls[0]?.signal).toBe(controller.signal);
  });

  it("maps upstream 429 to an error result with the extracted message", async () => {
    const { ctx } = makeCtx(() =>
      Response.json(
        { error: { message: "Rate limit reached", type: "rate_limit_error" } },
        { status: 429 },
      ),
    );
    const result = await makeProvider().chat(chatRequest(), ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(429);
      expect(result.body.error.message).toContain("Rate limit reached");
      expect(result.body.error.type).toBe("rate_limit_error");
    }
  });

  it("maps upstream 500 to a 502 error result", async () => {
    const { ctx } = makeCtx(() => new Response("internal error", { status: 500 }));
    const result = await makeProvider().chat(chatRequest(), ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(502);
      expect(result.body.error.type).toBe("api_error");
    }
  });

  it("wraps a fetch rejection into a 502 error result", async () => {
    const result = await makeProvider().chat(chatRequest(), rejectingCtx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(502);
      expect(result.body.error.message).toContain("fetch failed");
    }
  });
});

describe("openai provider: chat (stream)", () => {
  function streamResponse(body: ReadableStream<Uint8Array>): Response {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("passes bytes through unmodified and resolves usage from the final chunk", async () => {
    const { ctx } = makeCtx(() => streamResponse(streamOf(streamParts)));
    const result = await makeProvider().chat(chatRequest({ stream: true }), ctx);

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const bytes = await readAll(result.sse);
    expect(bytes).toEqual(encoder.encode(streamParts.join("")));
    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
  });

  it("resolves usage to null when the upstream never reports it", async () => {
    const parts = [streamParts[0] as string, "data: [DONE]\n\n"];
    const { ctx } = makeCtx(() => streamResponse(streamOf(parts)));
    const result = await makeProvider().chat(chatRequest({ stream: true }), ctx);
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await readAll(result.sse);
    await expect(result.usage).resolves.toBeNull();
  });

  it("on cancel resolves usage to null and cancels the upstream reader", async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(streamParts[0] as string));
      },
      pull() {
        // Never produce more data: the stream stays open until cancelled.
        return new Promise<void>(() => {});
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const { ctx } = makeCtx(() => streamResponse(upstream));
    const result = await makeProvider().chat(chatRequest({ stream: true }), ctx);

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    const reader = result.sse.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("client disconnected");

    await expect(result.usage).resolves.toBeNull();
    expect(upstreamCancelled).toBe(true);
  });

  it("resolves usage to null when the upstream errors mid-stream", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(streamParts[0] as string));
        controller.error(new Error("connection reset"));
      },
    });
    const { ctx } = makeCtx(() => streamResponse(upstream));
    const result = await makeProvider().chat(chatRequest({ stream: true }), ctx);
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await expect(readAll(result.sse)).rejects.toThrow("connection reset");
    await expect(result.usage).resolves.toBeNull();
  });

  it("injects stream_options.include_usage when the client sent none", async () => {
    const { ctx, calls } = makeCtx(() => streamResponse(streamOf(["data: [DONE]\n\n"])));
    await makeProvider().chat(chatRequest({ stream: true }), ctx);
    const body = JSON.parse(calls[0]?.body ?? "") as ChatCompletionRequest;
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("preserves existing stream_options keys when injecting include_usage", async () => {
    const { ctx, calls } = makeCtx(() => streamResponse(streamOf(["data: [DONE]\n\n"])));
    await makeProvider().chat(
      chatRequest({ stream: true, stream_options: { chunk_size: 2 } }),
      ctx,
    );
    const body = JSON.parse(calls[0]?.body ?? "") as ChatCompletionRequest;
    expect(body.stream_options).toEqual({ include_usage: true, chunk_size: 2 });
  });

  it("does not inject stream_options when includeStreamUsage is false", async () => {
    const { ctx, calls } = makeCtx(() => streamResponse(streamOf(["data: [DONE]\n\n"])));
    const provider = makeProvider({ includeStreamUsage: false });
    const request = chatRequest({ stream: true });
    await provider.chat(request, ctx);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(request);
  });

  it("does not inject stream_options into non-stream requests", async () => {
    const { ctx, calls } = makeCtx(() => Response.json(completionFixture));
    const request = chatRequest();
    await makeProvider().chat(request, ctx);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(request);
  });
});

describe("openai provider: listModels", () => {
  it("maps upstream data[] to ModelInfo", async () => {
    const { ctx, calls } = makeCtx(() =>
      Response.json({
        object: "list",
        data: [
          { id: "gpt-4o-mini", object: "model", created: 42, owned_by: "openai" },
          { id: "bare-model" },
        ],
      }),
    );
    const models = await makeProvider().listModels?.(ctx);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(models).toEqual([
      { id: "gpt-4o-mini", object: "model", created: 42, owned_by: "openai" },
      { id: "bare-model", object: "model", created: 0, owned_by: "openai-main" },
    ]);
  });

  it("falls back to static models on upstream 500", async () => {
    const { ctx } = makeCtx(() => new Response("boom", { status: 500 }));
    const provider = makeProvider({ models: ["local-a", "local-b"] });
    const models = await provider.listModels?.(ctx);
    expect(models).toEqual([
      { id: "local-a", object: "model", created: FIXED_NOW / 1000, owned_by: "openai-main" },
      { id: "local-b", object: "model", created: FIXED_NOW / 1000, owned_by: "openai-main" },
    ]);
  });

  it("returns an empty list on fetch rejection without static models", async () => {
    const models = await makeProvider().listModels?.(rejectingCtx);
    expect(models).toEqual([]);
  });
});

describe("openai provider: embeddings", () => {
  const embeddingsFixture = {
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 2, total_tokens: 2 },
  };

  it("forwards the request and returns the parsed response", async () => {
    const { ctx, calls } = makeCtx(() => Response.json(embeddingsFixture));
    const request = { model: "text-embedding-3-small", input: "hi" };
    const result = await makeProvider().embeddings?.(request, ctx);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual(request);
    expect(result).toEqual({ kind: "embeddings", response: embeddingsFixture });
  });

  it("maps upstream errors to an error result", async () => {
    const { ctx } = makeCtx(() =>
      Response.json(
        { error: { message: "bad input", type: "invalid_request_error" } },
        { status: 400 },
      ),
    );
    const result = await makeProvider().embeddings?.({ model: "m", input: "x" }, ctx);
    expect(result?.kind).toBe("error");
    if (result?.kind === "error") {
      expect(result.status).toBe(400);
      expect(result.body.error.message).toContain("bad input");
    }
  });
});

describe("openai provider: options validation", () => {
  it("rejects a missing apiKey for type openai", () => {
    expect(() => openAIProviderFactory.create("openai-main", {}, rejectingCtx)).toThrow(
      ConfigError,
    );
  });

  it("rejects unknown option keys", () => {
    expect(() =>
      openAIProviderFactory.create("openai-main", { apiKey: "sk", bogus: true }, rejectingCtx),
    ).toThrow(ConfigError);
  });

  it("accepts the raw config block including its type key", () => {
    const provider = openAIProviderFactory.create(
      "openai-main",
      { type: "openai", apiKey: "sk-test" },
      rejectingCtx,
    );
    expect(provider.type).toBe("openai");
    expect(provider.id).toBe("openai-main");
  });

  it("requires baseUrl for type openai-compatible", () => {
    expect(() =>
      openAICompatibleProviderFactory.create("local", { apiKey: "sk" }, rejectingCtx),
    ).toThrow(ConfigError);
  });

  it("allows openai-compatible without an apiKey and sends no auth header", async () => {
    const { ctx, calls } = makeCtx(() => Response.json(completionFixture));
    const provider = openAICompatibleProviderFactory.create(
      "local",
      { baseUrl: "http://localhost:11434/v1/" },
      rejectingCtx,
    );
    const result = await provider.chat(chatRequest(), ctx);
    expect(result.kind).toBe("completion");
    // Trailing slash on baseUrl must not double the separator.
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });
});
