import { describe, expect, it } from "vitest";
import type { ChatCompletion } from "../../src/openai/types.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import {
  CHAT_BODY,
  cannedCompletion,
  chatRequest,
  createTestApp,
  FIXED_NOW,
  tokenCounterKey,
} from "./helpers.js";

const ROUTED_YAML = `
version: 1
security:
  providers:
    - type: fake-auth
providers:
  fake:
    type: fake
routing:
  routes:
    - name: smart-for-pro
      when: 'request.model == "smart" && user.claims.tier == "pro"'
      provider: fake
      model: fake-large
  defaultProvider: fake
`;

describe("POST /v1/chat/completions", () => {
  it("routes with a model override and returns only public completion fields", async () => {
    const completion = {
      ...cannedCompletion("fake-large"),
      provider: "fake-upstream",
      system_fingerprint: "upstream-fingerprint",
      service_tier: "internal",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: 0.01,
      },
    };
    const { app, providers } = await createTestApp({
      yaml: ROUTED_YAML,
      behaviors: { fake: { completion } },
    });
    const messages = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hello" },
    ];
    const response = await app.fetch(
      chatRequest({ model: "smart", messages, temperature: 0.7 }, { "x-test-user": "pro" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: expect.stringMatching(/^chatcmpl-/),
      object: "chat.completion",
      created: FIXED_NOW / 1000,
      // The upstream override is deliberately hidden from clients.
      model: "smart",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello from fake" },
          finish_reason: "stop",
        },
      ],
    });

    const call = providers.get("fake")?.chatCalls[0];
    // The provider sees the route's model override but the client's payload verbatim.
    expect(call?.request.model).toBe("fake-large");
    expect(call?.request.messages).toEqual(messages);
    expect(call?.request.temperature).toBe(0.7);
  });

  it("keeps the client model when no route overrides it", async () => {
    const { app, providers } = await createTestApp({ yaml: ROUTED_YAML });
    const response = await app.fetch(
      chatRequest({ model: "smart", messages: CHAT_BODY.messages }, { "x-test-user": "free" }),
    );
    expect(response.status).toBe(200);
    // tier "free" misses the route; the default provider gets the verbatim model.
    expect(providers.get("fake")?.chatCalls[0]?.request.model).toBe("smart");
  });

  it("records completion usage against token budgets via waitUntil", async () => {
    const yaml = `
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
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, collector } = await createTestApp({ yaml, storage });
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(200);
    await collector.flush();
    // Default canned usage is 15 total tokens. A verifier is mandatory, so the
    // request is authenticated and keys on its identity (see createTestApp).
    const counter = await storage.getCounter(
      tokenCounterKey("daily-tokens", "test-user", 3_600_000),
    );
    expect(counter).toBe(15);
  });

  it("falls through routes to modelRules and then defaultProvider", async () => {
    const yaml = `
version: 1
providers:
  alpha:
    type: fake
  beta:
    type: fake
routing:
  modelRules:
    - match: 'request.model.startsWith("claude-")'
      provider: beta
  defaultProvider: alpha
`;
    const { app, providers } = await createTestApp({ yaml });

    const toBeta = await app.fetch(
      chatRequest({ model: "claude-opus-4", messages: CHAT_BODY.messages }),
    );
    expect(toBeta.status).toBe(200);
    expect(providers.get("beta")?.chatCalls).toHaveLength(1);
    expect(providers.get("alpha")?.chatCalls).toHaveLength(0);

    const toAlpha = await app.fetch(chatRequest({ model: "gpt-4o", messages: CHAT_BODY.messages }));
    expect(toAlpha.status).toBe(200);
    expect(providers.get("alpha")?.chatCalls).toHaveLength(1);
  });

  it("returns 404 model_not_found when nothing matches and no default exists", async () => {
    const yaml = `
version: 1
providers:
  fake:
    type: fake
routing:
  modelRules:
    - match: 'request.model.startsWith("claude-")'
      provider: fake
`;
    const { app } = await createTestApp({ yaml });
    const response = await app.fetch(
      chatRequest({ model: "unknown-model", messages: CHAT_BODY.messages }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { message: string; code: string; param: string };
    };
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.param).toBe("model");
    expect(body.error.message).toContain("unknown-model");
  });

  it("rejects invalid JSON with 400", async () => {
    const { app } = await createTestApp({ yaml: ROUTED_YAML });
    const response = await app.fetch(chatRequest("{oops", { "x-test-user": "pro" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects a missing model with 400 and param", async () => {
    const { app } = await createTestApp({ yaml: ROUTED_YAML });
    const response = await app.fetch(
      chatRequest({ messages: CHAT_BODY.messages }, { "x-test-user": "pro" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { param: string } };
    expect(body.error.param).toBe("model");
  });

  it("rejects missing messages with 400 and param", async () => {
    const { app } = await createTestApp({ yaml: ROUTED_YAML });
    const response = await app.fetch(chatRequest({ model: "smart" }, { "x-test-user": "pro" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { param: string } };
    expect(body.error.param).toBe("messages");
  });

  it("rejects a non-object body with 400", async () => {
    const { app } = await createTestApp({ yaml: ROUTED_YAML });
    const response = await app.fetch(chatRequest("42", { "x-test-user": "pro" }));
    expect(response.status).toBe(400);
  });

  it("redacts provider error details", async () => {
    const errorBody = {
      error: {
        message: "[provider fake] upstream exploded",
        type: "api_error",
        param: null,
        code: "upstream_error",
      },
    };
    const { app } = await createTestApp({
      yaml: ROUTED_YAML,
      behaviors: { fake: { error: { status: 502, body: errorBody } } },
    });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "pro" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "upstream model request failed",
        type: "api_error",
        param: null,
        code: "upstream_error",
      },
    });
  });

  it("forwards the inbound abort signal to the provider", async () => {
    const { app, providers } = await createTestApp({ yaml: ROUTED_YAML });
    const controller = new AbortController();
    const response = await app.fetch(
      chatRequest(CHAT_BODY, { "x-test-user": "pro" }, { signal: controller.signal }),
    );
    expect(response.status).toBe(200);
    const signal = providers.get("fake")?.chatCalls[0]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    // The request's signal is dependent on the caller's controller.
    expect(signal?.aborted).toBe(true);
  });

  it("returns a completion without usage without scheduling usage recording", async () => {
    const completion: ChatCompletion = cannedCompletion("smart");
    delete completion.usage;
    const { app, collector } = await createTestApp({
      yaml: ROUTED_YAML,
      behaviors: { fake: { completion } },
    });
    const response = await app.fetch(chatRequest(CHAT_BODY, { "x-test-user": "pro" }));
    expect(response.status).toBe(200);
    expect(collector.count).toBe(0);
  });
});
