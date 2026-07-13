import { z } from "zod";
import { ConfigError } from "../errors.js";
import type {
  ChatChunkDelta,
  ChatChunkToolCall,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  EmbeddingsRequest,
  ModelInfo,
  Usage,
} from "../openai/types.js";
import type { RuntimeContext } from "../types.js";
import { readSSEStream, sseStreamFromChunks } from "../util/sse.js";
import { createDeferred, joinUrl, openAIErrorBody, upstreamErrorToResult } from "./shared.js";
import type {
  ChatProvider,
  ChatResult,
  EmbeddingsResult,
  ProviderCallOptions,
  ProviderFactory,
} from "./types.js";

const googleOptionsSchema = z.strictObject({
  apiKey: z.string().min(1, "apiKey must not be empty"),
  baseUrl: z.string().min(1).default("https://generativelanguage.googleapis.com/v1beta"),
});

type GoogleOptions = z.output<typeof googleOptionsSchema>;

// ---------------------------------------------------------------------------
// Gemini wire types (request side is what we build; response side is what we
// trust the upstream to send — every field optional, guarded at use sites).
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface GeminiToolConfig {
  functionCallingConfig: { mode: "AUTO" | "NONE" | "ANY"; allowedFunctionNames?: string[] };
}

interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  toolConfig?: GeminiToolConfig;
  generationConfig?: Record<string, unknown>;
}

interface GeminiResponsePart {
  text?: string;
  functionCall?: { name?: string; args?: unknown };
}

interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageMetadata;
}

// ---------------------------------------------------------------------------
// Request translation (OpenAI -> Gemini)
// ---------------------------------------------------------------------------

function stripModelPrefix(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(url);
  if (match === null) return null;
  return { mimeType: match[1] ?? "application/octet-stream", data: match[2] ?? "" };
}

/** Flatten message content to plain text (for system turns and tool results). */
function contentToText(content: ChatMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("\n");
}

function contentToParts(content: ChatMessage["content"]): GeminiPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }
  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      const image = (part as { image_url?: { url?: unknown } }).image_url;
      const url = typeof image?.url === "string" ? image.url : undefined;
      if (url === undefined) continue;
      const inline = parseDataUrl(url);
      parts.push(inline !== null ? { inlineData: inline } : { fileData: { fileUri: url } });
    }
    // Unknown part types are dropped: Gemini rejects unrecognized part shapes.
  }
  return parts;
}

/** Parse a tool-call arguments string; Gemini requires an args object. */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed arguments -> empty object
  }
  return {};
}

/** Tool results: structured JSON passes through, anything else stays a string. */
function parseFunctionResult(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // not JSON -> keep the raw string
  }
  return raw;
}

function translateMessages(messages: ChatMessage[]): {
  systemInstruction: { parts: Array<{ text: string }> } | undefined;
  contents: GeminiContent[];
} {
  const systemTexts: string[] = [];
  // Gemini identifies function responses by name, OpenAI by tool_call_id.
  const toolCallNames = new Map<string, string>();
  const contents: GeminiContent[] = [];

  // Gemini requires alternating user/model turns, so consecutive same-role
  // messages are merged into a single turn.
  const push = (role: "user" | "model", parts: GeminiPart[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = contentToText(message.content);
      if (text.length > 0) systemTexts.push(text);
    } else if (message.role === "assistant") {
      const parts = contentToParts(message.content);
      for (const call of message.tool_calls ?? []) {
        toolCallNames.set(call.id, call.function.name);
        parts.push({
          functionCall: { name: call.function.name, args: parseToolArgs(call.function.arguments) },
        });
      }
      push("model", parts);
    } else if (message.role === "tool") {
      // Gemini expects function responses inside a user turn.
      const name =
        (message.tool_call_id === undefined
          ? undefined
          : toolCallNames.get(message.tool_call_id)) ?? "unknown";
      const result = parseFunctionResult(contentToText(message.content));
      push("user", [{ functionResponse: { name, response: { result } } }]);
    } else {
      // "user" plus any unrecognized role.
      push("user", contentToParts(message.content));
    }
  }

  return {
    systemInstruction:
      systemTexts.length > 0 ? { parts: [{ text: systemTexts.join("\n\n") }] } : undefined,
    contents,
  };
}

/**
 * Recursively strip JSON-schema keys Gemini rejects ("$schema",
 * "additionalProperties") and rewrite nullable type unions like
 * `type: ["string", "null"]` to `type: "string", nullable: true`.
 */
function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (key === "type" && Array.isArray(entry)) {
      const types = entry.filter((item): item is string => typeof item === "string");
      const nonNull = types.filter((item) => item !== "null");
      result.type = nonNull[0] ?? "string";
      if (types.includes("null")) result.nullable = true;
      continue;
    }
    result[key] = sanitizeSchema(entry);
  }
  return result;
}

function translateTools(
  tools: ChatTool[] | undefined,
): Array<{ functionDeclarations: GeminiFunctionDeclaration[] }> | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const declaration: GeminiFunctionDeclaration = { name: tool.function.name };
    if (tool.function.description !== undefined) {
      declaration.description = tool.function.description;
    }
    if (tool.function.parameters !== undefined) {
      declaration.parameters = sanitizeSchema(tool.function.parameters) as Record<string, unknown>;
    }
    declarations.push(declaration);
  }
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function translateToolChoice(toolChoice: unknown): GeminiToolConfig | undefined {
  if (toolChoice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (toolChoice !== null && typeof toolChoice === "object") {
    const fn = (toolChoice as Record<string, unknown>).function;
    if (fn !== null && typeof fn === "object") {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === "string") {
        return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } };
      }
    }
  }
  return undefined;
}

function translateGenerationConfig(
  request: ChatCompletionRequest,
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  const maxOutputTokens = request.max_completion_tokens ?? request.max_tokens;
  if (maxOutputTokens !== undefined) config.maxOutputTokens = maxOutputTokens;
  if (request.temperature !== undefined) config.temperature = request.temperature;
  if (request.top_p !== undefined) config.topP = request.top_p;
  if (request.stop !== undefined) {
    config.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  const format = request.response_format;
  if (format !== undefined && (format.type === "json_object" || format.type === "json_schema")) {
    config.responseMimeType = "application/json";
    if (format.type === "json_schema") {
      const jsonSchema = (format as { json_schema?: { schema?: unknown } }).json_schema;
      if (jsonSchema?.schema !== undefined) {
        config.responseSchema = sanitizeSchema(jsonSchema.schema);
      }
    }
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function translateRequest(request: ChatCompletionRequest): GeminiRequestBody {
  const { systemInstruction, contents } = translateMessages(request.messages);
  const body: GeminiRequestBody = { contents };
  if (systemInstruction !== undefined) body.systemInstruction = systemInstruction;
  const tools = translateTools(request.tools);
  if (tools !== undefined) body.tools = tools;
  const toolConfig = translateToolChoice(request.tool_choice);
  if (toolConfig !== undefined) body.toolConfig = toolConfig;
  const generationConfig = translateGenerationConfig(request);
  if (generationConfig !== undefined) body.generationConfig = generationConfig;
  return body;
}

// ---------------------------------------------------------------------------
// Response translation (Gemini -> OpenAI)
// ---------------------------------------------------------------------------

const FINISH_REASON_MAP: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  MALFORMED_FUNCTION_CALL: "stop",
};

function mapFinishReason(reason: string | undefined, sawFunctionCall: boolean): string {
  const mapped = (reason === undefined ? undefined : FINISH_REASON_MAP[reason]) ?? "stop";
  // A model that emitted a function call expects the client to run tools.
  return sawFunctionCall && mapped === "stop" ? "tool_calls" : mapped;
}

function mapUsage(meta: GeminiUsageMetadata | undefined): Usage {
  const promptTokens = meta?.promptTokenCount ?? 0;
  const completionTokens = meta?.candidatesTokenCount ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: meta?.totalTokenCount ?? promptTokens + completionTokens,
  };
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class GoogleProvider implements ChatProvider {
  readonly id: string;
  readonly type = "google";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(id: string, options: GoogleOptions) {
    this.id = id;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  private headers(): Record<string, string> {
    // Header auth (not the ?key= query param) keeps the API key out of URLs
    // and therefore out of request logs.
    return { "content-type": "application/json", "x-goog-api-key": this.apiKey };
  }

  async chat(
    request: ChatCompletionRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<ChatResult> {
    if ((request.n ?? 1) > 1) {
      return {
        kind: "error",
        status: 400,
        body: openAIErrorBody("google provider does not support n>1", "invalid_request_error"),
      };
    }
    const model = stripModelPrefix(request.model);
    const streaming = request.stream === true;
    const url = streaming
      ? `${joinUrl(this.baseUrl, `models/${model}:streamGenerateContent`)}?alt=sse`
      : joinUrl(this.baseUrl, `models/${model}:generateContent`);

    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(translateRequest(request)),
        signal: options?.signal,
      });
    } catch (cause) {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream request failed: ${describeError(cause)}`,
          "api_error",
          "upstream_error",
        ),
      };
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return upstreamErrorToResult(this.id, response.status, bodyText);
    }

    if (streaming) return this.streamResult(response, request, model, ctx);

    let data: GeminiGenerateContentResponse;
    try {
      data = (await response.json()) as GeminiGenerateContentResponse;
    } catch {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream returned invalid JSON`,
          "api_error",
          "upstream_error",
        ),
      };
    }
    return this.completionResult(data, model, ctx);
  }

  private completionResult(
    data: GeminiGenerateContentResponse,
    model: string,
    ctx: RuntimeContext,
  ): ChatResult {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(ctx.now() / 1000);
    const usage = mapUsage(data.usageMetadata);
    const candidate = data.candidates?.[0];

    if (candidate === undefined) {
      // Prompt-level block (e.g. safety): not an error — an empty completion
      // with finish_reason content_filter, matching OpenAI semantics.
      const blocked = data.promptFeedback?.blockReason !== undefined;
      return {
        kind: "completion",
        completion: {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "" },
              finish_reason: blocked ? "content_filter" : "stop",
            },
          ],
          usage,
        },
      };
    }

    let text = "";
    const toolCalls: ChatToolCall[] = [];
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string") text += part.text;
      if (part.functionCall !== undefined) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: part.functionCall.name ?? "",
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
    }

    const message: ChatMessage = {
      role: "assistant",
      content: text.length === 0 && toolCalls.length > 0 ? null : text,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
      kind: "completion",
      completion: {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: mapFinishReason(candidate.finishReason, toolCalls.length > 0),
          },
        ],
        usage,
      },
    };
  }

  private streamResult(
    response: Response,
    request: ChatCompletionRequest,
    model: string,
    ctx: RuntimeContext,
  ): ChatResult {
    if (response.body === null) {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream returned no body`,
          "api_error",
          "upstream_error",
        ),
      };
    }
    // Re-bind after the null check: the hoisted generator below would
    // otherwise still see the nullable type.
    const body: ReadableStream<Uint8Array> = response.body;

    const usage = createDeferred<Usage | null>();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(ctx.now() / 1000);
    const includeUsage = request.stream_options?.include_usage === true;

    async function* chunks(): AsyncGenerator<ChatCompletionChunk> {
      let sentRole = false;
      let toolCallIndex = 0;
      let sawFunctionCall = false;
      let latestUsage: GeminiUsageMetadata | undefined;
      const makeChunk = (delta: ChatChunkDelta, finish: string | null): ChatCompletionChunk => ({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        for await (const message of readSSEStream(body)) {
          if (message.data === "" || message.data === "[DONE]") continue;
          let data: GeminiGenerateContentResponse;
          try {
            data = JSON.parse(message.data) as GeminiGenerateContentResponse;
          } catch {
            continue; // tolerate malformed events rather than killing the stream
          }
          if (data.usageMetadata !== undefined) latestUsage = data.usageMetadata;

          const candidate = data.candidates?.[0];
          if (candidate === undefined) {
            if (data.promptFeedback?.blockReason !== undefined) {
              const delta: ChatChunkDelta = sentRole ? {} : { role: "assistant" };
              sentRole = true;
              yield makeChunk(delta, "content_filter");
            }
            continue;
          }

          const delta: ChatChunkDelta = {};
          if (!sentRole) delta.role = "assistant";
          let text = "";
          const toolCalls: ChatChunkToolCall[] = [];
          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === "string") text += part.text;
            if (part.functionCall !== undefined) {
              sawFunctionCall = true;
              // Gemini delivers a function call whole, so each becomes one
              // complete tool_call chunk (id + name + full arguments).
              toolCalls.push({
                index: toolCallIndex,
                id: `call_${toolCallIndex}`,
                type: "function",
                function: {
                  name: part.functionCall.name ?? "",
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              });
              toolCallIndex += 1;
            }
          }
          if (text.length > 0) delta.content = text;
          if (toolCalls.length > 0) delta.tool_calls = toolCalls;

          const finish =
            candidate.finishReason === undefined
              ? null
              : mapFinishReason(candidate.finishReason, sawFunctionCall);
          if (
            finish === null &&
            delta.role === undefined &&
            text.length === 0 &&
            toolCalls.length === 0
          ) {
            continue;
          }
          sentRole = true;
          yield makeChunk(delta, finish);
        }
        if (includeUsage) {
          yield {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: mapUsage(latestUsage),
          };
        }
      } finally {
        // Resolve on cancel/error too — token budgets await this promise.
        usage.resolve(latestUsage === undefined ? null : mapUsage(latestUsage));
      }
    }

    return { kind: "stream", sse: sseStreamFromChunks(chunks()), usage: usage.promise };
  }

  async listModels(ctx: RuntimeContext): Promise<ModelInfo[]> {
    try {
      const response = await ctx.fetch(joinUrl(this.baseUrl, "models"), {
        headers: { "x-goog-api-key": this.apiKey },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name?: unknown }> };
      const models = Array.isArray(data.models) ? data.models : [];
      const infos: ModelInfo[] = [];
      for (const entry of models) {
        const name = entry?.name;
        if (typeof name !== "string" || name.length === 0) continue;
        infos.push({
          id: stripModelPrefix(name),
          object: "model",
          created: 0,
          owned_by: "google",
        });
      }
      return infos;
    } catch (cause) {
      ctx.log.warn("google listModels failed", { provider: this.id, error: describeError(cause) });
      return [];
    }
  }

  async embeddings(
    request: EmbeddingsRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<EmbeddingsResult> {
    const model = stripModelPrefix(request.model);
    const input = request.input;

    let url: string;
    let body: unknown;
    let batch: boolean;
    if (typeof input === "string") {
      batch = false;
      url = joinUrl(this.baseUrl, `models/${model}:embedContent`);
      body = { content: { parts: [{ text: input }] } };
    } else if (
      Array.isArray(input) &&
      input.every((item): item is string => typeof item === "string")
    ) {
      batch = true;
      url = joinUrl(this.baseUrl, `models/${model}:batchEmbedContents`);
      body = {
        requests: input.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        })),
      };
    } else {
      return {
        kind: "error",
        status: 400,
        body: openAIErrorBody(
          "google provider does not support token-array embeddings input; send strings",
          "invalid_request_error",
        ),
      };
    }

    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: options?.signal,
      });
    } catch (cause) {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream request failed: ${describeError(cause)}`,
          "api_error",
          "upstream_error",
        ),
      };
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return upstreamErrorToResult(this.id, response.status, bodyText);
    }

    let parsed: { embedding?: { values?: unknown }; embeddings?: Array<{ values?: unknown }> };
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      return {
        kind: "error",
        status: 502,
        body: openAIErrorBody(
          `[provider ${this.id}] upstream returned invalid JSON`,
          "api_error",
          "upstream_error",
        ),
      };
    }

    const toNumberArray = (value: unknown): number[] =>
      Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
    const vectors: number[][] = batch
      ? (Array.isArray(parsed.embeddings) ? parsed.embeddings : []).map((item) =>
          toNumberArray(item?.values),
        )
      : [toNumberArray(parsed.embedding?.values)];

    return {
      kind: "embeddings",
      response: {
        object: "list",
        data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
        model,
      },
    };
  }
}

/**
 * Google Gemini translation provider: clients speak OpenAI chat completions,
 * upstream is the Gemini `generateContent` API (streaming included).
 */
export const googleProviderFactory: ProviderFactory = {
  type: "google",
  create(id, options): ChatProvider {
    // The raw provider block still carries the discriminating `type` key.
    const { type: _type, ...rest } = options;
    const parsed = googleOptionsSchema.safeParse(rest);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(options)"}: ${issue.message}`)
        .join("; ");
      throw new ConfigError(`provider "${id}" (google): invalid options — ${issues}`);
    }
    return new GoogleProvider(id, parsed.data);
  },
};
