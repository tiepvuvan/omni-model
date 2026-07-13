/**
 * OpenAI-compatible wire types.
 *
 * These are intentionally permissive: every object carries an index signature
 * so unknown fields sent by clients are preserved and passed through to
 * upstream providers instead of being dropped.
 */

export interface ChatContentPartText {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ChatContentPartImage {
  type: "image_url";
  image_url: { url: string; detail?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type ChatContentPart =
  | ChatContentPartText
  | ChatContentPartImage
  | { type: string; [key: string]: unknown };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | (string & {});
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean; [key: string]: unknown };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  tools?: ChatTool[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  response_format?: { type: string; [key: string]: unknown };
  seed?: number;
  user?: string;
  [key: string]: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
  [key: string]: unknown;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  [key: string]: unknown;
}

export interface ChatChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ChatChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: ChatChunkToolCall[];
  [key: string]: unknown;
}

export interface ChatChunkChoice {
  index: number;
  delta: ChatChunkDelta;
  finish_reason: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatChunkChoice[];
  usage?: Usage | null;
  [key: string]: unknown;
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  [key: string]: unknown;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

export interface EmbeddingsRequest {
  model: string;
  input: string | string[] | number[] | number[][];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
  [key: string]: unknown;
}

export interface EmbeddingObject {
  object: "embedding";
  index: number;
  embedding: number[] | string;
  [key: string]: unknown;
}

export interface EmbeddingsResponse {
  object: "list";
  data: EmbeddingObject[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}
