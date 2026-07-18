import { describe, expect, it } from "vitest";
import type { EmbeddingsResponse, ModelInfo, ModelList } from "../../src/openai/types.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import {
  createRecordingLogger,
  createTestApp,
  embeddingsRequest,
  FIXED_NOW,
  tokenCounterKey,
} from "./helpers.js";

function model(id: string, ownedBy: string): ModelInfo {
  return { id, object: "model", created: 1, owned_by: ownedBy };
}

describe("GET /v1/models", () => {
  it("merges provider lists, dedupes by id (first wins) and skips failures", async () => {
    const yaml = `
version: 1
providers:
  alpha:
    type: fake
  beta:
    type: fake
  gamma:
    type: fake
  delta:
    type: fake
routing:
  defaultProvider: alpha
`;
    const { logger, entries } = createRecordingLogger();
    const { app } = await createTestApp({
      yaml,
      logger,
      behaviors: {
        alpha: { models: [model("m1", "alpha"), model("m2", "alpha")] },
        beta: { models: [model("m2", "beta"), model("m3", "beta")] },
        gamma: { listModelsError: "upstream down" },
        // delta has no listModels at all and is silently skipped.
      },
    });

    const response = await app.fetch(new Request("http://local/v1/models"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ModelList;
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    // Duplicate id m2 kept alpha's entry (config order).
    expect(body.data.find((m) => m.id === "m2")?.owned_by).toBe("alpha");

    const warning = entries.find(
      (entry) => entry.level === "warn" && entry.message.includes("listModels"),
    );
    expect(warning?.fields?.provider).toBe("gamma");
    expect(warning?.fields?.error).toBe("upstream down");
  });

  it("returns an empty list when no provider can list models", async () => {
    const yaml = `
version: 1
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({ yaml });
    const body = (await (
      await app.fetch(new Request("http://local/v1/models"))
    ).json()) as ModelList;
    expect(body).toEqual({ object: "list", data: [] });
  });
});

const EMBED_RESPONSE: EmbeddingsResponse = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
  model: "embed-large",
  usage: { prompt_tokens: 8, total_tokens: 8 },
};

const EMBED_YAML = `
version: 1
rateLimits:
  - name: daily-tokens
    key: user
    tokens: { limit: 100000, window: 1h }
providers:
  fake:
    type: fake
routing:
  routes:
    - name: embeddings
      when: 'request.model == "embed"'
      provider: fake
      model: embed-large
`;

describe("POST /v1/embeddings", () => {
  it("routes, relays the response and records usage with completion_tokens 0", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, providers, collector } = await createTestApp({
      yaml: EMBED_YAML,
      storage,
      behaviors: { fake: { embeddingsResult: { kind: "embeddings", response: EMBED_RESPONSE } } },
    });

    const response = await app.fetch(embeddingsRequest({ model: "embed", input: "hello" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(EMBED_RESPONSE);
    // The route's model override reached the provider.
    expect(providers.get("fake")?.embeddingsCalls[0]?.model).toBe("embed-large");

    await collector.flush();
    const counter = await storage.getCounter(
      tokenCounterKey("daily-tokens", "test-user", 3_600_000),
    );
    expect(counter).toBe(8);
  });

  it("returns 404 when the routed provider does not support embeddings", async () => {
    const { app } = await createTestApp({ yaml: EMBED_YAML });
    const response = await app.fetch(embeddingsRequest({ model: "embed", input: "hello" }));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("does not support embeddings");
  });

  it("rejects a missing model or input with 400 and param", async () => {
    const { app } = await createTestApp({ yaml: EMBED_YAML });

    const noModel = await app.fetch(embeddingsRequest({ input: "hello" }));
    expect(noModel.status).toBe(400);
    expect(((await noModel.json()) as { error: { param: string } }).error.param).toBe("model");

    const noInput = await app.fetch(embeddingsRequest({ model: "embed" }));
    expect(noInput.status).toBe(400);
    expect(((await noInput.json()) as { error: { param: string } }).error.param).toBe("input");
  });

  it("passes provider embedding errors through verbatim", async () => {
    const errorBody = {
      error: {
        message: "[provider fake] bad input",
        type: "invalid_request_error",
        param: null,
        code: "upstream_error",
      },
    };
    const { app } = await createTestApp({
      yaml: EMBED_YAML,
      behaviors: { fake: { embeddingsResult: { kind: "error", status: 400, body: errorBody } } },
    });
    const response = await app.fetch(embeddingsRequest({ model: "embed", input: "x" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(errorBody);
  });

  it("rate limits embeddings like chat", async () => {
    const yaml = `
version: 1
rateLimits:
  - name: burst
    key: user
    requests: { limit: 1, window: 1m }
providers:
  fake:
    type: fake
routing:
  defaultProvider: fake
`;
    const { app } = await createTestApp({
      yaml,
      behaviors: { fake: { embeddingsResult: { kind: "embeddings", response: EMBED_RESPONSE } } },
    });
    expect((await app.fetch(embeddingsRequest({ model: "e", input: "x" }))).status).toBe(200);
    expect((await app.fetch(embeddingsRequest({ model: "e", input: "x" }))).status).toBe(429);
  });
});
