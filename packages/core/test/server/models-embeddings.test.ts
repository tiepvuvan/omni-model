import { describe, expect, it } from "vitest";
import type { EmbeddingsResponse, ModelInfo, ModelList } from "../../src/openai/types.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import { createTestApp, embeddingsRequest, FIXED_NOW, tokenCounterKey } from "./helpers.js";

function model(id: string, ownedBy: string): ModelInfo {
  return { id, object: "model", created: 1, owned_by: ownedBy };
}

describe("GET /v1/models", () => {
  it("lists the client-facing allowlist, not the upstream catalogue", async () => {
    // The proxy owns the names a client may ask for. A rule can forward "smart"
    // to gpt-4o-mini, so advertising the upstream's catalogue would name models
    // the proxy does not answer to and omit the ones it does.
    const yaml = `
version: 1
routing:
  allowedModels: [smart, fast]
  rules:
    - { id: fake, when: "true", target: { type: fake, model: gpt-4o-mini } }
`;
    const { app } = await createTestApp({
      yaml,
      behaviors: { fake: { models: [model("upstream-secret", "fake")] } },
    });

    const body = (await (
      await app.fetch(new Request("http://local/v1/models"))
    ).json()) as ModelList;
    expect(body).toEqual({
      object: "list",
      data: [
        { id: "smart", object: "model", created: 0, owned_by: "omni-model" },
        { id: "fast", object: "model", created: 0, owned_by: "omni-model" },
      ],
    });
    // Never the upstream's own names, and never which upstream served them.
    expect(JSON.stringify(body)).not.toContain("upstream-secret");
  });

  it("falls back to the models the rules forward to, deduped", async () => {
    // With no allowlist the client-facing surface is not enumerable in general —
    // a rule may match a pattern — so this is the closest honest answer.
    const yaml = `
version: 1
routing:
  rules:
    - { id: a, when: 'request.model == "x"', target: { type: fake, model: gpt-4o } }
    - { id: b, when: 'request.model == "y"', target: { type: fake, model: claude-sonnet } }
    - { id: c, when: "true", target: { type: fake, model: gpt-4o } }
`;
    const { app } = await createTestApp({ yaml });
    const body = (await (
      await app.fetch(new Request("http://local/v1/models"))
    ).json()) as ModelList;
    expect(body.data.map((entry) => entry.id)).toEqual(["gpt-4o", "claude-sonnet"]);
    expect(body.data.every((entry) => entry.owned_by === "omni-model")).toBe(true);
  });

  it("returns an empty list when no rule names a model", async () => {
    // Every rule forwards whatever the client asked for, so there is nothing to
    // enumerate. `allowedModels` is how a deployment publishes a catalogue.
    const yaml = `
version: 1
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const { app } = await createTestApp({ yaml });
    const body = (await (
      await app.fetch(new Request("http://local/v1/models"))
    ).json()) as ModelList;
    expect(body).toEqual({ object: "list", data: [] });
  });

  it("does not contact any upstream to answer", async () => {
    // It used to query every provider's catalogue concurrently. Nothing about the
    // client-facing surface needs a network call, and a slow or broken upstream
    // should not make listing models slow or broken.
    const yaml = `
version: 1
routing:
  allowedModels: [smart]
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const { app } = await createTestApp({
      yaml,
      behaviors: { fake: { listModelsError: "upstream down" } },
    });
    const response = await app.fetch(new Request("http://local/v1/models"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as ModelList).data.map((entry) => entry.id)).toEqual(["smart"]);
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
routing:
  rules:
    - { id: embeddings, name: embeddings, when: 'request.model == "embed"', target: { type: fake, model: embed-large } }
`;

describe("POST /v1/embeddings", () => {
  it("routes, redacts the response and records usage with completion_tokens 0", async () => {
    const storage = new MemoryStorageAdapter(() => FIXED_NOW);
    const { app, providers, collector } = await createTestApp({
      yaml: EMBED_YAML,
      storage,
      behaviors: {
        embeddings: { embeddingsResult: { kind: "embeddings", response: EMBED_RESPONSE } },
      },
    });

    const response = await app.fetch(embeddingsRequest({ model: "embed", input: "hello" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      model: "embed",
    });
    // The route's model override reached the provider.
    expect(providers.get("embeddings")?.embeddingsCalls[0]?.model).toBe("embed-large");

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

  it("redacts provider embedding error details", async () => {
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
      behaviors: {
        embeddings: { embeddingsResult: { kind: "error", status: 400, body: errorBody } },
      },
    });
    const response = await app.fetch(embeddingsRequest({ model: "embed", input: "x" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        message: "upstream model request failed",
        type: "invalid_request_error",
        param: null,
        code: "upstream_error",
      },
    });
  });

  it("rate limits embeddings like chat", async () => {
    const yaml = `
version: 1
rateLimits:
  - name: burst
    key: user
    requests: { limit: 1, window: 1m }
routing:
  rules:
    - { id: fake, when: "true", target: { type: fake } }
`;
    const { app } = await createTestApp({
      yaml,
      behaviors: { fake: { embeddingsResult: { kind: "embeddings", response: EMBED_RESPONSE } } },
    });
    expect((await app.fetch(embeddingsRequest({ model: "e", input: "x" }))).status).toBe(200);
    expect((await app.fetch(embeddingsRequest({ model: "e", input: "x" }))).status).toBe(429);
  });
});
