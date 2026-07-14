import {
  type ChatCompletion,
  type ChatProvider,
  createDefaultRegistry,
  type EmbeddingsResponse,
  type OmniConfig,
  omniConfigSchema,
  type ProviderFactory,
  silentLogger,
  sseStreamFromChunks,
  type Usage,
} from "@omni-model/core";
import type { FirestoreLike } from "@omni-model/storage-firestore";
import { buildOmniContext, type OmniContext } from "../src/context.js";

/** Fixed clock so rate-limit windows and TTLs stay deterministic across calls. */
export const FIXED_NOW = 1_700_000_000_000;

export const COMPLETION_USAGE: Usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };
export const STREAM_USAGE: Usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
export const EMBEDDINGS_USAGE = { prompt_tokens: 4, total_tokens: 4 };

export const CANNED_COMPLETION: ChatCompletion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 100,
  model: "fake-model",
  choices: [
    { index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" },
  ],
  usage: COMPLETION_USAGE,
};

const STREAM_CHUNKS = [
  {
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 200,
    model: "fake-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 200,
    model: "fake-model",
    choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-s",
    object: "chat.completion.chunk",
    created: 200,
    model: "fake-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
];

export const CANNED_EMBEDDINGS: EmbeddingsResponse = {
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
  model: "fake-embed",
  usage: EMBEDDINGS_USAGE,
};

async function* streamGen(): AsyncGenerator<unknown> {
  for (const chunk of STREAM_CHUNKS) yield chunk;
}

/** An SSE stream that emits one chunk then errors — models a mid-stream upstream failure. */
function brokenSseStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(STREAM_CHUNKS[0])}\n\n`));
        return;
      }
      controller.error(new Error("upstream disconnected mid-stream"));
    },
  });
}

/**
 * A canned provider whose behavior is chosen by its config `mode`
 * ("completion" | "stream" | "error"); `embeddings: true` enables the
 * embeddings endpoint. No network, fully deterministic.
 */
export function fakeProviderFactory(): ProviderFactory {
  return {
    type: "fake",
    create(id, options) {
      const mode = typeof options.mode === "string" ? options.mode : "completion";
      const status = typeof options.status === "number" ? options.status : 401;
      const errorResult = {
        kind: "error" as const,
        status,
        body: {
          error: {
            message: "bad upstream key",
            type: "authentication_error",
            param: null,
            code: null,
          },
        },
      };
      const provider: ChatProvider = {
        id,
        type: "fake",
        async chat() {
          if (mode === "error") return errorResult;
          if (mode === "stream") {
            return {
              kind: "stream",
              sse: sseStreamFromChunks(streamGen()),
              usage: Promise.resolve(STREAM_USAGE),
            };
          }
          if (mode === "stream-broken") {
            // The SSE errors mid-stream, but usage still resolves — the token
            // budget must be charged for what was consumed before the break.
            return {
              kind: "stream",
              sse: brokenSseStream(),
              usage: Promise.resolve(STREAM_USAGE),
            };
          }
          return { kind: "completion", completion: CANNED_COMPLETION };
        },
      };
      if (options.embeddings === true) {
        provider.embeddings = async () => {
          if (mode === "error") return errorResult;
          return { kind: "embeddings", response: CANNED_EMBEDDINGS };
        };
      }
      return provider;
    },
  };
}

/** No-op Firestore stub: never exercised because tests use memory storage. */
export const noopFirestore: FirestoreLike = {
  collection() {
    throw new Error("firestore should not be used with memory storage");
  },
  runTransaction() {
    throw new Error("firestore should not be used with memory storage");
  },
};

export interface FakeProviderConfig {
  mode?: "completion" | "stream" | "stream-broken" | "error";
  status?: number;
  embeddings?: boolean;
}

/** Parse a config object with a single `fake` provider and its defaults applied. */
export function makeConfig(input: {
  provider?: FakeProviderConfig;
  rateLimits?: unknown[];
  routing?: unknown;
}): OmniConfig {
  return omniConfigSchema.parse({
    server: { logLevel: "silent" },
    storage: { type: "memory" },
    providers: { fake: { type: "fake", ...(input.provider ?? { mode: "completion" }) } },
    routing: input.routing ?? { defaultProvider: "fake" },
    rateLimits: input.rateLimits ?? [],
  });
}

/** Build an OmniContext over memory storage with the fake provider registered. */
export function buildTestContext(input: {
  provider?: FakeProviderConfig;
  rateLimits?: unknown[];
  routing?: unknown;
}): Promise<OmniContext> {
  const registry = createDefaultRegistry();
  registry.providers.set("fake", fakeProviderFactory());
  return buildOmniContext(makeConfig(input), {
    firestore: noopFirestore,
    registry,
    now: () => FIXED_NOW,
    logger: silentLogger,
  });
}
