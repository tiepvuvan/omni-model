import { z } from "zod";
import { ConfigError } from "../errors.js";
import type {
  ChatChunkDelta,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatContentPart,
  ChatMessage,
  ChatToolCall,
  Usage,
} from "../openai/types.js";
import type { RuntimeContext } from "../types.js";
import { readSSEStream, sseStreamFromChunks } from "../util/sse.js";
import { createDeferred, joinUrl, openAIErrorBody, upstreamErrorToResult } from "./shared.js";
import type { ChatProvider, ChatResult, ProviderCallOptions, ProviderFactory } from "./types.js";

const anthropicOptionsSchema = z.strictObject({
  // The raw provider block still carries the discriminating `type` key.
  type: z.literal("anthropic").optional(),
  apiKey: z.string().min(1, "apiKey is required"),
  baseUrl: z.string().min(1).default("https://api.anthropic.com"),
  /** Sent as the `anthropic-version` header. */
  version: z.string().min(1).default("2023-06-01"),
  /** Anthropic requires max_tokens; used when the client sends neither field. */
  maxTokensDefault: z.number().int().positive().default(4096),
});

type AnthropicOptions = z.output<typeof anthropicOptionsSchema>;

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice = { type: "auto" } | { type: "any" } | { type: "tool"; name: string };

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id: string };
  stream?: boolean;
}

/** Shape of a non-streaming /v1/messages response (fields we consume). */
interface AnthropicResponseBody {
  id?: string;
  content?: unknown[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Union of the streaming event fields we consume; unknown types are skipped. */
interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { id?: string; usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/s;

function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      // end_turn, stop_sequence and anything unknown all read as a normal stop.
      return "stop";
  }
}

/** Concatenate the text parts of an OpenAI message content value. */
function textFromContent(content: string | ChatContentPart[] | null): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if (part.type === "text" && typeof text === "string") texts.push(text);
  }
  return texts.join("\n\n");
}

function contentPartsToBlocks(parts: ChatContentPart[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") blocks.push({ type: "text", text });
      continue;
    }
    if (part.type === "image_url") {
      const image = (part as { image_url?: { url?: unknown } }).image_url;
      const url = image?.url;
      if (typeof url !== "string") continue;
      const dataUrl = DATA_URL_PATTERN.exec(url);
      if (dataUrl !== null) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: dataUrl[1] as string,
            data: dataUrl[2] as string,
          },
        });
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
    // Unknown part types have no Anthropic equivalent; drop them.
  }
  return blocks;
}

function toolCallToBlock(call: ChatToolCall): AnthropicToolUseBlock {
  let input: unknown = {};
  try {
    input = JSON.parse(call.function.arguments) as unknown;
  } catch {
    // Malformed arguments from the client; send an empty input rather than fail.
  }
  return { type: "tool_use", id: call.id, name: call.function.name, input };
}

/** Append blocks, merging into the previous message when the role repeats
 * (Anthropic rejects consecutive same-role messages). */
function pushMerged(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  blocks: AnthropicContentBlock[],
): void {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last !== undefined && last.role === role) {
    last.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function translateMessages(openaiMessages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of openaiMessages) {
    switch (message.role) {
      case "system":
      case "developer": {
        const text = textFromContent(message.content);
        if (text.length > 0) systemParts.push(text);
        break;
      }
      case "tool": {
        pushMerged(messages, "user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content: textFromContent(message.content),
          },
        ]);
        break;
      }
      case "assistant":
      case "user": {
        // `role` is a widened string union; pin it back down for pushMerged.
        const role = message.role === "assistant" ? "assistant" : "user";
        const blocks: AnthropicContentBlock[] =
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content === null
              ? []
              : contentPartsToBlocks(message.content);
        if (role === "assistant" && message.tool_calls !== undefined) {
          blocks.push(...message.tool_calls.map(toolCallToBlock));
        }
        pushMerged(messages, role, blocks);
        break;
      }
      default:
        // Unknown roles have no Anthropic mapping; drop them.
        break;
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages };
}

function translateTools(request: ChatCompletionRequest): {
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
} {
  // Anthropic has no "none" choice: drop the tools entirely instead.
  if (request.tools === undefined || request.tool_choice === "none") return {};

  const tools: AnthropicTool[] = request.tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined && { description: tool.function.description }),
    input_schema: tool.function.parameters ?? { type: "object" },
  }));

  const choice = request.tool_choice;
  let tool_choice: AnthropicToolChoice | undefined;
  if (choice === "auto") {
    tool_choice = { type: "auto" };
  } else if (choice === "required") {
    tool_choice = { type: "any" };
  } else if (choice !== null && typeof choice === "object") {
    const fn = (choice as { function?: { name?: unknown } }).function;
    if ((choice as { type?: unknown }).type === "function" && typeof fn?.name === "string") {
      tool_choice = { type: "tool", name: fn.name };
    }
  }

  return { tools, ...(tool_choice !== undefined && { tool_choice }) };
}

function toAnthropicRequest(
  request: ChatCompletionRequest,
  maxTokensDefault: number,
): AnthropicRequestBody {
  const { system, messages } = translateMessages(request.messages);
  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? maxTokensDefault,
    messages,
    ...translateTools(request),
  };
  if (system !== undefined) body.system = system;
  if (request.temperature !== undefined) {
    // OpenAI allows 0..2, Anthropic only 0..1.
    body.temperature = Math.min(1, Math.max(0, request.temperature));
  }
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop !== undefined) {
    body.stop_sequences = typeof request.stop === "string" ? [request.stop] : request.stop;
  }
  if (request.user !== undefined) body.metadata = { user_id: request.user };
  if (request.stream === true) body.stream = true;
  return body;
}

function toChatCompletion(
  body: AnthropicResponseBody,
  model: string,
  nowMs: number,
): ChatCompletion {
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const rawBlock of body.content ?? []) {
    if (rawBlock === null || typeof rawBlock !== "object") continue;
    const block = rawBlock as {
      type?: string;
      text?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: ChatMessage = {
    role: "assistant",
    content: texts.length > 0 ? texts.join("") : null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  };

  const inputTokens = body.usage?.input_tokens ?? 0;
  const outputTokens = body.usage?.output_tokens ?? 0;

  return {
    id: body.id ?? "chatcmpl-unknown",
    object: "chat.completion",
    created: Math.floor(nowMs / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(body.stop_reason) }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

/**
 * Translation provider for the Anthropic Messages API: accepts OpenAI
 * chat-completions requests and converts both directions, streaming included.
 */
class AnthropicProvider implements ChatProvider {
  readonly type = "anthropic";

  constructor(
    readonly id: string,
    private readonly options: AnthropicOptions,
  ) {}

  async chat(
    request: ChatCompletionRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<ChatResult> {
    if (request.n !== undefined && request.n > 1) {
      return {
        kind: "error",
        status: 400,
        body: openAIErrorBody("anthropic provider does not support n>1", "invalid_request_error"),
      };
    }

    const body = toAnthropicRequest(request, this.options.maxTokensDefault);
    let response: Response;
    try {
      response = await ctx.fetch(joinUrl(this.options.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "anthropic-version": this.options.version,
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (error) {
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

    if (!response.ok) {
      return upstreamErrorToResult(this.id, response.status, await response.text());
    }

    if (request.stream === true) {
      if (response.body === null) {
        return {
          kind: "error",
          status: 502,
          body: openAIErrorBody(
            `[provider ${this.id}] upstream returned no body for a streaming request`,
            "api_error",
            "upstream_error",
          ),
        };
      }
      return this.streamResult(response.body, request, ctx);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text()) as unknown;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object") {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream returned an unparsable response`,
          "api_error",
          "upstream_error",
        ),
      };
    }
    return {
      kind: "completion",
      completion: toChatCompletion(parsed as AnthropicResponseBody, request.model, ctx.now()),
    };
  }

  private streamResult(
    upstream: ReadableStream<Uint8Array>,
    request: ChatCompletionRequest,
    ctx: RuntimeContext,
  ): ChatResult {
    const usage = createDeferred<Usage | null>();
    const includeUsage = request.stream_options?.include_usage === true;
    const providerId = this.id;
    const created = Math.floor(ctx.now() / 1000);
    const model = request.model;

    async function* translate(): AsyncGenerator<ChatCompletionChunk> {
      let chunkId = "chatcmpl-unknown";
      let inputTokens = 0;
      let outputTokens = 0;
      let sawUsage = false;
      // Anthropic content-block index -> sequential OpenAI tool_calls index.
      const toolIndexByBlock = new Map<number, number>();
      let nextToolIndex = 0;

      const chunk = (
        delta: ChatChunkDelta,
        finishReason: string | null = null,
      ): ChatCompletionChunk => ({
        id: chunkId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });

      try {
        for await (const message of readSSEStream(upstream)) {
          if (message.data === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(message.data) as unknown;
          } catch {
            continue;
          }
          if (parsed === null || typeof parsed !== "object") continue;
          const event = parsed as AnthropicStreamEvent;

          switch (event.type) {
            case "message_start": {
              if (typeof event.message?.id === "string") {
                chunkId = `chatcmpl-${event.message.id}`;
              }
              if (typeof event.message?.usage?.input_tokens === "number") {
                inputTokens = event.message.usage.input_tokens;
                sawUsage = true;
              }
              yield chunk({ role: "assistant", content: "" });
              break;
            }
            case "content_block_start": {
              if (event.content_block?.type !== "tool_use") break;
              const toolIndex = nextToolIndex++;
              if (typeof event.index === "number") {
                toolIndexByBlock.set(event.index, toolIndex);
              }
              yield chunk({
                tool_calls: [
                  {
                    index: toolIndex,
                    id: typeof event.content_block.id === "string" ? event.content_block.id : "",
                    type: "function",
                    function: {
                      name:
                        typeof event.content_block.name === "string"
                          ? event.content_block.name
                          : "",
                      arguments: "",
                    },
                  },
                ],
              });
              break;
            }
            case "content_block_delta": {
              if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
                yield chunk({ content: event.delta.text });
              } else if (
                event.delta?.type === "input_json_delta" &&
                typeof event.delta.partial_json === "string"
              ) {
                const toolIndex =
                  typeof event.index === "number" ? toolIndexByBlock.get(event.index) : undefined;
                if (toolIndex === undefined) break;
                yield chunk({
                  tool_calls: [
                    { index: toolIndex, function: { arguments: event.delta.partial_json } },
                  ],
                });
              }
              break;
            }
            case "message_delta": {
              if (typeof event.usage?.output_tokens === "number") {
                outputTokens = event.usage.output_tokens;
                sawUsage = true;
              }
              const stopReason = event.delta?.stop_reason;
              if (stopReason !== undefined && stopReason !== null) {
                yield chunk({}, mapStopReason(stopReason));
              }
              break;
            }
            case "message_stop": {
              if (includeUsage) {
                yield {
                  id: chunkId,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [],
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  },
                };
              }
              return;
            }
            case "error": {
              // The 2xx status line and SSE headers are already on the wire, so
              // we can no longer surface this as a `kind: "error"` result; the
              // best we can do is close the stream cleanly for the client.
              ctx.log.warn(`[provider ${providerId}] anthropic stream error`, {
                error: event.error,
              });
              yield chunk({}, "stop");
              return;
            }
            default:
              // ping, content_block_stop, future event types: ignore.
              break;
          }
        }
      } finally {
        // Resolve even on throw or consumer cancel; token budgets await this.
        usage.resolve(
          sawUsage
            ? {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
              }
            : null,
        );
        // Best-effort release of the upstream connection on early exit.
        upstream.cancel().catch(() => {});
      }
    }

    return { kind: "stream", sse: sseStreamFromChunks(translate()), usage: usage.promise };
  }
}

/** Provider factory for `type: anthropic` blocks. */
export const anthropicProviderFactory: ProviderFactory = {
  type: "anthropic",
  create(id, options) {
    const parsed = anthropicOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(
        `invalid options for anthropic provider "${id}":\n${z.prettifyError(parsed.error)}`,
      );
    }
    return new AnthropicProvider(id, parsed.data);
  },
};
