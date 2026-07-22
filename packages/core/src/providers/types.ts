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

export interface ProviderCallOptions {
  /** Aborted when the client disconnects. Forward to upstream fetches. */
  signal?: AbortSignal;
}

/**
 * Result of a chat call, always in OpenAI wire format regardless of the
 * upstream protocol — translation providers (Anthropic, Google) convert
 * before returning.
 */
export type ChatResult =
  | { kind: "completion"; completion: ChatCompletion }
  | {
      kind: "stream";
      /** SSE bytes: `data: <chat.completion.chunk JSON>` events + `data: [DONE]`. */
      sse: ReadableStream<Uint8Array>;
      /**
       * Resolves once the stream has ended, with the total usage when the
       * upstream reported it (null otherwise). Used for token budgets; must
       * never reject.
       */
      usage: Promise<Usage | null>;
    }
  | {
      kind: "error";
      /** Status to relay to the client (5xx upstream statuses map to 502). */
      status: number;
      body: OpenAIErrorBody;
    };

export type EmbeddingsResult =
  | { kind: "embeddings"; response: EmbeddingsResponse }
  | { kind: "error"; status: number; body: OpenAIErrorBody };

export interface ChatProvider {
  /** Config key under `providers:`, e.g. "anthropic-main". */
  readonly id: string;
  /** Factory type, e.g. "anthropic". */
  readonly type: string;
  chat(
    request: ChatCompletionRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<ChatResult>;
  listModels?(ctx: RuntimeContext): Promise<ModelInfo[]>;
  embeddings?(
    request: EmbeddingsRequest,
    ctx: RuntimeContext,
    options?: ProviderCallOptions,
  ): Promise<EmbeddingsResult>;
}

export interface ProviderFactory {
  readonly type: string;
  /**
   * `id` is the config key; `options` the raw provider block from the environment
   * config. Factories validate their own options with zod.
   */
  create(id: string, options: Record<string, unknown>, runtime: RuntimeContext): ChatProvider;
}
