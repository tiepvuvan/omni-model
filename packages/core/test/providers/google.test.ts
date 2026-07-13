import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  EmbeddingsRequest,
} from "../../src/openai/types.js";
import { googleProviderFactory } from "../../src/providers/google.js";
import type { ChatProvider } from "../../src/providers/types.js";
import type { RuntimeContext } from "../../src/types.js";
import { readSSEStream } from "../../src/util/sse.js";

const FIXED_NOW_MS = 1_750_000_000_000;

function testCtx(fetchImpl: typeof fetch): RuntimeContext {
  return {
    env: {},
    fetch: fetchImpl,
    now: () => FIXED_NOW_MS,
    waitUntil: () => {},
    log: silentLogger,
  };
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** Fetch stub that records the request and replies with a canned response. */
function stubFetch(reply: () => Response): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return reply();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function createProvider(options: Record<string, unknown> = { apiKey: "test-key" }): ChatProvider {
  return googleProviderFactory.create("google-main", options, testCtx(fetch));
}

function textResponse(): Response {
  return Response.json({
    candidates: [
      {
        content: { role: "model", parts: [{ text: "ok" }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const events: string[] = [];
  for await (const message of readSSEStream(stream)) events.push(message.data);
  return events;
}

function expectCompletion(result: Awaited<ReturnType<ChatProvider["chat"]>>): ChatCompletion {
  if (result.kind !== "completion") throw new Error(`expected completion, got ${result.kind}`);
  return result.completion;
}

describe("googleProviderFactory", () => {
  it("rejects missing apiKey with a ConfigError", () => {
    expect(() => createProvider({})).toThrow(ConfigError);
    expect(() => createProvider({})).toThrow(/apiKey/);
  });

  it("rejects unknown option keys", () => {
    expect(() => createProvider({ apiKey: "k", apikey: "typo" })).toThrow(ConfigError);
  });

  it("tolerates the discriminating type key from the config block", () => {
    const provider = createProvider({ type: "google", apiKey: "k" });
    expect(provider.id).toBe("google-main");
    expect(provider.type).toBe("google");
  });

  it("defaults baseUrl to the public Gemini endpoint", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat({ model: "gemini-2.0-flash", messages: [] }, testCtx(fetch));
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
  });
});

describe("google request translation", () => {
  it("authenticates via the x-goog-api-key header, never the URL", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider({ apiKey: "sk-secret", baseUrl: "https://gl.test/v1beta" });
    await provider.chat({ model: "models/gemini-2.0-flash", messages: [] }, testCtx(fetch));
    const call = calls[0];
    expect(call?.headers["x-goog-api-key"]).toBe("sk-secret");
    expect(call?.url).toBe("https://gl.test/v1beta/models/gemini-2.0-flash:generateContent");
    expect(call?.url).not.toContain("sk-secret");
  });

  it("maps system/developer messages to systemInstruction and merges same-role turns", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [
          { role: "system", content: "be brief" },
          { role: "developer", content: "be safe" },
          { role: "user", content: "one" },
          { role: "user", content: "two" },
          { role: "assistant", content: "reply" },
          { role: "user", content: "three" },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    expect(body.systemInstruction.parts).toEqual([{ text: "be brief\n\nbe safe" }]);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "one" }, { text: "two" }] },
      { role: "model", parts: [{ text: "reply" }] },
      { role: "user", parts: [{ text: "three" }] },
    ]);
  });

  it("maps image parts: data URLs to inlineData, http URLs to fileData", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
              { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
            ],
          },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as { contents: Array<{ parts: unknown[] }> };
    expect(body.contents[0]?.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: "QUJD" } },
      { fileData: { fileUri: "https://example.com/cat.jpg" } },
    ]);
  });

  it("sanitizes tool parameter schemas for Gemini", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "look up weather",
              parameters: {
                $schema: "https://json-schema.org/draft-07/schema",
                type: "object",
                additionalProperties: false,
                properties: {
                  city: { type: "string" },
                  unit: { type: ["string", "null"], enum: ["c", "f"] },
                },
                required: ["city"],
              },
            },
          },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    };
    const declaration = body.tools[0]?.functionDeclarations[0];
    expect(declaration).toEqual({
      name: "get_weather",
      description: "look up weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          unit: { type: "string", nullable: true, enum: ["c", "f"] },
        },
        required: ["city"],
      },
    });
  });

  it("inlines local $ref and strips $defs/$ref from tool parameter schemas", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "book",
              parameters: {
                type: "object",
                $defs: {
                  Address: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    required: ["city"],
                  },
                },
                properties: { home: { $ref: "#/$defs/Address" } },
              },
            },
          },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    };
    const params = body.tools[0]?.functionDeclarations[0]?.parameters;
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("$defs");
    expect(params).toEqual({
      type: "object",
      properties: {
        home: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    });
  });

  it("does not infinite-loop on a cyclic $ref and drops the unresolved ref", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "tree",
              parameters: {
                type: "object",
                definitions: {
                  Node: {
                    type: "object",
                    properties: { next: { $ref: "#/definitions/Node" } },
                  },
                },
                properties: { root: { $ref: "#/definitions/Node" } },
              },
            },
          },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    };
    const params = body.tools[0]?.functionDeclarations[0]?.parameters;
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("definitions");
    // One level of Node is inlined; the recursive ref is dropped, leaving {}.
    expect(params).toEqual({
      type: "object",
      properties: {
        root: { type: "object", properties: { next: {} } },
      },
    });
  });

  it("treats explicit null sampling params as unset (no null forwarded upstream)", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        temperature: null,
        top_p: null,
        stop: null,
        max_tokens: null,
        max_completion_tokens: null,
      } as unknown as ChatCompletionRequest,
      testCtx(fetch),
    );
    const body = calls[0]?.body as { generationConfig?: Record<string, unknown> };
    // Every field was null -> no generationConfig at all.
    expect(body.generationConfig).toBeUndefined();
  });

  it("filters null/empty entries out of a stop array", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        stop: ["END", null, "", "STOP"],
      } as unknown as ChatCompletionRequest,
      testCtx(fetch),
    );
    const body = calls[0]?.body as { generationConfig?: Record<string, unknown> };
    expect(body.generationConfig).toEqual({ stopSequences: ["END", "STOP"] });
  });

  it.each([
    ["auto", { functionCallingConfig: { mode: "AUTO" } }],
    ["none", { functionCallingConfig: { mode: "NONE" } }],
    ["required", { functionCallingConfig: { mode: "ANY" } }],
    [
      { type: "function", function: { name: "get_weather" } },
      { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } },
    ],
  ])("maps tool_choice %j to toolConfig", async (toolChoice, expected) => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: toolChoice,
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as { toolConfig: unknown } | undefined;
    expect(body?.toolConfig).toEqual(expected);
  });

  it("maps tool results to functionResponse parts via the tool_call_id map", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [
          { role: "user", content: "weather in SF and a joke" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_abc", content: '{"temp":20}' },
          { role: "tool", tool_call_id: "call_missing", content: "plain text result" },
        ],
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
    });
    // Both tool messages merge into one user turn; unknown ids fall back.
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { result: { temp: 20 } } } },
        { functionResponse: { name: "unknown", response: { result: "plain text result" } } },
      ],
    });
  });

  it("builds generationConfig from sampling params and response_format", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    await provider.chat(
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 250,
        temperature: 0.5,
        top_p: 0.9,
        stop: "END",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            schema: { type: "object", additionalProperties: false, properties: {} },
          },
        },
      },
      testCtx(fetch),
    );
    const body = calls[0]?.body as { generationConfig: unknown } | undefined;
    expect(body?.generationConfig).toEqual({
      maxOutputTokens: 250,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ["END"],
      responseMimeType: "application/json",
      responseSchema: { type: "object", properties: {} },
    });
  });

  it("rejects n>1 with a 400 error without calling upstream", async () => {
    const { fetch, calls } = stubFetch(textResponse);
    const provider = createProvider();
    const result = await provider.chat(
      { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], n: 3 },
      testCtx(fetch),
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(400);
    expect(result.body.error.message).toBe("google provider does not support n>1");
    expect(calls).toHaveLength(0);
  });
});

describe("google response translation", () => {
  const request: ChatCompletionRequest = {
    model: "gemini-2.0-flash",
    messages: [{ role: "user", content: "hi" }],
  };

  it("translates a text candidate into an OpenAI completion", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Hello" }, { text: " world" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(completion.object).toBe("chat.completion");
    expect(completion.created).toBe(Math.floor(FIXED_NOW_MS / 1000));
    expect(completion.model).toBe("gemini-2.0-flash");
    expect(completion.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "Hello world" },
        finish_reason: "stop",
      },
    ]);
    expect(completion.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 });
  });

  it("translates functionCall parts into tool_calls", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "get_weather", args: { city: "SF" } } },
                { functionCall: { name: "tell_joke", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual([
      {
        id: "call_0",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
      { id: "call_1", type: "function", function: { name: "tell_joke", arguments: "{}" } },
    ]);
  });

  it("maps SAFETY finishReason to content_filter", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        candidates: [
          { content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "SAFETY" },
        ],
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    expect(completion.choices[0]?.finish_reason).toBe("content_filter");
  });

  it("fills missing usage fields with zero and sums the total", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3 },
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 });
  });

  it("folds thoughtsTokenCount into completion_tokens (thinking models)", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 4,
          totalTokenCount: 16,
        },
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    expect(completion.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 11,
      total_tokens: 16,
    });
  });

  it("turns a prompt block into an empty content_filter completion, not an error", async () => {
    const { fetch } = stubFetch(() =>
      Response.json({
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 },
      }),
    );
    const provider = createProvider();
    const completion = expectCompletion(await provider.chat(request, testCtx(fetch)));
    expect(completion.choices).toEqual([
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "content_filter",
      },
    ]);
    expect(completion.usage).toEqual({ prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 });
  });

  it("maps upstream 4xx errors to an error result with the Google message", async () => {
    const { fetch } = stubFetch(() =>
      Response.json(
        { error: { code: 400, message: "Invalid model name", status: "INVALID_ARGUMENT" } },
        { status: 400 },
      ),
    );
    const provider = createProvider();
    const result = await provider.chat(request, testCtx(fetch));
    expect(result).toEqual({
      kind: "error",
      status: 400,
      body: {
        error: {
          message: "[provider google-main] Invalid model name",
          type: "invalid_request_error",
          param: null,
          code: "upstream_error",
        },
      },
    });
  });

  it("maps a rejected fetch to a 502 error result", async () => {
    const failingFetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    const provider = createProvider();
    const result = await provider.chat(request, testCtx(failingFetch));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(502);
    expect(result.body.error.message).toContain("socket hang up");
  });
});

describe("google streaming", () => {
  const STREAM_FIXTURE = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}],"role":"model"},"index":0}]}',
    "",
    'data: {"candidates":[{"content":{"parts":[{"text":"lo"}],"role":"model"},"index":0}]}',
    "",
    'data: {"candidates":[{"content":{"parts":[{"text":"!"}],"role":"model"},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":3,"totalTokenCount":7}}',
    "",
    "",
  ].join("\n");

  function streamRequest(includeUsage = false): ChatCompletionRequest {
    return {
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    };
  }

  it("translates the SSE stream into OpenAI chunks ending with [DONE]", async () => {
    const { fetch, calls } = stubFetch(
      () => new Response(STREAM_FIXTURE, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(), testCtx(fetch));
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const events = await collectSSE(result.sse);
    expect(events).toHaveLength(4);
    expect(events[3]).toBe("[DONE]");

    const chunks = events.slice(0, 3).map((data) => JSON.parse(data ?? "") as ChatCompletionChunk);
    for (const chunk of chunks) {
      expect(chunk.id).toMatch(/^chatcmpl-/);
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.created).toBe(Math.floor(FIXED_NOW_MS / 1000));
      expect(chunk.model).toBe("gemini-2.0-flash");
    }
    expect(chunks[0]?.choices).toEqual([
      { index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null },
    ]);
    expect(chunks[1]?.choices).toEqual([
      { index: 0, delta: { content: "lo" }, finish_reason: null },
    ]);
    expect(chunks[2]?.choices).toEqual([
      { index: 0, delta: { content: "!" }, finish_reason: "stop" },
    ]);

    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 4,
      completion_tokens: 3,
      total_tokens: 7,
    });
  });

  it("emits an empty-choices usage chunk when include_usage is set", async () => {
    const { fetch } = stubFetch(
      () => new Response(STREAM_FIXTURE, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(true), testCtx(fetch));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const events = await collectSSE(result.sse);
    expect(events).toHaveLength(5);
    expect(events[4]).toBe("[DONE]");
    const usageChunk = JSON.parse(events[3] ?? "") as ChatCompletionChunk;
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage).toEqual({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
  });

  it("streams a functionCall as one complete tool_call chunk", async () => {
    const fixture = `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "get_weather", args: { city: "SF" } } }],
          },
          finishReason: "STOP",
        },
      ],
    })}\n\n`;
    const { fetch } = stubFetch(
      () => new Response(fixture, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(), testCtx(fetch));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const events = await collectSSE(result.sse);
    expect(events).toHaveLength(2);
    const chunk = JSON.parse(events[0] ?? "") as ChatCompletionChunk;
    expect(chunk.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunk.choices[0]?.delta.role).toBe("assistant");
    expect(chunk.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_0",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"SF"}' },
      },
    ]);
    await expect(result.usage).resolves.toBeNull();
  });

  it("cancelling the returned stream resolves usage and cancels the upstream reader", async () => {
    let upstreamCancelled = false;
    // A body that never yields data: read() blocks until the reader is cancelled.
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const { fetch } = stubFetch(
      () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(), testCtx(fetch));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const reader = result.sse.getReader();
    // Trigger a pull so the generator begins the (blocking) upstream read.
    reader.read().catch(() => {});
    await reader.cancel();

    // The usage promise must settle (no hang) and the upstream must be torn down.
    await expect(result.usage).resolves.toBeNull();
    expect(upstreamCancelled).toBe(true);
  });

  it("folds thoughtsTokenCount into the streaming usage accumulation", async () => {
    const fixture = `data: ${JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 4,
        totalTokenCount: 16,
      },
    })}\n\n`;
    const { fetch } = stubFetch(
      () => new Response(fixture, { headers: { "content-type": "text/event-stream" } }),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(true), testCtx(fetch));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const events = await collectSSE(result.sse);
    const usageChunk = JSON.parse(events[events.length - 2] ?? "") as ChatCompletionChunk;
    expect(usageChunk.usage).toEqual({ prompt_tokens: 5, completion_tokens: 11, total_tokens: 16 });
    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 5,
      completion_tokens: 11,
      total_tokens: 16,
    });
  });

  it("maps a streaming upstream error before any bytes to an error result", async () => {
    const { fetch } = stubFetch(() =>
      Response.json(
        { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
        { status: 429 },
      ),
    );
    const provider = createProvider();
    const result = await provider.chat(streamRequest(), testCtx(fetch));
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.status).toBe(429);
    expect(result.body.error.type).toBe("rate_limit_error");
    expect(result.body.error.message).toContain("Quota exceeded");
  });
});

describe("google listModels", () => {
  it("maps the models list, stripping the models/ prefix", async () => {
    const { fetch, calls } = stubFetch(() =>
      Response.json({
        models: [
          { name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash" },
          { name: "models/text-embedding-004" },
          { notName: true },
        ],
      }),
    );
    const provider = createProvider();
    const models = await provider.listModels?.(testCtx(fetch));
    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]?.headers["x-goog-api-key"]).toBe("test-key");
    expect(models).toEqual([
      { id: "gemini-2.0-flash", object: "model", created: 0, owned_by: "google" },
      { id: "text-embedding-004", object: "model", created: 0, owned_by: "google" },
    ]);
  });

  it("returns [] on upstream failure", async () => {
    const { fetch } = stubFetch(() => new Response("nope", { status: 500 }));
    const provider = createProvider();
    await expect(provider.listModels?.(testCtx(fetch))).resolves.toEqual([]);

    const failingFetch = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    await expect(provider.listModels?.(testCtx(failingFetch))).resolves.toEqual([]);
  });
});

describe("google embeddings", () => {
  it("embeds a single string via :embedContent", async () => {
    const { fetch, calls } = stubFetch(() =>
      Response.json({ embedding: { values: [0.1, 0.2, 0.3] } }),
    );
    const provider = createProvider();
    const result = await provider.embeddings?.(
      { model: "models/text-embedding-004", input: "hello" },
      testCtx(fetch),
    );
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
    expect(calls[0]?.body).toEqual({ content: { parts: [{ text: "hello" }] } });
    expect(result).toEqual({
      kind: "embeddings",
      response: {
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: "text-embedding-004",
      },
    });
  });

  it("embeds an array of strings via :batchEmbedContents", async () => {
    const { fetch, calls } = stubFetch(() =>
      Response.json({ embeddings: [{ values: [1, 2] }, { values: [3, 4] }] }),
    );
    const provider = createProvider();
    const result = await provider.embeddings?.(
      { model: "text-embedding-004", input: ["a", "b"] },
      testCtx(fetch),
    );
    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents",
    );
    expect(calls[0]?.body).toEqual({
      requests: [
        { model: "models/text-embedding-004", content: { parts: [{ text: "a" }] } },
        { model: "models/text-embedding-004", content: { parts: [{ text: "b" }] } },
      ],
    });
    expect(result).toEqual({
      kind: "embeddings",
      response: {
        object: "list",
        data: [
          { object: "embedding", index: 0, embedding: [1, 2] },
          { object: "embedding", index: 1, embedding: [3, 4] },
        ],
        model: "text-embedding-004",
      },
    });
  });

  it("rejects token-array input with a 400 error", async () => {
    const { fetch, calls } = stubFetch(() => Response.json({}));
    const provider = createProvider();
    const request: EmbeddingsRequest = { model: "text-embedding-004", input: [1, 2, 3] };
    const result = await provider.embeddings?.(request, testCtx(fetch));
    expect(result?.kind).toBe("error");
    if (result?.kind !== "error") return;
    expect(result.status).toBe(400);
    expect(result.body.error.message).toContain("not support");
    expect(calls).toHaveLength(0);
  });

  it("maps upstream embedding errors", async () => {
    const { fetch } = stubFetch(() =>
      Response.json(
        { error: { code: 403, message: "API key invalid", status: "PERMISSION_DENIED" } },
        { status: 403 },
      ),
    );
    const provider = createProvider();
    const result = await provider.embeddings?.(
      { model: "text-embedding-004", input: "x" },
      testCtx(fetch),
    );
    expect(result?.kind).toBe("error");
    if (result?.kind !== "error") return;
    expect(result.status).toBe(403);
    expect(result.body.error.type).toBe("permission_error");
    expect(result.body.error.message).toContain("API key invalid");
  });
});
