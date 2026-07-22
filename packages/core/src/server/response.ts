import type {
  ChatChunkDelta,
  ChatCompletion,
  ChatCompletionChunk,
  ChatContentPart,
  ChatMessage,
  ChatToolCall,
  EmbeddingsResponse,
  ModelInfo,
  OpenAIErrorBody,
} from "../openai/types.js";
import { encodeSSEData, type SSEMessage, SSEParser } from "../util/sse.js";

/** Stable metadata used to prevent an upstream from disclosing its own IDs or model routing. */
export interface PublicChatResponseMetadata {
  /** Proxy-generated completion id. */
  id: string;
  /** Proxy response creation time in epoch seconds. */
  created: number;
  /** The model alias supplied by the client. */
  model: string;
}

/** Create metadata for one client-facing chat completion or stream. */
export function createPublicChatResponseMetadata(
  model: string,
  nowMs: number,
): PublicChatResponseMetadata {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(nowMs / 1000),
    model,
  };
}

function copyToolCalls(calls: ChatToolCall[] | undefined): ChatToolCall[] | undefined {
  if (calls === undefined) return undefined;
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: call.function.arguments },
  }));
}

function copyContent(content: ChatMessage["content"]): string | ChatContentPart[] | null {
  if (typeof content === "string" || content === null) return content;
  return content.map((part): ChatContentPart => {
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      return { type: "text", text: (part as { text: string }).text };
    }
    if (part.type === "image_url") {
      const image = (part as { image_url?: { url?: unknown; detail?: unknown } }).image_url;
      if (typeof image?.url === "string") {
        return {
          type: "image_url",
          image_url: {
            url: image.url,
            ...(typeof image.detail === "string" ? { detail: image.detail } : {}),
          },
        };
      }
    }
    return { type: part.type };
  });
}

/** Remove provider-specific fields from a completed assistant message. */
export function redactChatMessage(message: ChatMessage): ChatMessage {
  const toolCalls = copyToolCalls(message.tool_calls);
  return {
    role: message.role,
    content: copyContent(message.content),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
}

function redactDelta(delta: ChatChunkDelta): ChatChunkDelta {
  const toolCalls = delta.tool_calls?.map((call) => ({
    index: call.index,
    ...(call.id === undefined ? {} : { id: call.id }),
    ...(call.type === undefined ? {} : { type: "function" as const }),
    ...(call.function === undefined
      ? {}
      : {
          function: {
            ...(call.function.name === undefined ? {} : { name: call.function.name }),
            ...(call.function.arguments === undefined
              ? {}
              : { arguments: call.function.arguments }),
          },
        }),
  }));
  return {
    ...(delta.role === undefined ? {} : { role: delta.role }),
    ...(delta.content === undefined ? {} : { content: delta.content }),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
}

/**
 * Return the minimal OpenAI-compatible completion surface. Usage remains in
 * the internal provider result for token budgeting but is never sent to a
 * client. Upstream identifiers and routed model names are replaced as well.
 */
export function redactChatCompletion(
  completion: ChatCompletion,
  metadata: PublicChatResponseMetadata,
): ChatCompletion {
  return {
    id: metadata.id,
    object: "chat.completion",
    created: metadata.created,
    model: metadata.model,
    choices: completion.choices.map((choice) => ({
      index: choice.index,
      message: redactChatMessage(choice.message),
      finish_reason: choice.finish_reason,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function asChunk(value: unknown): ChatCompletionChunk | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const choices: ChatCompletionChunk["choices"] = [];
  for (const choice of value.choices) {
    if (!isRecord(choice) || typeof choice.index !== "number" || !isRecord(choice.delta)) {
      continue;
    }
    const delta: ChatChunkDelta = {};
    if (typeof choice.delta.role === "string") delta.role = choice.delta.role;
    if (typeof choice.delta.content === "string" || choice.delta.content === null) {
      delta.content = choice.delta.content;
    }
    if (Array.isArray(choice.delta.tool_calls)) {
      const toolCalls: NonNullable<ChatChunkDelta["tool_calls"]> = [];
      for (const call of choice.delta.tool_calls) {
        if (!isRecord(call) || typeof call.index !== "number") continue;
        const toolCall: NonNullable<ChatChunkDelta["tool_calls"]>[number] = { index: call.index };
        if (typeof call.id === "string") toolCall.id = call.id;
        if (call.type === "function") toolCall.type = "function";
        if (isRecord(call.function)) {
          const fn: { name?: string; arguments?: string } = {};
          if (typeof call.function.name === "string") fn.name = call.function.name;
          if (typeof call.function.arguments === "string") fn.arguments = call.function.arguments;
          toolCall.function = fn;
        }
        toolCalls.push(toolCall);
      }
      delta.tool_calls = toolCalls;
    }
    choices.push({
      index: choice.index,
      delta,
      finish_reason:
        typeof choice.finish_reason === "string" || choice.finish_reason === null
          ? choice.finish_reason
          : null,
    });
  }
  return choices.length === 0
    ? null
    : {
        id: "",
        object: "chat.completion.chunk",
        created: 0,
        model: "",
        choices,
      };
}

/** Remove usage and provider-specific fields from one streamed completion chunk. */
export function redactChatCompletionChunk(
  chunk: ChatCompletionChunk,
  metadata: PublicChatResponseMetadata,
): ChatCompletionChunk {
  return {
    id: metadata.id,
    object: "chat.completion.chunk",
    created: metadata.created,
    model: metadata.model,
    choices: chunk.choices.map((choice) => ({
      index: choice.index,
      delta: redactDelta(choice.delta),
      finish_reason: choice.finish_reason,
    })),
  };
}

function redactSseMessage(
  message: SSEMessage,
  metadata: PublicChatResponseMetadata,
): Uint8Array | null {
  if (message.data === "[DONE]") return encodeSSEData("[DONE]");
  try {
    const chunk = asChunk(JSON.parse(message.data) as unknown);
    return chunk === null
      ? null
      : encodeSSEData(JSON.stringify(redactChatCompletionChunk(chunk, metadata)));
  } catch {
    return null;
  }
}

/**
 * Re-encode an upstream completion stream with only public OpenAI chunk
 * fields. The source stream is still consumed directly, so its usage promise
 * can independently settle for rate-limit accounting.
 */
export function redactChatCompletionStream(
  stream: ReadableStream<Uint8Array>,
  metadata: PublicChatResponseMetadata,
): ReadableStream<Uint8Array> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const emit = (message: SSEMessage, controller: TransformStreamDefaultController<Uint8Array>) => {
    const redacted = redactSseMessage(message, metadata);
    if (redacted !== null) controller.enqueue(redacted);
  };
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const message of parser.feed(decoder.decode(chunk, { stream: true }))) {
          emit(message, controller);
        }
      },
      flush(controller) {
        for (const message of parser.feed(decoder.decode())) emit(message, controller);
        const remainder = parser.flush();
        if (remainder !== null) emit(remainder, controller);
      },
    }),
  );
}

/** Strip usage, upstream routing and provider-specific fields from embeddings responses. */
export function redactEmbeddingsResponse(
  response: EmbeddingsResponse,
  requestedModel: string,
): EmbeddingsResponse {
  return {
    object: "list",
    data: response.data.map((embedding) => ({
      object: "embedding",
      index: embedding.index,
      embedding: embedding.embedding,
    })),
    model: requestedModel,
  };
}

/** Expose model ids without provider ownership or provider-specific metadata. */
export function redactModelInfo(model: ModelInfo): ModelInfo {
  return {
    id: model.id,
    object: "model",
    created: model.created,
    owned_by: "omni-model",
  };
}

/** Replace upstream error text with a stable client-safe error body. */
export function redactProviderError(body: OpenAIErrorBody): OpenAIErrorBody {
  return {
    error: {
      message: "upstream model request failed",
      type: body.error.type,
      param: null,
      code: "upstream_error",
    },
  };
}
