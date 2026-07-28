import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import type { ChatCompletionRequest } from "../../src/openai/types.js";
import { deepSeekProviderFactory } from "../../src/providers/openai.js";
import type { RuntimeContext } from "../../src/types.js";

const completion = {
  id: "deepseek-completion-1",
  object: "chat.completion" as const,
  created: 1,
  model: "deepseek-v4-flash",
  choices: [
    {
      index: 0,
      message: { role: "assistant" as const, content: "Hello" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

function runtime(fetch: typeof globalThis.fetch): RuntimeContext {
  return {
    env: {},
    fetch,
    now: () => 1_700_000_000_000,
    waitUntil: () => {},
    log: silentLogger,
  };
}

function request(extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Hi" }],
    ...extra,
  };
}

describe("DeepSeek provider", () => {
  it("requires an API key and rejects unknown options at bundle-build time", () => {
    const ctx = runtime(vi.fn() as unknown as typeof fetch);

    expect(() => deepSeekProviderFactory.create("deepseek-main", {}, ctx)).toThrow(ConfigError);
    expect(() =>
      deepSeekProviderFactory.create("deepseek-main", { apiKey: "secret", unsupported: true }, ctx),
    ).toThrow(ConfigError);
  });

  it("uses the official API root and forwards OpenAI-compatible chat fields", async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(completion),
    ) as unknown as typeof fetch;
    const provider = deepSeekProviderFactory.create(
      "deepseek-main",
      { apiKey: "deepseek-secret" },
      runtime(upstream),
    );
    const body = request({ thinking: { type: "disabled" } });

    const result = await provider.chat(body, runtime(upstream));

    expect(result.kind).toBe("completion");
    expect(provider.type).toBe("deepseek");
    expect(provider.embeddings).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
    const [input, init] = (upstream as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(input).toBe("https://api.deepseek.com/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer deepseek-secret");
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("discovers models through a configurable private gateway", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        object: "list",
        data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }],
      }),
    ) as unknown as typeof fetch;
    const ctx = runtime(upstream);
    const provider = deepSeekProviderFactory.create(
      "deepseek-private",
      { apiKey: "private-secret", baseUrl: "https://gateway.example/v1/" },
      ctx,
    );

    const models = await provider.listModels?.(ctx);

    expect(models?.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(upstream).toHaveBeenCalledWith(
      "https://gateway.example/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("requests stream usage and resolves DeepSeek's final usage chunk", async () => {
    const wire = [
      `data: ${JSON.stringify({
        id: "deepseek-completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }],
        usage: null,
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "deepseek-completion-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-flash",
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
          prompt_cache_hit_tokens: 4,
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    let sentBody: ChatCompletionRequest | null = null;
    const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as ChatCompletionRequest;
      return new Response(wire, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const ctx = runtime(upstream);
    const provider = deepSeekProviderFactory.create(
      "deepseek-main",
      { apiKey: "deepseek-secret" },
      ctx,
    );

    const result = await provider.chat(request({ stream: true }), ctx);

    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") return;
    await expect(new Response(result.sse).text()).resolves.toBe(wire);
    expect(sentBody?.stream_options).toEqual({ include_usage: true });
    await expect(result.usage).resolves.toMatchObject({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    });
  });

  it("reports a rejected credential without echoing it", async () => {
    const upstream = vi.fn(async () =>
      Response.json({ error: { message: "Authentication failed" } }, { status: 401 }),
    ) as unknown as typeof fetch;
    const ctx = runtime(upstream);
    const provider = deepSeekProviderFactory.create(
      "deepseek-main",
      { apiKey: "must-not-leak" },
      ctx,
    );

    const result = await provider.chat(request(), ctx);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(401);
    expect(result.body.error.type).toBe("authentication_error");
    expect(JSON.stringify(result.body)).not.toContain("must-not-leak");
  });

  it("normalizes an upstream 5xx to an OpenAI-style 502", async () => {
    const upstream = vi.fn(
      async () => new Response("temporarily unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    const ctx = runtime(upstream);
    const provider = deepSeekProviderFactory.create(
      "deepseek-main",
      { apiKey: "deepseek-secret" },
      ctx,
    );

    const result = await provider.chat(request(), ctx);

    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(502);
    expect(result.body.error).toMatchObject({ type: "api_error", code: "upstream_error" });
  });
});
