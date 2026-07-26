import { promptCacheKey } from "../cache/key.js";
import type { CachedEntry, PromptCache } from "../cache/types.js";
import { notFound, type OmniError, OmniError as OmniErrorClass, rateLimited } from "../errors.js";
import type { ChatCompletionRequest, EmbeddingsRequest, Usage } from "../openai/types.js";
import type {
  ChatProvider,
  ChatResult,
  EmbeddingsResult,
  ProviderCallOptions,
} from "../providers/types.js";
import type { ConcurrencyLimiter, RateLimitDecision, RateLimiter } from "../ratelimit/types.js";
import type { RequestFacts, RouteDecision, Router } from "../routing/types.js";
import type { Logger, RuntimeContext } from "../types.js";

/**
 * The components the request pipeline runs on, independent of any transport.
 * The HTTP routes and the Firebase callable adapter both drive the same
 * rate-limit → route → provider flow through these.
 */
export interface PipelineDeps {
  providers: ReadonlyMap<string, ChatProvider>;
  router: Router;
  limiter: RateLimiter;
  /** Null when no in-flight bound is configured. */
  concurrency?: ConcurrencyLimiter | null;
  /** Null when caching is off or no backend is wired. */
  cache?: { store: PromptCache; ttlSeconds: number } | null;
  log: Logger;
}

/** Map a rate-limit violation to a 429 `OmniError` with limit metadata headers. */
export function rateLimitError(decision: RateLimitDecision): OmniError {
  const rule = decision.rule ?? "unknown";
  const message =
    decision.kind === "tokens"
      ? `Token budget exceeded for rate limit rule "${rule}". Please try again later.`
      : `Rate limit exceeded for rule "${rule}". Please try again later.`;
  const error = rateLimited(message, decision.retryAfterSeconds ?? undefined);
  if (decision.limit !== null) error.headers["x-ratelimit-limit"] = String(decision.limit);
  if (decision.rule !== null) error.headers["x-ratelimit-rule"] = decision.rule;
  return error;
}

/** Run the limiter and throw the 429 `OmniError` on a violation. */
export async function enforceRateLimit(
  limiter: RateLimiter,
  facts: RequestFacts,
  observer?: PipelineObserver,
): Promise<void> {
  const decision = await limiter.check(facts);
  if (!decision.allowed) {
    // Reported before throwing so a refused request is logged with the rule that
    // refused it — otherwise a 429 row says nothing about which limit was hit.
    observer?.rateLimited?.(decision.rule);
    throw rateLimitError(decision);
  }
}

/**
 * Optional hooks for a caller that needs to record what the pipeline decided.
 *
 * The transport layer cannot recompute these: re-running the router would be a
 * second CEL evaluation per request, and a rate-limit decision is consumed by
 * the throw.
 */
export interface PipelineObserver {
  routed?(decision: RouteDecision): void;
  rateLimited?(rule: string | null): void;
  /** A cache hit served this request, so no upstream was called. */
  cached?(): void;
}

/**
 * A 429 for a user with too many requests already running.
 *
 * Distinct from a budget 429 in its `code`, because the remedy is different:
 * a budget says "come back when the window rolls over", this one says "wait for
 * your own requests to finish" — hence a one-second `retry-after` rather than a
 * window.
 */
export function concurrencyError(limit: number): OmniError {
  const error = new OmniErrorClass(
    429,
    `You already have ${limit} request${limit === 1 ? "" : "s"} in flight. ` +
      "Wait for one to finish before sending another.",
    {
      code: "concurrency_limit_exceeded",
      headers: { "Retry-After": "1", "x-ratelimit-concurrency": String(limit) },
    },
  );
  return error;
}

/**
 * Take an in-flight slot, or throw the 429.
 *
 * The caller owns the release, because the right moment to give a slot back is
 * transport-shaped: when the response body is finished, which for a stream is long
 * after the handler returned.
 */
export async function acquireConcurrencySlot(
  deps: PipelineDeps,
  facts: RequestFacts,
): Promise<{ release(): Promise<void> }> {
  const limiter = deps.concurrency ?? null;
  if (limiter === null) return { release: async () => {} };
  const decision = await limiter.acquire(facts);
  if (!decision.ok) throw concurrencyError(decision.limit);
  return decision.slot;
}

/**
 * What a cacheable request resolved to, and what was in the cache for it.
 *
 * The key can only be computed *after* routing — it covers the resolved upstream
 * and model — so a lookup necessarily happens between the routing decision and the
 * provider call.
 */
export interface CacheLookup {
  key: string;
  hit: CachedEntry | null;
}

/**
 * Look up a routed request, tolerating a broken cache.
 *
 * A cache that can fail a request would be worse than no cache, so a backend error
 * is logged and treated as a miss.
 */
async function lookUp(
  deps: PipelineDeps,
  decision: RouteDecision,
  body: unknown,
  endpoint: "chat" | "embeddings",
  stream: boolean,
): Promise<CacheLookup | null> {
  const cache = deps.cache ?? null;
  if (cache === null) return null;
  try {
    const key = await promptCacheKey({
      providerType: decision.providerType,
      routeName: decision.routeName,
      model: decision.model,
      body,
      stream,
      endpoint,
    });
    return { key, hit: await cache.store.get(key) };
  } catch (error) {
    deps.log.warn("cache lookup failed; serving from the upstream", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Store a response, tolerating a broken cache the same way. */
export async function storeCached(
  deps: PipelineDeps,
  key: string,
  entry: CachedEntry,
): Promise<void> {
  const cache = deps.cache ?? null;
  if (cache === null) return;
  try {
    await cache.store.put(key, entry, cache.ttlSeconds);
  } catch (error) {
    deps.log.warn("caching a response failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** What `executeChat` decided, including whether the answer came from the cache. */
export interface ChatExecution {
  result: ChatResult;
  /** The key to store this answer under, or null when it must not be cached. */
  cacheKey: string | null;
  /** True when `result` was replayed from the cache and no upstream was called. */
  cached: boolean;
}

/**
 * Rate-limit, route, then answer from the cache or call the provider's `chat`.
 *
 * Throws `OmniError` on a rate-limit violation (429) or when nothing can serve the
 * model (404). The caller records usage, stores the answer under `cacheKey` when it
 * is worth keeping, and handles transport.
 */
export async function executeChat(
  deps: PipelineDeps,
  facts: RequestFacts,
  request: ChatCompletionRequest,
  runtime: RuntimeContext,
  options?: ProviderCallOptions,
  observer?: PipelineObserver,
): Promise<ChatExecution> {
  await enforceRateLimit(deps.limiter, facts, observer);
  const decision = deps.router.resolve(facts);
  observer?.routed?.(decision);

  const stream = request.stream === true;
  const lookup = await lookUp(deps, decision, request, "chat", stream);
  if (lookup?.hit !== undefined && lookup.hit !== null) {
    observer?.cached?.();
    deps.log.info("request served from cache", {
      provider: decision.providerType,
      model: decision.model,
      route: decision.routeName,
    });
    return { result: replay(lookup.hit), cacheKey: lookup.key, cached: true };
  }

  deps.log.info("request routed", {
    provider: decision.providerType,
    model: decision.model,
    route: decision.routeName,
  });
  const result = await decision.provider.chat(
    { ...request, model: decision.model },
    runtime,
    options,
  );
  return { result, cacheKey: lookup?.key ?? null, cached: false };
}

/**
 * Turn a stored entry back into a provider result.
 *
 * Deliberately re-enters the normal response path rather than shortcutting it: the
 * stored value is what the *upstream* said, so redaction, usage accounting and the
 * log row all behave exactly as they did the first time, and a replayed answer
 * carries this request's identifiers rather than the original's.
 */
function replay(entry: CachedEntry): ChatResult {
  if (entry.kind === "completion") {
    return {
      kind: "completion",
      completion: entry.completion as ChatResult extends { completion: infer C } ? C : never,
    } as ChatResult;
  }
  const bytes = new TextEncoder().encode(entry.sse);
  return {
    kind: "stream",
    sse: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    usage: Promise.resolve(entry.usage),
  } as ChatResult;
}

/**
 * Rate-limit, route, then call the provider's `embeddings`. Throws `OmniError`
 * (429 / 404, or 404 when the routed provider has no embeddings support).
 */
export interface EmbeddingsExecution {
  result: EmbeddingsResult;
  cacheKey: string | null;
  cached: boolean;
}

/**
 * Rate-limit, route, then answer from the cache or call the provider's
 * `embeddings`. Throws `OmniError` (429 / 404, or 404 when the routed provider has
 * no embeddings support).
 *
 * Embeddings are the best case for a cache: the same input against the same model
 * is the same vector, every time.
 */
export async function executeEmbeddings(
  deps: PipelineDeps,
  facts: RequestFacts,
  request: EmbeddingsRequest,
  runtime: RuntimeContext,
  options?: ProviderCallOptions,
  observer?: PipelineObserver,
): Promise<EmbeddingsExecution> {
  await enforceRateLimit(deps.limiter, facts, observer);
  const decision = deps.router.resolve(facts);
  observer?.routed?.(decision);

  const lookup = await lookUp(deps, decision, request, "embeddings", false);
  const hit = lookup?.hit ?? null;
  if (hit !== null && hit.kind === "completion") {
    observer?.cached?.();
    deps.log.info("request served from cache", {
      provider: decision.providerType,
      model: decision.model,
      route: decision.routeName,
    });
    return {
      result: { kind: "embeddings", response: hit.completion } as EmbeddingsResult,
      cacheKey: lookup?.key ?? null,
      cached: true,
    };
  }

  deps.log.info("request routed", {
    provider: decision.providerType,
    model: decision.model,
    route: decision.routeName,
  });
  const provider = decision.provider;
  const embed = provider.embeddings?.bind(provider);
  if (embed === undefined) {
    throw notFound(`provider "${provider.id}" does not support embeddings`, {
      code: "unsupported_endpoint",
    });
  }
  const result = await embed({ ...request, model: decision.model }, runtime, options);
  return { result, cacheKey: lookup?.key ?? null, cached: false };
}

/**
 * Normalize an embeddings response's usage into a token-budget `Usage`.
 * Embeddings only consume input, so `completion_tokens` is 0.
 */
export function embeddingsUsage(usage: { prompt_tokens: number; total_tokens: number }): Usage {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: 0,
    total_tokens: usage.total_tokens,
  };
}
