import { parse as parseYaml } from "yaml";
import type { AuthResult, AuthVerifierFactory, Identity } from "../../src/auth/types.js";
import { parseConfigObject } from "../../src/config/load.js";
import { silentLogger } from "../../src/logging.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionRequest,
  EmbeddingsRequest,
  ModelInfo,
  OpenAIErrorBody,
  Usage,
} from "../../src/openai/types.js";
import type {
  ChatProvider,
  ChatResult,
  EmbeddingsResult,
  ProviderFactory,
} from "../../src/providers/types.js";
import { createDefaultRegistry } from "../../src/registry.js";
import { createOmniApp } from "../../src/server/app.js";
import type { OmniAppInit } from "../../src/server/types.js";
import type { StorageAdapter } from "../../src/storage/types.js";
import type { Logger } from "../../src/types.js";

/** Fixed clock for deterministic rate-limit windows. */
export const FIXED_NOW = 1_750_000_000_000;

/** Fetch stub that fails loudly — server tests must never hit the network. */
export const bannedFetch: typeof fetch = () =>
  Promise.reject(new Error("network access is disabled in tests"));

export function createWaitUntilCollector() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>): void => {
      promises.push(promise);
    },
    /** Await every background task scheduled so far. */
    flush: async (): Promise<void> => {
      await Promise.allSettled(promises);
    },
    get count(): number {
      return promises.length;
    },
  };
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | undefined;
}

export function createRecordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry["level"]) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields });
    };
  return {
    entries,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
  };
}

export function cannedCompletion(model: string, usage?: Usage): ChatCompletion {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_750_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hello from fake" },
        finish_reason: "stop",
      },
    ],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export interface FakeProviderBehavior {
  completion?: ChatCompletion;
  /** When set, `chat` returns a stream of these chunks. */
  streamChunks?: ChatCompletionChunk[];
  streamUsage?: Usage | null;
  /** When set, `chat` returns this error result. */
  error?: { status: number; body: OpenAIErrorBody };
  /** When set, `listModels` is defined and resolves with these. */
  models?: ModelInfo[];
  /** When set, `listModels` is defined and rejects with this message. */
  listModelsError?: string;
  /** When set, `embeddings` is defined and returns this result. */
  embeddingsResult?: EmbeddingsResult;
}

export interface RecordedChatCall {
  request: ChatCompletionRequest;
  signal: AbortSignal | undefined;
}

export class FakeProvider implements ChatProvider {
  readonly type = "fake";
  readonly chatCalls: RecordedChatCall[] = [];
  readonly embeddingsCalls: EmbeddingsRequest[] = [];
  listModels?: () => Promise<ModelInfo[]>;
  embeddings?: (
    request: EmbeddingsRequest,
    ctx: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<EmbeddingsResult>;

  constructor(
    readonly id: string,
    private readonly behavior: FakeProviderBehavior,
  ) {
    if (behavior.models !== undefined || behavior.listModelsError !== undefined) {
      this.listModels = async () => {
        if (behavior.listModelsError !== undefined) throw new Error(behavior.listModelsError);
        return behavior.models ?? [];
      };
    }
    const embeddingsResult = behavior.embeddingsResult;
    if (embeddingsResult !== undefined) {
      this.embeddings = async (request) => {
        this.embeddingsCalls.push(request);
        return embeddingsResult;
      };
    }
  }

  async chat(
    request: ChatCompletionRequest,
    _ctx: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    this.chatCalls.push({ request, signal: options?.signal });
    const behavior = this.behavior;
    if (behavior.error !== undefined) {
      return { kind: "error", status: behavior.error.status, body: behavior.error.body };
    }
    if (behavior.streamChunks !== undefined) {
      const chunks = behavior.streamChunks;
      return {
        kind: "stream",
        sse: sseFromChunks(chunks),
        usage: Promise.resolve(behavior.streamUsage ?? null),
      };
    }
    return {
      kind: "completion",
      completion: behavior.completion ?? cannedCompletion(request.model),
    };
  }
}

function sseFromChunks(chunks: ChatCompletionChunk[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Provider factory of type "fake"; behaviors and instances keyed by provider id. */
export function createFakeProviderSetup(behaviors: Record<string, FakeProviderBehavior> = {}) {
  const instances = new Map<string, FakeProvider>();
  const factory: ProviderFactory = {
    type: "fake",
    create: (id) => {
      const provider = new FakeProvider(id, behaviors[id] ?? {});
      instances.set(id, provider);
      return provider;
    },
  };
  return { factory, instances };
}

/**
 * Verifier factory of type "fake-auth". Options (from the security provider
 * config entry):
 * - `header` (default "x-test-user"): credential header to read.
 * - `kind` ("user" | "device", default "user"): identity shape produced.
 * - `challengeRoute`: when true, contributes GET /auth/fake/challenge.
 *
 * Header absent -> null; header value "bad" -> `{ ok: false }`; anything else
 * authenticates with userId/deviceId = value and claims `{ tier: value }`
 * (or `{ device: value }` for device kind).
 */
/**
 * A verifier that accepts every request as an anonymous authenticated caller.
 *
 * Stands in for "the caller is authenticated" in suites that test routing,
 * limits or streaming rather than auth itself. It exists only so those fixtures
 * don't each have to configure a verifier and attach a credential — the app
 * always has one, exactly as production requires.
 */
export function createAlwaysAuthenticatedFactory(): AuthVerifierFactory {
  return {
    type: "test-authenticated",
    create() {
      return {
        type: "test-authenticated",
        name: "test-authenticated",
        async verify(): Promise<AuthResult> {
          return {
            ok: true,
            identity: { provider: "test-authenticated", userId: "test-user", claims: {} },
          };
        },
      };
    },
  };
}

export function createFakeAuthFactory(): AuthVerifierFactory {
  return {
    type: "fake-auth",
    create(options) {
      const header = typeof options.header === "string" ? options.header : "x-test-user";
      const name = typeof options.name === "string" ? options.name : "fake-auth";
      const kind = options.kind === "device" ? "device" : "user";
      const withChallengeRoute = options.challengeRoute === true;
      return {
        type: "fake-auth",
        name,
        async verify(request): Promise<AuthResult | null> {
          const value = request.headers.get(header);
          if (value === null) return null;
          if (value === "bad") return { ok: false, reason: `invalid credential for ${name}` };
          const identity: Identity =
            kind === "device"
              ? { provider: "fake-auth", deviceId: value, claims: { device: value } }
              : { provider: "fake-auth", userId: value, claims: { tier: value } };
          return { ok: true, identity };
        },
        routes: withChallengeRoute
          ? [
              {
                method: "GET" as const,
                path: "/auth/fake/challenge",
                handler: async (_request: Request, ctx: { storage: StorageAdapter }) => {
                  await ctx.storage.put("last-challenge", "abc");
                  return Response.json({ challenge: "abc" });
                },
              },
            ]
          : undefined,
      };
    },
  };
}

export interface TestAppOptions {
  yaml: string;
  behaviors?: Record<string, FakeProviderBehavior>;
  storage?: StorageAdapter;
  logger?: Logger;
  now?: () => number;
  env?: Record<string, string | undefined>;
  initOverrides?: Partial<OmniAppInit>;
  /**
   * The app refuses to start with no verifier, so a fixture that declares none
   * gets the always-accepting `test-authenticated` verifier injected. Most
   * suites here exercise routing/limits/streaming rather than auth and just
   * need requests to arrive authenticated — this keeps an auth block out of
   * every unrelated fixture while preserving the production invariant that a
   * verifier always exists. Set false to assert the guard itself (auth.test.ts).
   */
  injectVerifier?: boolean;
}

/**
 * Build an app from a legacy test fixture with the "fake" provider and "fake-auth"
 * verifier registered, a banned fetch, a fixed clock and a waitUntil
 * collector for asserting post-response work.
 */
export async function createTestApp(options: TestAppOptions) {
  const registry = createDefaultRegistry();
  const { factory, instances } = createFakeProviderSetup(options.behaviors);
  registry.providers.set(factory.type, factory);
  registry.auth.set("fake-auth", createFakeAuthFactory());
  registry.auth.set("test-authenticated", createAlwaysAuthenticatedFactory());
  const collector = createWaitUntilCollector();
  const config = parseConfigObject(parseYaml(options.yaml), options.env ?? {});
  if (config.security.providers.length === 0 && (options.injectVerifier ?? true)) {
    config.security.providers = [{ type: "test-authenticated" }];
  }
  const app = await createOmniApp({
    config,
    registry,
    storage: options.storage,
    fetch: bannedFetch,
    now: options.now ?? (() => FIXED_NOW),
    waitUntil: collector.waitUntil,
    logger: options.logger ?? silentLogger,
    ...options.initOverrides,
  });
  return { app, providers: instances, collector };
}

export function chatRequest(
  body: unknown,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

export function embeddingsRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://local/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const CHAT_BODY = {
  model: "smart",
  messages: [{ role: "user", content: "hi" }],
};

/** Fixed-window start for the given window length at FIXED_NOW. */
export function windowStart(windowMs: number, nowMs: number = FIXED_NOW): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Storage key used by the limiter for a token budget counter. */
export function tokenCounterKey(rule: string, limitKey: string, windowMs: number): string {
  return `rl:tok:${rule}:${limitKey}:${windowStart(windowMs)}`;
}
