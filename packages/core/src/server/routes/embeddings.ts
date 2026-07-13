import type { Context } from "hono";
import { badRequest, notFound } from "../../errors.js";
import type { EmbeddingsRequest } from "../../openai/types.js";
import type { AppEnv } from "../types.js";
import {
  enforceRateLimit,
  factsFor,
  type RouteDeps,
  readJsonObject,
  requireProvider,
} from "./chat.js";

/**
 * POST /v1/embeddings — same pipeline as chat (validate, rate-limit, route)
 * for providers that implement `embeddings`. Usage is recorded against token
 * budgets with `completion_tokens: 0` since embeddings only consume input.
 */
export function createEmbeddingsHandler(
  deps: RouteDeps,
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const body = await readJsonObject(c, deps.maxBodyBytes);
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw badRequest("you must provide a model parameter", { param: "model" });
    }
    if (body.input === undefined || body.input === null) {
      throw badRequest("'input' is a required property", { param: "input" });
    }
    const request = body as EmbeddingsRequest;

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, runtime.now(), deps.clientIp(c));
    await enforceRateLimit(deps.limiter, facts);

    const decision = deps.router.resolve(facts);
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

    const result = await embed({ ...request, model: decision.model }, runtime, {
      signal: c.req.raw.signal,
    });
    if (result.kind === "error") {
      return Response.json(result.body, { status: result.status });
    }

    const usage = result.response.usage;
    if (usage !== undefined) {
      runtime.waitUntil(
        deps.limiter.recordUsage(facts, {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: usage.total_tokens,
        }),
      );
    }
    return c.json(result.response);
  };
}
