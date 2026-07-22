import {
  buildRequestFacts,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatResult,
  type ChatToolCall,
  createPublicChatResponseMetadata,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type EmbeddingsResult,
  embeddingsUsage,
  executeChat,
  executeEmbeddings,
  type OmniConfig,
  type RequestFacts,
  readSSEStream,
  redactChatCompletion,
  redactChatCompletionChunk,
  redactEmbeddingsResponse,
  redactProviderError,
  type Usage,
} from "@omni-model/core";
import { type BuildOmniContextDeps, buildOmniContext, type OmniContext } from "./context.js";
import {
  CallableError,
  type CallableRequestLike,
  type CallableResponseLike,
  callableErrorFromStatus,
  identityFromCallable,
  toCallableError,
} from "./identity.js";

/** Whether a callable requires a verified Firebase Auth token and/or App Check token. */
export interface CallableOptions {
  requireAuth: boolean;
  requireAppCheck: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Record token usage without ever throwing. `limiter.recordUsage` is
 * contractually safe, but we still guard so a bookkeeping failure can never
 * fail the client's request after a successful completion.
 */
async function recordUsage(ctx: OmniContext, facts: RequestFacts, usage: Usage): Promise<void> {
  try {
    await ctx.deps.limiter.recordUsage(facts, usage);
  } catch (error) {
    ctx.deps.log.warn("failed to record usage", { error: errorMessage(error) });
  }
}

/** A tool call assembled incrementally from streamed deltas, keyed by index. */
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Folds `chat.completion.chunk` deltas into a single {@link ChatCompletion}, so
 * a streaming upstream still yields the aggregated result the callable client
 * awaits as its return value.
 */
class ChatCompletionAggregator {
  private id = "";
  private created = 0;
  private model = "";
  private role = "assistant";
  private content = "";
  private sawContent = false;
  private finishReason: string | null = null;
  private readonly toolCalls = new Map<number, PartialToolCall>();

  add(chunk: ChatCompletionChunk): void {
    if (typeof chunk.id === "string" && chunk.id !== "") this.id = chunk.id;
    if (typeof chunk.created === "number") this.created = chunk.created;
    if (typeof chunk.model === "string" && chunk.model !== "") this.model = chunk.model;

    // Only the first choice is aggregated; the callable surface returns a single
    // assistant message (n > 1 is not part of the callable contract).
    const choice = chunk.choices.find((c) => c.index === 0) ?? chunk.choices[0];
    if (choice === undefined) return;
    const delta = choice.delta;
    if (typeof delta.role === "string" && delta.role !== "") this.role = delta.role;
    if (typeof delta.content === "string") {
      this.content += delta.content;
      this.sawContent = true;
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.finishReason = choice.finish_reason;
    }
    for (const call of delta.tool_calls ?? []) {
      const existing = this.toolCalls.get(call.index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string" && call.id !== "") existing.id = call.id;
      if (typeof call.function?.name === "string") existing.name = call.function.name;
      if (typeof call.function?.arguments === "string") {
        existing.arguments += call.function.arguments;
      }
      this.toolCalls.set(call.index, existing);
    }
  }

  build(usage: Usage | null): ChatCompletion {
    const toolCalls: ChatToolCall[] = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));

    const completion: ChatCompletion = {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: this.role,
            content: this.sawContent ? this.content : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
    };
    if (usage !== null) completion.usage = usage;
    return completion;
  }
}

/**
 * Build the chat callable handler. It authenticates the request, validates the
 * payload, runs the core pipeline, and returns a {@link ChatCompletion}. When
 * the client requested streaming, each upstream chunk is forwarded via
 * `response.sendChunk` and also folded into the returned aggregate. Token usage
 * is recorded (best-effort) before returning.
 */
export function createChatCallable(
  ctx: OmniContext,
  options: CallableOptions,
): (request: CallableRequestLike, response?: CallableResponseLike) => Promise<ChatCompletion> {
  return async (request, response) => {
    const identity = identityFromCallable(request, options);
    const data = request.data;
    if (!isRecord(data)) {
      throw new CallableError("invalid-argument", "request data must be an object");
    }
    if (typeof data.model !== "string" || data.model.length === 0) {
      throw new CallableError("invalid-argument", 'a non-empty "model" is required');
    }
    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      throw new CallableError("invalid-argument", '"messages" must be a non-empty array');
    }

    const streamMode = request.acceptsStreaming === true;
    const chatRequest: ChatCompletionRequest = {
      ...(data as ChatCompletionRequest),
      stream: streamMode,
    };
    const facts = buildRequestFacts({
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers(),
      ip: null,
      body: chatRequest,
      identity,
      now: ctx.runtime.now(),
    });

    let result: ChatResult;
    try {
      result = await executeChat(ctx.deps, facts, chatRequest, ctx.runtime);
    } catch (error) {
      throw toCallableError(error);
    }
    const metadata = createPublicChatResponseMetadata(chatRequest.model, ctx.runtime.now());

    switch (result.kind) {
      case "completion": {
        const usage = result.completion.usage;
        if (usage !== undefined) await recordUsage(ctx, facts, usage);
        return redactChatCompletion(result.completion, metadata);
      }
      case "stream": {
        const aggregator = new ChatCompletionAggregator();
        try {
          for await (const message of readSSEStream(result.sse)) {
            if (message.data === "[DONE]") continue;
            let chunk: ChatCompletionChunk;
            try {
              chunk = JSON.parse(message.data) as ChatCompletionChunk;
            } catch {
              // A non-JSON data line is not a completion chunk; skip it.
              continue;
            }
            const publicChunk = redactChatCompletionChunk(chunk, metadata);
            if (streamMode && response !== undefined) response.sendChunk(publicChunk);
            aggregator.add(publicChunk);
          }
        } catch (error) {
          // A mid-stream upstream failure surfaces here; map it for the client.
          // Usage is still settled and recorded in the finally below.
          throw toCallableError(error);
        } finally {
          // `result.usage` resolves (never rejects) on every stream exit —
          // normal end, upstream error, or client cancel — so token budgets
          // are charged even when the stream breaks partway.
          const usage = await result.usage;
          if (usage !== null) await recordUsage(ctx, facts, usage);
        }
        return redactChatCompletion(aggregator.build(await result.usage), metadata);
      }
      case "error":
        throw callableErrorFromStatus(
          result.status,
          redactProviderError(result.body).error.message,
        );
    }
  };
}

/**
 * Build the embeddings callable handler. It authenticates the request,
 * validates the payload, runs the core pipeline, records usage (best-effort),
 * and returns the {@link EmbeddingsResponse}. Embeddings never stream, so the
 * optional response argument is unused.
 */
export function createEmbeddingsCallable(
  ctx: OmniContext,
  options: CallableOptions,
): (request: CallableRequestLike, response?: CallableResponseLike) => Promise<EmbeddingsResponse> {
  return async (request) => {
    const identity = identityFromCallable(request, options);
    const data = request.data;
    if (!isRecord(data)) {
      throw new CallableError("invalid-argument", "request data must be an object");
    }
    if (typeof data.model !== "string" || data.model.length === 0) {
      throw new CallableError("invalid-argument", 'a non-empty "model" is required');
    }
    if (data.input === undefined || data.input === null) {
      throw new CallableError("invalid-argument", '"input" is required');
    }

    const embeddingsRequest = data as EmbeddingsRequest;
    const facts = buildRequestFacts({
      method: "POST",
      path: "/v1/embeddings",
      headers: new Headers(),
      ip: null,
      body: { model: embeddingsRequest.model },
      identity,
      now: ctx.runtime.now(),
    });

    let result: EmbeddingsResult;
    try {
      result = await executeEmbeddings(ctx.deps, facts, embeddingsRequest, ctx.runtime);
    } catch (error) {
      throw toCallableError(error);
    }

    if (result.kind === "error") {
      throw callableErrorFromStatus(result.status, redactProviderError(result.body).error.message);
    }
    const usage = result.response.usage;
    if (usage !== undefined) await recordUsage(ctx, facts, embeddingsUsage(usage));
    return redactEmbeddingsResponse(result.response, embeddingsRequest.model);
  };
}

/** Input for {@link createOmniCallables}. */
export interface CreateOmniCallablesInput extends BuildOmniContextDeps {
  config: OmniConfig;
  /** Require a valid Firebase Auth token. Defaults to `true`. */
  requireAuth?: boolean;
  /** Require a valid App Check token. Defaults to `true`. */
  requireAppCheck?: boolean;
}

/**
 * One-call setup: build the {@link OmniContext} from config + Firestore, then
 * wire the chat and embeddings callable handlers. Auth and App Check are
 * required by default; opt out per callable via `requireAuth` / `requireAppCheck`.
 */
export async function createOmniCallables(input: CreateOmniCallablesInput): Promise<{
  chat: (request: CallableRequestLike, response?: CallableResponseLike) => Promise<ChatCompletion>;
  embeddings: (
    request: CallableRequestLike,
    response?: CallableResponseLike,
  ) => Promise<EmbeddingsResponse>;
  context: OmniContext;
}> {
  const options: CallableOptions = {
    requireAuth: input.requireAuth ?? true,
    requireAppCheck: input.requireAppCheck ?? true,
  };
  const context = await buildOmniContext(input.config, {
    firestore: input.firestore,
    fetch: input.fetch,
    now: input.now,
    waitUntil: input.waitUntil,
    logger: input.logger,
    registry: input.registry,
  });
  return {
    chat: createChatCallable(context, options),
    embeddings: createEmbeddingsCallable(context, options),
    context,
  };
}
