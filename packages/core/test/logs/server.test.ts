import { describe, expect, it } from "vitest";
import { createMemoryRequestLogSink } from "../../src/logs/buffer.js";
import { REQUEST_ID_HEADER } from "../../src/server/logging.js";
import { WRITE_KEY_HEADER } from "../../src/server/writekey.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { MemoryWriteKeyStore } from "../../src/writekeys/memory.js";
import {
  CHAT_BODY,
  chatRequest,
  createTestProxy,
  embeddingsRequest,
  FIXED_NOW,
} from "../server/helpers.js";

function fixture(parts: { logging?: string; rateLimits?: string; security?: string } = {}): string {
  return [
    "version: 1",
    "storage: { type: memory }",
    'routing:\n  rules:\n    - { id: main, when: "true", target: { type: fake } }',
    parts.rateLimits ?? "rateLimits: []",
    parts.logging === undefined ? "" : `logging:${parts.logging}`,
    parts.security === undefined ? "" : `security:${parts.security}`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}

const CAPTURING = fixture({ logging: "\n  content: true" });

async function setup(
  yaml = fixture(),
  options: { storage?: MemoryStorageAdapter; behaviors?: Record<string, unknown> } = {},
) {
  const sink = createMemoryRequestLogSink({ batchSize: 1 });
  const writeKeys = new MemoryWriteKeyStore(() => FIXED_NOW);
  const proxy = await createTestProxy({
    yaml,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.behaviors === undefined
      ? {}
      : { behaviors: options.behaviors as Parameters<typeof createTestProxy>[0]["behaviors"] }),
    initOverrides: { requestLogs: sink, writeKeys },
  });
  const logs = async () => {
    await proxy.collector.flush();
    await sink.flush();
    return sink.writer.entries;
  };
  return { ...proxy, sink, writeKeys, logs };
}

describe("request logging", () => {
  it("records a successful request with routing and cost", async () => {
    const { app, logs } = await setup();
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(200);

    const [entry] = await logs();
    expect(entry).toMatchObject({
      status: 200,
      modelRequested: "smart",
      modelRouted: "smart",
      providerId: "fake",
      stream: false,
      errorCode: null,
    });
    expect(entry?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // Content is off by default, so nothing sensitive was stored.
    expect(entry?.content).toBeUndefined();
  });

  it("returns the request id, so a user can quote it in a support request", async () => {
    const { app, logs } = await setup();
    const response = await app.fetch(chatRequest(CHAT_BODY));

    const id = response.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await logs())[0]?.requestId).toBe(id);
  });

  it("returns the request id on failures and streams too", async () => {
    // Regression: `c.header()` seeds the response Hono builds, but a thrown
    // error and a directly-returned stream both replace it — dropping the header
    // on exactly the paths where a user needs an id to report.
    const rejected = await setup(fixture({ security: "\n  userAuth: { type: fake-auth }" }));
    const failure = await rejected.app.fetch(chatRequest(CHAT_BODY));
    expect(failure.status).toBe(401);
    expect(failure.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await rejected.logs())[0]?.requestId).toBe(failure.headers.get(REQUEST_ID_HEADER));

    const streaming = await setup(fixture(), {
      behaviors: {
        main: {
          streamChunks: [
            {
              id: "1",
              object: "chat.completion.chunk",
              created: 0,
              model: "m",
              choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
            },
          ],
        },
      },
    });
    const stream = await streaming.app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    expect(stream.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    await stream.text();
  });

  it("records the error code of an upstream failure", async () => {
    // An upstream error is *returned*, not thrown, so `app.onError` never sees
    // it. Without the handler recording the code, the row would give no reason.
    const { app, logs } = await setup(fixture(), {
      behaviors: {
        main: {
          error: {
            status: 502,
            body: {
              error: { message: "upstream exploded", type: "api_error", param: null, code: null },
            },
          },
        },
      },
    });

    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(502);

    expect((await logs())[0]).toMatchObject({ status: 502, errorCode: "upstream_error" });
  });

  it("records a rate-limited request, naming the rule that refused it", async () => {
    // A 429 row that does not say which limit was hit is nearly useless.
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, logs, collector } = await setup(
      fixture({
        rateLimits:
          "rateLimits:\n  - id: tight\n    name: tight\n    tokens: { limit: 5, window: 1h }",
      }),
      { storage },
    );

    await app.fetch(chatRequest(CHAT_BODY));
    await collector.flush();
    const refused = await app.fetch(chatRequest(CHAT_BODY));
    expect(refused.status).toBe(429);

    const entries = await logs();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      status: 429,
      errorCode: "rate_limit_exceeded",
      rateLimitRule: "tight",
    });
  });

  it("records an unauthenticated request", async () => {
    const { app, logs } = await setup(fixture({ security: "\n  userAuth: { type: fake-auth }" }));
    // No credential header: the fake verifier returns "not mine" and auth fails.
    const response = await app.fetch(chatRequest(CHAT_BODY));
    expect(response.status).toBe(401);

    expect((await logs())[0]).toMatchObject({ status: 401 });
  });

  it("records a request refused for a revoked client key", async () => {
    const { app, writeKeys, logs } = await setup();
    const { writeKey, secret } = await writeKeys.create({ name: "ios-app" });
    await writeKeys.revoke(writeKey.id);

    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: `Bearer ${secret}` }));

    const [entry] = await logs();
    expect(entry).toMatchObject({ status: 401, errorCode: "write_key_revoked" });
    // The key was refused, so it is not attributed — but the attempt is recorded.
    expect(entry?.writeKeyId).toBeNull();
  });

  it("attributes a request to its client and user", async () => {
    const { app, writeKeys, logs } = await setup(
      fixture({ security: "\n  userAuth: { type: fake-auth }" }),
    );
    const { writeKey, secret } = await writeKeys.create({ name: "ios-app" });

    await app.fetch(
      chatRequest(CHAT_BODY, {
        [WRITE_KEY_HEADER]: `Bearer ${secret}`,
        "x-test-user": "user-42",
      }),
    );

    expect((await logs())[0]).toMatchObject({
      status: 200,
      writeKeyId: writeKey.id,
      userId: "user-42",
      authProvider: "fake-auth",
    });
  });

  it("records the model a client was refused, not an empty one", async () => {
    const { app, writeKeys, logs } = await setup();
    const { secret } = await writeKeys.create({ name: "ios-app", allowedModels: ["cheap"] });

    const response = await app.fetch(
      chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: `Bearer ${secret}` }),
    );
    expect(response.status).toBe(404);

    // Regression: the allowlist check used to run before the draft was filled in,
    // so the row an operator looks at to answer "which model is this client being
    // refused" carried no model at all.
    expect((await logs())[0]).toMatchObject({
      status: 404,
      errorCode: "model_not_found",
      modelRequested: "smart",
      modelRouted: null,
      providerId: null,
    });
  });

  it("records the model when a request is refused by the deployment allowlist", async () => {
    const { app, logs } = await setup(
      [
        "version: 1",
        "storage: { type: memory }",
        'routing:\n  allowedModels: [cheap]\n  rules:\n    - { id: main, when: "true", target: { type: fake } }',
      ].join("\n"),
    );
    expect((await app.fetch(chatRequest(CHAT_BODY))).status).toBe(404);
    expect((await logs())[0]).toMatchObject({ status: 404, modelRequested: "smart" });
  });

  it("can be turned off and on by a reload", async () => {
    const { app, reload, logs } = await setup(fixture({ logging: "\n  requests: false" }));
    await app.fetch(chatRequest(CHAT_BODY));
    expect(await logs()).toHaveLength(0);

    await reload(fixture());
    await app.fetch(chatRequest(CHAT_BODY));
    expect(await logs()).toHaveLength(1);
  });

  it("records usage from a non-streamed completion", async () => {
    const { app, logs } = await setup(fixture(), {
      behaviors: {
        main: {
          completion: {
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "m",
            choices: [
              { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          },
        },
      },
    });

    await app.fetch(chatRequest(CHAT_BODY));

    expect((await logs())[0]).toMatchObject({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });
});

describe("content capture", () => {
  it("stores prompt and completion only when enabled", async () => {
    const behaviors = {
      main: {
        completion: {
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "the answer" },
              finish_reason: "stop",
            },
          ],
        },
      },
    };
    const off = await setup(fixture(), { behaviors });
    await off.app.fetch(chatRequest(CHAT_BODY));
    expect((await off.logs())[0]?.content).toBeUndefined();

    const on = await setup(CAPTURING, { behaviors });
    await on.app.fetch(chatRequest(CHAT_BODY));
    expect((await on.logs())[0]?.content).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      body: CHAT_BODY,
      headers: {
        "content-type": "application/json",
      },
      completion: "the answer",
      truncated: false,
    });
  });

  it("redacts credential headers and body fields before they reach the sink", async () => {
    const { app, logs } = await setup(CAPTURING);
    const request = chatRequest({ ...CHAT_BODY, apiKey: "body-secret" });
    request.headers.set("x-debug-token", "user-secret");
    request.headers.set("x-trace-id", "trace-9");

    await app.fetch(request);

    const content = (await logs())[0]?.content;
    expect(content?.headers).toMatchObject({
      "x-debug-token": "[REDACTED]",
      "x-trace-id": "trace-9",
    });
    expect(content?.body).toMatchObject({ apiKey: "[REDACTED]" });
    expect(JSON.stringify(content)).not.toContain("body-secret");
    expect(JSON.stringify(content)).not.toContain("user-secret");
  });

  it("captures embeddings input, redacted headers, and the complete body", async () => {
    const { app, logs } = await setup(CAPTURING, {
      behaviors: {
        main: {
          embeddingsResult: {
            kind: "embeddings",
            response: {
              object: "list",
              data: [{ object: "embedding", index: 0, embedding: [0.1] }],
              model: "embed",
              usage: { prompt_tokens: 3, total_tokens: 3 },
            },
          },
        },
      },
    });

    const response = await app.fetch(
      embeddingsRequest(
        { model: "smart", input: ["first", "second"], apiKey: "body-secret" },
        { "x-debug-token": "header-secret", "x-trace-id": "trace-embed" },
      ),
    );
    expect(response.status).toBe(200);

    const content = (await logs())[0]?.content;
    expect(content).toMatchObject({
      messages: ["first", "second"],
      headers: { "x-debug-token": "[REDACTED]", "x-trace-id": "trace-embed" },
      body: {
        model: "smart",
        input: ["first", "second"],
        apiKey: "[REDACTED]",
      },
    });
    expect(JSON.stringify(content)).not.toContain("body-secret");
    expect(JSON.stringify(content)).not.toContain("header-secret");
  });

  it("lets a write key opt in without enabling it for everyone", async () => {
    // Debugging one client must not mean logging every user's prompts.
    const { app, writeKeys, logs } = await setup();
    const optedIn = await writeKeys.create({ name: "debug-me", captureContent: true });
    const normal = await writeKeys.create({ name: "everyone-else" });

    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: `Bearer ${normal.secret}` }));
    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: `Bearer ${optedIn.secret}` }));

    const entries = await logs();
    expect(entries[0]?.content).toBeUndefined();
    expect(entries[1]?.content?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("lets a write key opt out when capture is on globally", async () => {
    const { app, writeKeys, logs } = await setup(CAPTURING);
    const optedOut = await writeKeys.create({ name: "sensitive", captureContent: false });

    await app.fetch(chatRequest(CHAT_BODY, { [WRITE_KEY_HEADER]: `Bearer ${optedOut.secret}` }));

    expect((await logs())[0]?.content).toBeUndefined();
  });

  it("truncates at the byte cap and says so", async () => {
    const { app, logs } = await setup(
      fixture({ logging: "\n  content: true\n  maxContentBytes: 40" }),
      {
        behaviors: {
          main: {
            completion: {
              id: "x",
              object: "chat.completion",
              created: 0,
              model: "m",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "y".repeat(500) },
                  finish_reason: "stop",
                },
              ],
            },
          },
        },
      },
    );

    await app.fetch(
      chatRequest({ ...CHAT_BODY, messages: [{ role: "user", content: "x".repeat(500) }] }),
    );

    const content = (await logs())[0]?.content;
    expect(content?.truncated).toBe(true);
    expect(JSON.stringify(content?.messages).length).toBeLessThan(200);
    expect((content?.completion ?? "").length).toBeLessThanOrEqual(40);
  });

  it("captures a streamed completion, assembled from its deltas", async () => {
    const { app, logs } = await setup(CAPTURING, {
      behaviors: {
        main: {
          streamChunks: [
            {
              id: "1",
              object: "chat.completion.chunk",
              created: 0,
              model: "m",
              choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }],
            },
            {
              id: "1",
              object: "chat.completion.chunk",
              created: 0,
              model: "m",
              choices: [{ index: 0, delta: { content: "lo!" }, finish_reason: "stop" }],
            },
          ],
          streamUsage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        },
      },
    });

    const response = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    // The row is written when the stream ends, so it must be drained first.
    await response.text();

    const [entry] = await logs();
    expect(entry).toMatchObject({ stream: true, status: 200, totalTokens: 4 });
    expect(entry?.content?.completion).toBe("Hello!");
  });

  it("still records a streamed request the client abandoned", async () => {
    // The usage promise settles on cancel too, which is what makes a hung-up
    // stream produce a row instead of vanishing.
    const { app, logs } = await setup(CAPTURING, {
      behaviors: {
        main: {
          streamChunks: [
            {
              id: "1",
              object: "chat.completion.chunk",
              created: 0,
              model: "m",
              choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
            },
          ],
        },
      },
    });

    const response = await app.fetch(chatRequest({ ...CHAT_BODY, stream: true }));
    await response.body?.cancel();

    const entries = await logs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ stream: true, status: 200 });
  });
});
