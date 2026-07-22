import { describe, expect, it } from "vitest";
import type { ChatCompletionChunk } from "../../src/openai/types.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { chatRequest, createTestApp, FIXED_NOW, tokenCounterKey } from "./helpers.js";

const STREAM_YAML = `
version: 1
rateLimits:
  - name: daily-tokens
    key: user
    tokens: { limit: 100000, window: 1h }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;

function chunk(content: string, finish: string | null = null): ChatCompletionChunk {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_750_000_000,
    model: "smart",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  };
}

describe("streaming chat completions", () => {
  it("redacts SSE metadata while recording upstream usage after the stream", async () => {
    const chunks = [
      {
        ...chunk("hel"),
        provider: "fake-upstream",
        system_fingerprint: "upstream-fingerprint",
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10, cost: 0.01 },
      },
      chunk("lo", "stop"),
    ];
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({
      yaml: STREAM_YAML,
      storage,
      behaviors: {
        fake: {
          streamChunks: chunks,
          streamUsage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        },
      },
    });

    const response = await app.fetch(
      chatRequest({ model: "smart", messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"model":"smart"');
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).not.toContain("fake-upstream");
    expect(text).not.toContain("upstream-fingerprint");
    expect(text).not.toContain('"usage"');
    expect(text).not.toContain('"cost"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // Usage recording was scheduled via waitUntil and lands after the stream.
    expect(collector.count).toBe(1);
    await collector.flush();
    const counter = await storage.getCounter(
      tokenCounterKey("daily-tokens", "test-user", 3_600_000),
    );
    expect(counter).toBe(10);
  });

  it("records nothing when the upstream reported no usage", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({
      yaml: STREAM_YAML,
      storage,
      behaviors: { fake: { streamChunks: [chunk("hi", "stop")], streamUsage: null } },
    });
    const response = await app.fetch(
      chatRequest({ model: "smart", messages: [{ role: "user", content: "hi" }], stream: true }),
    );
    await response.text();
    await collector.flush();
    const counter = await storage.getCounter(
      tokenCounterKey("daily-tokens", "test-user", 3_600_000),
    );
    expect(counter).toBe(0);
  });
});
