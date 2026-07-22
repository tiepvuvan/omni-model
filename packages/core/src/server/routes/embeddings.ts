import type { Context } from "hono";
import { badRequest } from "../../errors.js";
import type { EmbeddingsRequest } from "../../openai/types.js";
import { embeddingsUsage, executeEmbeddings } from "../pipeline.js";
import { redactEmbeddingsResponse, redactProviderError } from "../response.js";
import type { AppEnv } from "../types.js";
import { factsFor, type RouteDeps, readJsonObject } from "./chat.js";

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

    const result = await executeEmbeddings(deps, facts, request, runtime, {
      signal: c.req.raw.signal,
    });
    if (result.kind === "error") {
      return Response.json(redactProviderError(result.body), { status: result.status });
    }

    const usage = result.response.usage;
    if (usage !== undefined) {
      runtime.waitUntil(deps.limiter.recordUsage(facts, embeddingsUsage(usage)));
    }
    return c.json(redactEmbeddingsResponse(result.response, request.model));
  };
}
