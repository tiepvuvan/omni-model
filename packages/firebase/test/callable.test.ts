import { describe, expect, test, vi } from "vitest";
import { createChatCallable, createEmbeddingsCallable } from "../src/callable.js";
import { CallableError, type CallableRequestLike } from "../src/identity.js";
import {
  buildTestContext,
  CANNED_COMPLETION,
  CANNED_EMBEDDINGS,
  COMPLETION_USAGE,
  STREAM_USAGE,
} from "./helpers.js";

const OPEN = { requireAuth: false, requireAppCheck: false } as const;

function chatData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: "gpt-x", messages: [{ role: "user", content: "hi" }], ...overrides };
}

describe("createChatCallable — non-streaming", () => {
  test("returns the completion and records usage", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const spy = vi.spyOn(ctx.deps.limiter, "recordUsage");
    const chat = createChatCallable(ctx, OPEN);

    const result = await chat({ data: chatData(), acceptsStreaming: false });

    expect(result).toEqual(CANNED_COMPLETION);
    expect(result.choices[0]?.message.content).toBe("hello world");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.anything(), COMPLETION_USAGE);
  });
});

describe("createChatCallable — streaming", () => {
  test("forwards each chunk and returns an aggregated completion", async () => {
    const ctx = await buildTestContext({ provider: { mode: "stream" } });
    const spy = vi.spyOn(ctx.deps.limiter, "recordUsage");
    const chat = createChatCallable(ctx, OPEN);

    const sent: unknown[] = [];
    const response = { sendChunk: (chunk: unknown) => sent.push(chunk) };
    const result = await chat({ data: chatData(), acceptsStreaming: true }, response);

    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ object: "chat.completion.chunk" });

    expect(result.object).toBe("chat.completion");
    expect(result.id).toBe("chatcmpl-s");
    expect(result.model).toBe("fake-model");
    expect(result.choices[0]?.message.content).toBe("Hello");
    expect(result.choices[0]?.message.role).toBe("assistant");
    expect(result.choices[0]?.finish_reason).toBe("stop");
    expect(result.usage).toEqual(STREAM_USAGE);

    expect(spy).toHaveBeenCalledWith(expect.anything(), STREAM_USAGE);
  });

  test("does not send chunks when the client did not request streaming", async () => {
    const ctx = await buildTestContext({ provider: { mode: "stream" } });
    const chat = createChatCallable(ctx, OPEN);

    const sent: unknown[] = [];
    const response = { sendChunk: (chunk: unknown) => sent.push(chunk) };
    const result = await chat({ data: chatData(), acceptsStreaming: false }, response);

    expect(sent).toHaveLength(0);
    expect(result.choices[0]?.message.content).toBe("Hello");
  });

  test("records usage and maps the error when the stream breaks mid-flight", async () => {
    // Regression: a mid-stream upstream failure must still charge the token
    // budget (usage resolves) and surface as a mapped CallableError, not hang.
    const ctx = await buildTestContext({ provider: { mode: "stream-broken" } });
    const spy = vi.spyOn(ctx.deps.limiter, "recordUsage");
    const chat = createChatCallable(ctx, OPEN);

    await expect(
      chat({ data: chatData(), acceptsStreaming: true }, { sendChunk: () => {} }),
    ).rejects.toBeInstanceOf(CallableError);
    expect(spy).toHaveBeenCalledWith(expect.anything(), STREAM_USAGE);
  });
});

describe("createChatCallable — identity enforcement", () => {
  const data = chatData();

  test("failed-precondition when App Check is required but missing", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, { requireAuth: false, requireAppCheck: true });
    await expect(chat({ data, auth: { uid: "u" } })).rejects.toMatchObject({
      code: "failed-precondition",
    });
  });

  test("unauthenticated when auth is required but missing", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, { requireAuth: true, requireAppCheck: false });
    await expect(chat({ data, app: { appId: "a" } })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  test("unauthenticated when the App Check token was already consumed", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, { requireAuth: false, requireAppCheck: true });
    await expect(chat({ data, app: { appId: "a", alreadyConsumed: true } })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });
});

describe("createChatCallable — invalid payloads", () => {
  test("invalid-argument when data is not an object", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, OPEN);
    await expect(chat({ data: "nope" } as CallableRequestLike)).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  test("invalid-argument when model is missing", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, OPEN);
    await expect(
      chat({ data: { messages: [{ role: "user", content: "hi" }] } }),
    ).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  test("invalid-argument when messages is missing or empty", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const chat = createChatCallable(ctx, OPEN);
    await expect(chat({ data: { model: "m" } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(chat({ data: { model: "m", messages: [] } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});

describe("createChatCallable — pipeline errors", () => {
  test("maps a rate-limit violation to resource-exhausted", async () => {
    const ctx = await buildTestContext({
      provider: { mode: "completion" },
      rateLimits: [{ name: "r", key: "global", requests: { limit: 1, window: "1m" } }],
    });
    const chat = createChatCallable(ctx, OPEN);

    await chat({ data: chatData() });
    const error = await chat({ data: chatData() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallableError);
    expect((error as CallableError).code).toBe("resource-exhausted");
  });

  test("token budget consumed by a first call rejects the second (usage was recorded)", async () => {
    const ctx = await buildTestContext({
      provider: { mode: "completion" },
      rateLimits: [{ name: "tb", key: "global", tokens: { limit: 10, window: "1h" } }],
    });
    const chat = createChatCallable(ctx, OPEN);

    // First call records COMPLETION_USAGE.total_tokens (12) > limit (10).
    await chat({ data: chatData() });
    await expect(chat({ data: chatData() })).rejects.toMatchObject({ code: "resource-exhausted" });
  });

  test("maps an upstream provider error (401) to unauthenticated", async () => {
    const ctx = await buildTestContext({ provider: { mode: "error", status: 401 } });
    const chat = createChatCallable(ctx, OPEN);
    await expect(chat({ data: chatData() })).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("createEmbeddingsCallable", () => {
  test("returns the embeddings response and records usage", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion", embeddings: true } });
    const spy = vi.spyOn(ctx.deps.limiter, "recordUsage");
    const embeddings = createEmbeddingsCallable(ctx, OPEN);

    const result = await embeddings({ data: { model: "embed-x", input: "hello" } });

    expect(result).toEqual(CANNED_EMBEDDINGS);
    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      prompt_tokens: 4,
      completion_tokens: 0,
      total_tokens: 4,
    });
  });

  test("not-found when the routed provider has no embeddings support", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion" } });
    const embeddings = createEmbeddingsCallable(ctx, OPEN);
    await expect(embeddings({ data: { model: "embed-x", input: "hello" } })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  test("invalid-argument when input is missing", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion", embeddings: true } });
    const embeddings = createEmbeddingsCallable(ctx, OPEN);
    await expect(embeddings({ data: { model: "embed-x" } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  test("invalid-argument when model is missing", async () => {
    const ctx = await buildTestContext({ provider: { mode: "completion", embeddings: true } });
    const embeddings = createEmbeddingsCallable(ctx, OPEN);
    await expect(embeddings({ data: { input: "hello" } })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});
