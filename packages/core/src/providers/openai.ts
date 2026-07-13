import { z } from "zod";
import { ConfigError } from "../errors.js";
import type {
  ChatCompletion,
  ChatCompletionRequest,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ModelInfo,
  OpenAIErrorBody,
  Usage,
} from "../openai/types.js";
import type { RuntimeContext } from "../types.js";
import { type SSEMessage, SSEParser } from "../util/sse.js";
import { createDeferred, joinUrl, openAIErrorBody, upstreamErrorToResult } from "./shared.js";
import type {
  ChatProvider,
  ChatResult,
  EmbeddingsResult,
  ProviderCallOptions,
  ProviderFactory,
} from "./types.js";

const commonOptionsShape = {
  /** The discriminating `type` from the config block; accepted and ignored. */
  type: z.string().optional(),
  organization: z.string().min(1).optional(),
  /** Extra headers merged over the computed ones (auth, content-type). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Static model list served when the upstream `/models` call fails. */
  models: z.array(z.string().min(1)).optional(),
  /**
   * Inject `stream_options.include_usage` into streaming requests so the
   * final chunk carries usage for token budgets.
   */
  includeStreamUsage: z.boolean().default(true),
};

const openAIOptionsSchema = z.strictObject({
  ...commonOptionsShape,
  apiKey: z.string().min(1),
  baseUrl: z.url().default("https://api.openai.com/v1"),
});

// Local OpenAI-compatible servers (Ollama, vLLM, ...) often need no API key,
// but there is no sensible default endpoint.
const openAICompatibleOptionsSchema = z.strictObject({
  ...commonOptionsShape,
  apiKey: z.string().min(1).optional(),
  baseUrl: z.url(),
});

interface ResolvedOptions {
  apiKey?: string;
  baseUrl: string;
  organization?: string;
  headers: Record<string, string>;
  models: string[];
  includeStreamUsage: boolean;
}

function parseOptions(
  schema: typeof openAIOptionsSchema | typeof openAICompatibleOptionsSchema,
  id: string,
  type: string,
  options: Record<string, unknown>,
): ResolvedOptions {
  const result = schema.safeParse(options);
  if (!result.success) {
    throw new ConfigError(
      `invalid options for provider "${id}" (type "${type}"):\n${z.prettifyError(result.error)}`,
    );
  }
  const parsed = result.data;
  return {
    apiKey: parsed.apiKey,
    baseUrl: parsed.baseUrl,
    organization: parsed.organization,
    headers: parsed.headers ?? {},
    models: parsed.models ?? [],
    includeStreamUsage: parsed.includeStreamUsage,
  };
}

function asUsage(value: unknown): Usage | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.prompt_tokens !== "number" ||
    typeof record.completion_tokens !== "number" ||
    typeof record.total_tokens !== "number"
  ) {
    return null;
  }
  return value as Usage;
}

/**
 * Passthrough provider for OpenAI and any OpenAI-compatible endpoint.
 * Requests and stream bytes are forwarded unmodified, except for injecting
 * `stream_options.include_usage` (see `includeStreamUsage`).
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly type: string;
  private readonly options: ResolvedOptions;

  constructor(id: string, type: string, options: ResolvedOptions) {
    this.id = id;
    this.type = type;
    this.options = options;
  }

  private buildHeaders(includeContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeContentType) headers["content-type"] = "application/json";
    if (this.options.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    if (this.options.organization !== undefined) {
      headers["OpenAI-Organization"] = this.options.organization;
    }
    return { ...headers, ...this.options.headers };
  }

  private networkErrorResult(error: unknown): {
    kind: "error";
    status: number;
    body: OpenAIErrorBody;
  } {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      status: 502,
      body: openAIErrorBody(
        `[provider ${this.id}] upstream request failed: ${message}`,
        "api_error",
        "upstream_error",
      ),
    };
  }

  async chat(
    request: ChatCompletionRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<ChatResult> {
    let body: ChatCompletionRequest = request;
    if (request.stream === true && this.options.includeStreamUsage) {
      // Client-sent stream_options keys (including an explicit
      // include_usage: false) win over the injected default.
      body = { ...request, stream_options: { include_usage: true, ...request.stream_options } };
    }

    let response: Response;
    try {
      response = await ctx.fetch(joinUrl(this.options.baseUrl, "chat/completions"), {
        method: "POST",
        headers: this.buildHeaders(true),
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (error) {
      return this.networkErrorResult(error);
    }

    if (!response.ok) {
      return upstreamErrorToResult(this.id, response.status, await response.text());
    }

    if (request.stream === true) {
      if (response.body === null) {
        return this.networkErrorResult(new Error("upstream returned no response body"));
      }
      return streamResult(response.body);
    }

    try {
      const completion = (await response.json()) as ChatCompletion;
      return { kind: "completion", completion };
    } catch (error) {
      return this.networkErrorResult(error);
    }
  }

  async listModels(ctx: RuntimeContext): Promise<ModelInfo[]> {
    try {
      const response = await ctx.fetch(joinUrl(this.options.baseUrl, "models"), {
        method: "GET",
        headers: this.buildHeaders(false),
      });
      if (!response.ok) return this.staticModels(ctx);
      const parsed: unknown = await response.json();
      const data =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).data
          : undefined;
      if (!Array.isArray(data)) return this.staticModels(ctx);
      const models: ModelInfo[] = [];
      for (const item of data as unknown[]) {
        if (item === null || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string") continue;
        models.push({
          ...record,
          id: record.id,
          object: "model",
          created: typeof record.created === "number" ? record.created : 0,
          owned_by: typeof record.owned_by === "string" ? record.owned_by : this.id,
        });
      }
      return models;
    } catch {
      return this.staticModels(ctx);
    }
  }

  private staticModels(ctx: RuntimeContext): ModelInfo[] {
    return this.options.models.map((id) => ({
      id,
      object: "model",
      created: Math.floor(ctx.now() / 1000),
      owned_by: this.id,
    }));
  }

  async embeddings(
    request: EmbeddingsRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<EmbeddingsResult> {
    let response: Response;
    try {
      response = await ctx.fetch(joinUrl(this.options.baseUrl, "embeddings"), {
        method: "POST",
        headers: this.buildHeaders(true),
        body: JSON.stringify(request),
        signal: options?.signal,
      });
    } catch (error) {
      return this.networkErrorResult(error);
    }
    if (!response.ok) {
      return upstreamErrorToResult(this.id, response.status, await response.text());
    }
    try {
      const parsed = (await response.json()) as EmbeddingsResponse;
      return { kind: "embeddings", response: parsed };
    } catch (error) {
      return this.networkErrorResult(error);
    }
  }
}

/**
 * Relay upstream SSE bytes unmodified while observing the events on the side
 * for the final usage chunk.
 *
 * A manual pump (rather than `observeSSEStream`) guarantees the usage promise
 * resolves exactly once on every exit path — a TransformStream flush never
 * runs when the consumer cancels mid-stream.
 */
function streamResult(upstream: ReadableStream<Uint8Array>): ChatResult {
  const usage = createDeferred<Usage | null>();
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let lastUsage: Usage | null = null;
  // Set on consumer cancel; a pull pending at that moment may still resume,
  // and close()/enqueue() throw once the stream is no longer readable.
  let cancelled = false;

  const noteMessage = (message: SSEMessage): void => {
    if (message.data === "" || message.data === "[DONE]") return;
    try {
      const parsed: unknown = JSON.parse(message.data);
      if (parsed !== null && typeof parsed === "object") {
        const found = asUsage((parsed as Record<string, unknown>).usage);
        if (found !== null) lastUsage = found;
      }
    } catch {
      // Not JSON (keep-alive comment payloads, etc.) — pass through untouched.
    }
  };

  const sse = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        usage.resolve(null);
        controller.error(error);
        return;
      }
      if (result.done) {
        for (const message of parser.feed(decoder.decode())) noteMessage(message);
        const remainder = parser.flush();
        if (remainder !== null) noteMessage(remainder);
        // No-op when the consumer cancelled first: the deferred keeps the
        // value from its first resolve.
        usage.resolve(lastUsage);
        if (!cancelled) controller.close();
        return;
      }
      if (!cancelled) controller.enqueue(result.value);
      for (const message of parser.feed(decoder.decode(result.value, { stream: true }))) {
        noteMessage(message);
      }
    },
    async cancel(reason) {
      cancelled = true;
      usage.resolve(null);
      try {
        await reader.cancel(reason);
      } catch {
        // Upstream cancellation failures are irrelevant once the client is gone.
      }
    },
  });

  return { kind: "stream", sse, usage: usage.promise };
}

/** OpenAI itself: `apiKey` required, `baseUrl` defaults to the public API. */
export const openAIProviderFactory: ProviderFactory = {
  type: "openai",
  create(id, options) {
    return new OpenAICompatibleProvider(
      id,
      "openai",
      parseOptions(openAIOptionsSchema, id, "openai", options),
    );
  },
};

/** Any OpenAI-compatible endpoint: `baseUrl` required, `apiKey` optional. */
export const openAICompatibleProviderFactory: ProviderFactory = {
  type: "openai-compatible",
  create(id, options) {
    return new OpenAICompatibleProvider(
      id,
      "openai-compatible",
      parseOptions(openAICompatibleOptionsSchema, id, "openai-compatible", options),
    );
  },
};
