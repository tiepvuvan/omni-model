import type { Context } from "hono";
import { badRequest } from "../../errors.js";
import type { EmbeddingsRequest } from "../../openai/types.js";
import { draftOf } from "../logging.js";
import { embeddingsUsage, executeEmbeddings } from "../pipeline.js";
import { redactEmbeddingsResponse, redactProviderError } from "../response.js";
import type { AppEnv } from "../types.js";
import {
  assertModelAllowedForClient,
  factsFor,
  observerFor,
  type RouteDeps,
  readJsonObject,
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
    const bundle = deps.requireBundle();
    const body = await readJsonObject(c, bundle.maxBodyBytes);
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw badRequest("you must provide a model parameter", { param: "model" });
    }
    if (body.input === undefined || body.input === null) {
      throw badRequest("'input' is a required property", { param: "input" });
    }
    const request = body as EmbeddingsRequest;
    assertModelAllowedForClient(c, request.model);

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, runtime.now(), deps.clientIp(c, bundle.trustProxyHeaders));

    const draft = draftOf(c);
    if (draft !== undefined) draft.modelRequested = request.model;

    const result = await executeEmbeddings(
      bundle,
      facts,
      request,
      runtime,
      { signal: c.req.raw.signal },
      observerFor(draft),
    );
    if (result.kind === "error") {
      const body = redactProviderError(result.body);
      if (draft !== undefined) draft.errorCode = body.error.code ?? null;
      return Response.json(body, { status: result.status });
    }

    const usage = result.response.usage;
    if (usage !== undefined) {
      runtime.waitUntil(bundle.limiter.recordUsage(facts, embeddingsUsage(usage)));
      if (draft !== undefined) draft.usage = embeddingsUsage(usage);
    }
    return c.json(redactEmbeddingsResponse(result.response, request.model));
  };
}
