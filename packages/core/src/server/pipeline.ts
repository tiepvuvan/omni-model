import { notFound, OmniError, rateLimited } from "../errors.js";
import type { ChatCompletionRequest, EmbeddingsRequest, Usage } from "../openai/types.js";
import type {
  ChatProvider,
  ChatResult,
  EmbeddingsResult,
  ProviderCallOptions,
} from "../providers/types.js";
import type { RateLimitDecision, RateLimiter } from "../ratelimit/types.js";
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

/** Look up the resolved provider; the router already validated the id exists. */
export function requireProvider(deps: PipelineDeps, providerId: string): ChatProvider {
  const provider = deps.providers.get(providerId);
  if (provider === undefined) {
    throw new OmniError(500, `provider "${providerId}" is not configured`);
  }
  return provider;
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
}

/**
 * Rate-limit, route, then call the provider's `chat`. Throws `OmniError` on a
 * rate-limit violation (429) or when nothing can serve the model (404). The
 * caller records usage from the returned `ChatResult` and handles transport.
 */
export async function executeChat(
  deps: PipelineDeps,
  facts: RequestFacts,
  request: ChatCompletionRequest,
  runtime: RuntimeContext,
  options?: ProviderCallOptions,
  observer?: PipelineObserver,
): Promise<ChatResult> {
  await enforceRateLimit(deps.limiter, facts, observer);
  const decision = deps.router.resolve(facts);
  observer?.routed?.(decision);
  deps.log.info("request routed", {
    provider: decision.providerId,
    model: decision.model,
    route: decision.routeName,
  });
  const provider = requireProvider(deps, decision.providerId);
  return provider.chat({ ...request, model: decision.model }, runtime, options);
}

/**
 * Rate-limit, route, then call the provider's `embeddings`. Throws `OmniError`
 * (429 / 404, or 404 when the routed provider has no embeddings support).
 */
export async function executeEmbeddings(
  deps: PipelineDeps,
  facts: RequestFacts,
  request: EmbeddingsRequest,
  runtime: RuntimeContext,
  options?: ProviderCallOptions,
  observer?: PipelineObserver,
): Promise<EmbeddingsResult> {
  await enforceRateLimit(deps.limiter, facts, observer);
  const decision = deps.router.resolve(facts);
  observer?.routed?.(decision);
  deps.log.info("request routed", {
    provider: decision.providerId,
    model: decision.model,
    route: decision.routeName,
  });
  const provider = requireProvider(deps, decision.providerId);
  const embed = provider.embeddings?.bind(provider);
  if (embed === undefined) {
    throw notFound(`provider "${provider.id}" does not support embeddings`, {
      code: "unsupported_endpoint",
    });
  }
  return embed({ ...request, model: decision.model }, runtime, options);
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
