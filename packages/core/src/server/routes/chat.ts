import type { Context } from "hono";
import { badRequest, OmniError, rateLimited } from "../../errors.js";
import type { ChatCompletionRequest } from "../../openai/types.js";
import type { ChatProvider } from "../../providers/types.js";
import type { RateLimitDecision, RateLimiter } from "../../ratelimit/types.js";
import type { RequestFacts, Router } from "../../routing/types.js";
import type { Logger, RuntimeContext } from "../../types.js";
import { buildRequestFacts, extractClientIp } from "../facts.js";
import type { AppEnv } from "../types.js";

/** Dependencies shared by every `/v1` route handler. */
export interface RouteDeps {
  providers: ReadonlyMap<string, ChatProvider>;
  router: Router;
  limiter: RateLimiter;
  log: Logger;
  /** Per-request runtime: `waitUntil` bound to the platform execution context. */
  runtimeFor: (c: Context<AppEnv>) => RuntimeContext;
}

/** Parse the request body as a JSON object; anything else is a 400. */
export async function readJsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw badRequest("request body is not valid JSON", { code: "invalid_json" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Build (and stash on the context) the expression facts for this request. */
export function factsFor(
  c: Context<AppEnv>,
  body: ChatCompletionRequest | { model?: string },
  now: number,
): RequestFacts {
  const facts = buildRequestFacts({
    method: c.req.method,
    path: c.req.path,
    headers: c.req.raw.headers,
    ip: extractClientIp(c.req.raw.headers),
    body,
    identity: c.get("identity") ?? null,
    now,
  });
  c.set("facts", facts);
  return facts;
}

/** Map a rate-limit violation to a 429 with limit metadata headers. */
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
export async function enforceRateLimit(limiter: RateLimiter, facts: RequestFacts): Promise<void> {
  const decision = await limiter.check(facts);
  if (!decision.allowed) throw rateLimitError(decision);
}

/** Look up the resolved provider; the router already validated the id. */
export function requireProvider(deps: RouteDeps, providerId: string): ChatProvider {
  const provider = deps.providers.get(providerId);
  if (provider === undefined) {
    throw new OmniError(500, `provider "${providerId}" is not configured`);
  }
  return provider;
}

const STREAM_RESPONSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  // Disable nginx response buffering so SSE chunks flush immediately.
  "x-accel-buffering": "no",
} as const;

/**
 * POST /v1/chat/completions — validate, rate-limit, route, then relay the
 * provider's completion / SSE stream / error verbatim. Token usage is
 * recorded post-response via `waitUntil` so it never delays the reply.
 */
export function createChatHandler(deps: RouteDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw badRequest("you must provide a model parameter", { param: "model" });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw badRequest("'messages' is a required property and must be a non-empty array", {
        param: "messages",
      });
    }
    const request = body as ChatCompletionRequest;

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, runtime.now());
    await enforceRateLimit(deps.limiter, facts);

    const decision = deps.router.resolve(facts);
    deps.log.info("request routed", {
      provider: decision.providerId,
      model: decision.model,
      route: decision.routeName,
    });
    const provider = requireProvider(deps, decision.providerId);

    const result = await provider.chat({ ...request, model: decision.model }, runtime, {
      signal: c.req.raw.signal,
    });

    switch (result.kind) {
      case "completion": {
        const usage = result.completion.usage;
        if (usage !== undefined) {
          runtime.waitUntil(deps.limiter.recordUsage(facts, usage));
        }
        return c.json(result.completion);
      }
      case "stream": {
        runtime.waitUntil(
          result.usage.then((usage) =>
            usage === null ? undefined : deps.limiter.recordUsage(facts, usage),
          ),
        );
        return new Response(result.sse, { headers: STREAM_RESPONSE_HEADERS });
      }
      case "error":
        return Response.json(result.body, { status: result.status });
    }
  };
}
