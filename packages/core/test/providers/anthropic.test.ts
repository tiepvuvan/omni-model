import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
} from "../../src/openai/types.js";
import { anthropicProviderFactory } from "../../src/providers/anthropic.js";
import type { ChatProvider, ChatResult } from "../../src/providers/types.js";
import type { Logger, RuntimeContext } from "../../src/types.js";
import { readSSEStream } from "../../src/util/sse.js";

const FIXED_NOW = 1_700_000_000_000;

function makeCtx(fetchImpl: typeof fetch, log: Logger = silentLogger): RuntimeContext {
  return { env: {}, fetch: fetchImpl, now: () => FIXED_NOW, waitUntil: () => {}, log };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function fetchStub(respond: () => Response | Promise<Response>): {
  calls: CapturedCall[];
  impl: typeof fetch;
} {
  const calls: CapturedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, impl };
}

function createProvider(options: Record<string, unknown> = {}): ChatProvider {
  return anthropicProviderFactory.create(
    "anthropic-main",
    { type: "anthropic", apiKey: "sk-ant-test", ...options },
    makeCtx(fetchStub(() => new Response(null, { status: 500 })).impl),
  );
}

function anthropicResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  });
}

function baseRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "Hi" }], ...overrides };
}

/** Run a chat call and return the JSON body that was sent upstream. */
async function sentBody(request: ChatCompletionRequest): Promise<Record<string, unknown>> {
  const { calls, impl } = fetchStub(() => anthropicResponse());
  const result = await createProvider().chat(request, makeCtx(impl));
  expect(result.kind).toBe("completion");
  return JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
}

function sseResponse(events: string): Response {
  const bytes = new TextEncoder().encode(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** The canned Anthropic stream: text, then a tool call, then tool_use stop. */
const STREAM_FIXTURE =
  sseEvent("message_start", { message: { id: "msg_123", usage: { input_tokens: 25 } } }) +
  sseEvent("ping", {}) +
  sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: " world" } }) +
  sseEvent("content_block_stop", { index: 0 }) +
  sseEvent("content_block_start", {
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
  }) +
  sseEvent("content_block_delta", {
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"city":' },
  }) +
  sseEvent("content_block_delta", {
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"Paris"}' },
  }) +
  sseEvent("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 17 } }) +
  sseEvent("message_stop", {});

async function collectStream(
  result: ChatResult,
): Promise<{ chunks: ChatCompletionChunk[]; sawDone: boolean }> {
  if (result.kind !== "stream") throw new Error(`expected stream result, got ${result.kind}`);
  const chunks: ChatCompletionChunk[] = [];
  let sawDone = false;
  for await (const message of readSSEStream(result.sse)) {
    if (message.data === "[DONE]") {
      sawDone = true;
      continue;
    }
    chunks.push(JSON.parse(message.data) as ChatCompletionChunk);
  }
  return { chunks, sawDone };
}

describe("anthropicProviderFactory", () => {
  it("rejects missing apiKey", () => {
    expect(() =>
      anthropicProviderFactory.create(
        "a",
        { type: "anthropic" },
        makeCtx(fetchStub(() => anthropicResponse()).impl),
      ),
    ).toThrow(ConfigError);
  });

  it("rejects unknown option keys", () => {
    expect(() =>
      anthropicProviderFactory.create(
        "a",
        { type: "anthropic", apiKey: "k", apiKye: "typo" },
        makeCtx(fetchStub(() => anthropicResponse()).impl),
      ),
    ).toThrow(ConfigError);
  });

  it("exposes id and type", () => {
    const provider = createProvider();
    expect(provider.id).toBe("anthropic-main");
    expect(provider.type).toBe("anthropic");
  });
});

describe("anthropic request translation", () => {
  it("sends auth and version headers to <baseUrl>/v1/messages", async () => {
    const { calls, impl } = fetchStub(() => anthropicResponse());
    await createProvider().chat(baseRequest(), makeCtx(impl));
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("honors baseUrl and version options", async () => {
    const { calls, impl } = fetchStub(() => anthropicResponse());
    const provider = createProvider({
      baseUrl: "https://proxy.example.com/",
      version: "2024-01-01",
    });
    await provider.chat(baseRequest(), makeCtx(impl));
    expect(calls[0]?.url).toBe("https://proxy.example.com/v1/messages");
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.["anthropic-version"]).toBe("2024-01-01");
  });

  it("merges system and developer messages into the system string", async () => {
    const body = await sentBody(
      baseRequest({
        messages: [
          { role: "system", content: "Be terse." },
          {
            role: "developer",
            content: [
              { type: "text", text: "Dev note A" },
              { type: "text", text: "Dev note B" },
            ],
          },
          { role: "user", content: "Hi" },
        ],
      }),
    );
    expect(body.system).toBe("Be terse.\n\nDev note A\n\nDev note B");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  });

  it("translates image parts from data URLs and http URLs", async () => {
    const body = await sentBody(
      baseRequest({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
              { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
    ]);
  });

  it("maps assistant tool_calls to tool_use blocks, tolerating bad JSON", async () => {
    const body = await sentBody(
      baseRequest({
        messages: [
          { role: "user", content: "Look up cats" },
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"cats"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "lookup", arguments: "not json" },
              },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Look up cats" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "lookup", input: { q: "cats" } },
          { type: "tool_use", id: "call_2", name: "lookup", input: {} },
        ],
      },
    ]);
  });

  it("merges consecutive tool messages (and a following user turn) into one user message", async () => {
    const toolCalls: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
      ],
    };
    const body = await sentBody(
      baseRequest({
        messages: [
          { role: "user", content: "go" },
          toolCalls,
          { role: "tool", tool_call_id: "call_1", content: "result one" },
          { role: "tool", tool_call_id: "call_2", content: "result two" },
          { role: "user", content: "thanks" },
        ],
      }),
    );
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "call_1", content: "result one" },
      { type: "tool_result", tool_use_id: "call_2", content: "result two" },
      { type: "text", text: "thanks" },
    ]);
  });

  it("clamps temperature to [0,1] and passes top_p, stop and user through", async () => {
    const body = await sentBody(
      baseRequest({ temperature: 1.7, top_p: 0.9, stop: "END", user: "user-42" }),
    );
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.9);
    expect(body.stop_sequences).toEqual(["END"]);
    expect(body.metadata).toEqual({ user_id: "user-42" });

    const negative = await sentBody(baseRequest({ temperature: -0.5, stop: ["a", "b"] }));
    expect(negative.temperature).toBe(0);
    expect(negative.stop_sequences).toEqual(["a", "b"]);
  });

  it("defaults max_tokens and prefers max_completion_tokens", async () => {
    expect((await sentBody(baseRequest())).max_tokens).toBe(4096);
    expect((await sentBody(baseRequest({ max_tokens: 222 }))).max_tokens).toBe(222);
    expect(
      (await sentBody(baseRequest({ max_tokens: 222, max_completion_tokens: 111 }))).max_tokens,
    ).toBe(111);

    const { calls, impl } = fetchStub(() => anthropicResponse());
    await createProvider({ maxTokensDefault: 1024 }).chat(baseRequest(), makeCtx(impl));
    expect((JSON.parse(calls[0]?.init.body as string) as { max_tokens: number }).max_tokens).toBe(
      1024,
    );
  });

  it("maps tool_choice variants and drops tools when choice is none", async () => {
    const tools = [
      {
        type: "function" as const,
        function: { name: "lookup", description: "Find things", parameters: { type: "object" } },
      },
    ];

    const auto = await sentBody(baseRequest({ tools, tool_choice: "auto" }));
    expect(auto.tools).toEqual([
      { name: "lookup", description: "Find things", input_schema: { type: "object" } },
    ]);
    expect(auto.tool_choice).toEqual({ type: "auto" });

    const required = await sentBody(baseRequest({ tools, tool_choice: "required" }));
    expect(required.tool_choice).toEqual({ type: "any" });

    const named = await sentBody(
      baseRequest({ tools, tool_choice: { type: "function", function: { name: "lookup" } } }),
    );
    expect(named.tool_choice).toEqual({ type: "tool", name: "lookup" });

    const none = await sentBody(baseRequest({ tools, tool_choice: "none" }));
    expect(none.tools).toBeUndefined();
    expect(none.tool_choice).toBeUndefined();

    const unspecified = await sentBody(baseRequest({ tools }));
    expect(unspecified.tools).toHaveLength(1);
    expect(unspecified.tool_choice).toBeUndefined();
  });

  it("rejects n>1 without calling upstream", async () => {
    const { calls, impl } = fetchStub(() => anthropicResponse());
    const result = await createProvider().chat(baseRequest({ n: 2 }), makeCtx(impl));
    expect(result).toMatchObject({
      kind: "error",
      status: 400,
      body: { error: { type: "invalid_request_error" } },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("anthropic response translation", () => {
  it("builds an OpenAI completion from text + tool_use content", async () => {
    const { impl } = fetchStub(() =>
      anthropicResponse({
        content: [
          { type: "text", text: "Sunny" },
          { type: "text", text: " today" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    if (result.kind !== "completion") throw new Error(`expected completion, got ${result.kind}`);
    expect(result.completion).toEqual({
      id: "msg_01",
      object: "chat.completion",
      created: FIXED_NOW / 1000,
      model: "claude-sonnet-4-5",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Sunny today",
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("uses null content when only tool_use blocks are present", async () => {
    const { impl } = fetchStub(() =>
      anthropicResponse({
        content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }],
        stop_reason: "tool_use",
      }),
    );
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    if (result.kind !== "completion") throw new Error(`expected completion, got ${result.kind}`);
    expect(result.completion.choices[0]?.message.content).toBeNull();
  });

  it.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    ["some_future_reason", "stop"],
  ])("maps stop_reason %s to finish_reason %s", async (stopReason, finishReason) => {
    const { impl } = fetchStub(() => anthropicResponse({ stop_reason: stopReason }));
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    if (result.kind !== "completion") throw new Error(`expected completion, got ${result.kind}`);
    expect(result.completion.choices[0]?.finish_reason).toBe(finishReason);
  });

  it("maps an upstream 401 to an authentication error result", async () => {
    const { impl } = fetchStub(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
          { status: 401 },
        ),
    );
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    expect(result).toMatchObject({
      kind: "error",
      status: 401,
      body: { error: { type: "authentication_error", code: "upstream_error" } },
    });
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.body.error.message).toContain("invalid x-api-key");
  });

  it("maps upstream 5xx to a 502 error result", async () => {
    const { impl } = fetchStub(() => new Response("overloaded", { status: 529 }));
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    expect(result).toMatchObject({ kind: "error", status: 502 });
  });

  it("maps a fetch rejection to a 502 error result", async () => {
    const impl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const result = await createProvider().chat(baseRequest(), makeCtx(impl));
    expect(result).toMatchObject({
      kind: "error",
      status: 502,
      body: { error: { type: "api_error", code: "upstream_error" } },
    });
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.body.error.message).toContain("ECONNREFUSED");
  });
});

describe("anthropic streaming translation", () => {
  it("translates the event stream into OpenAI chunks", async () => {
    const { calls, impl } = fetchStub(() => sseResponse(STREAM_FIXTURE));
    const result = await createProvider().chat(baseRequest({ stream: true }), makeCtx(impl));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    expect((JSON.parse(calls[0]?.init.body as string) as { stream: boolean }).stream).toBe(true);

    const { chunks, sawDone } = await collectStream(result);
    expect(sawDone).toBe(true);
    expect(chunks).toHaveLength(7);

    for (const chunk of chunks) {
      expect(chunk.id).toBe("chatcmpl-msg_123");
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.created).toBe(FIXED_NOW / 1000);
      expect(chunk.model).toBe("claude-sonnet-4-5");
    }

    expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(chunks[1]?.choices[0]?.delta).toEqual({ content: "Hello" });
    expect(chunks[2]?.choices[0]?.delta).toEqual({ content: " world" });
    expect(chunks[3]?.choices[0]?.delta).toEqual({
      tool_calls: [
        {
          index: 0,
          id: "toolu_1",
          type: "function",
          function: { name: "get_weather", arguments: "" },
        },
      ],
    });
    expect(chunks[4]?.choices[0]?.delta).toEqual({
      tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
    });
    expect(chunks[5]?.choices[0]?.delta).toEqual({
      tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
    });
    const args = [chunks[4], chunks[5]]
      .map((c) => c?.choices[0]?.delta.tool_calls?.[0]?.function?.arguments ?? "")
      .join("");
    expect(JSON.parse(args)).toEqual({ city: "Paris" });

    expect(chunks[6]?.choices[0]?.delta).toEqual({});
    expect(chunks[6]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(chunks.slice(0, 6).every((c) => c.choices[0]?.finish_reason === null)).toBe(true);

    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 25,
      completion_tokens: 17,
      total_tokens: 42,
    });
  });

  it("emits a trailing usage chunk when include_usage is requested", async () => {
    const { impl } = fetchStub(() => sseResponse(STREAM_FIXTURE));
    const result = await createProvider().chat(
      baseRequest({ stream: true, stream_options: { include_usage: true } }),
      makeCtx(impl),
    );
    const { chunks, sawDone } = await collectStream(result);
    expect(sawDone).toBe(true);
    expect(chunks).toHaveLength(8);
    const last = chunks[chunks.length - 1];
    expect(last?.choices).toEqual([]);
    expect(last?.usage).toEqual({ prompt_tokens: 25, completion_tokens: 17, total_tokens: 42 });
  });

  it("resolves usage when the consumer cancels early", async () => {
    const { impl } = fetchStub(() => sseResponse(STREAM_FIXTURE));
    const result = await createProvider().chat(baseRequest({ stream: true }), makeCtx(impl));
    if (result.kind !== "stream") throw new Error(`expected stream, got ${result.kind}`);

    const reader = result.sse.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();

    // Only message_start was consumed, so output tokens were never observed.
    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 25,
      completion_tokens: 0,
      total_tokens: 25,
    });
  });

  it("ends the stream gracefully on an upstream error event", async () => {
    const fixture =
      sseEvent("message_start", { message: { id: "msg_err", usage: { input_tokens: 3 } } }) +
      sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }) +
      sseEvent("error", { error: { type: "overloaded_error", message: "Overloaded" } });
    const warnings: string[] = [];
    const log: Logger = {
      ...silentLogger,
      warn: (message) => {
        warnings.push(message);
      },
    };
    const { impl } = fetchStub(() => sseResponse(fixture));
    const result = await createProvider().chat(baseRequest({ stream: true }), makeCtx(impl, log));
    const { chunks, sawDone } = await collectStream(result);

    expect(sawDone).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(chunks[2]?.choices[0]?.delta).toEqual({});
    expect(chunks[2]?.choices[0]?.finish_reason).toBe("stop");
    expect(warnings).toHaveLength(1);
    if (result.kind !== "stream") throw new Error("expected stream");
    await expect(result.usage).resolves.toEqual({
      prompt_tokens: 3,
      completion_tokens: 0,
      total_tokens: 3,
    });
  });

  it("resolves usage as null when the upstream never reported it", async () => {
    const fixture =
      sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }) +
      sseEvent("message_stop", {});
    const { impl } = fetchStub(() => sseResponse(fixture));
    const result = await createProvider().chat(baseRequest({ stream: true }), makeCtx(impl));
    if (result.kind !== "stream") throw new Error("expected stream");
    await collectStream(result);
    await expect(result.usage).resolves.toBeNull();
  });
});
