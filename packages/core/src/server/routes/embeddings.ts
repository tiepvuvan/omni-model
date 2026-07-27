import type { Context } from "hono";
import { badRequest } from "../../errors.js";
import { capturePrompt, captureRequestBody, captureRequestHeaders } from "../../logs/content.js";
import type { EmbeddingsRequest } from "../../openai/types.js";
import { shouldCaptureContent } from "../../writekeys/types.js";
import { draftOf } from "../logging.js";
import {
  acquireConcurrencySlot,
  embeddingsUsage,
  executeEmbeddings,
  storeCached,
} from "../pipeline.js";
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

    // Before the allowlist check: a refused request should still say which model
    // it asked for. See the same ordering in the chat handler.
    const draft = draftOf(c);
    if (draft !== undefined) {
      draft.modelRequested = request.model;
      if (shouldCaptureContent(c.get("writeKey") ?? null, bundle.logging.content)) {
        const prompt = capturePrompt(request.input, bundle.logging.maxContentBytes);
        const capturedBody = captureRequestBody(body, bundle.logging.maxContentBytes);
        const capturedHeaders = captureRequestHeaders(
          c.req.raw.headers,
          bundle.logging.maxContentBytes,
        );
        draft.messages = prompt.value;
        draft.body = capturedBody.value;
        draft.headers = capturedHeaders.value;
        draft.truncated = prompt.truncated || capturedBody.truncated || capturedHeaders.truncated;
      }
    }

    assertModelAllowedForClient(c, request.model);

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, runtime.now(), deps.clientIp(c, bundle.trustProxyHeaders));

    const slot = await acquireConcurrencySlot(bundle, facts);
    let execution: Awaited<ReturnType<typeof executeEmbeddings>>;
    try {
      execution = await executeEmbeddings(
        bundle,
        facts,
        request,
        runtime,
        { signal: c.req.raw.signal },
        observerFor(draft),
      );
    } finally {
      // No streaming here: the answer is complete by the time the call returns, so
      // the slot is held for exactly the upstream round-trip.
      await slot.release();
    }
    const { result, cacheKey, cached } = execution;
    if (cached) c.header("x-omni-cache", "hit");
    else if (cacheKey !== null) c.header("x-omni-cache", "miss");

    if (result.kind === "error") {
      const body = redactProviderError(result.body);
      if (draft !== undefined) draft.errorCode = body.error.code ?? null;
      return Response.json(body, { status: result.status });
    }

    const usage = result.response.usage;
    if (usage !== undefined) {
      // A cache hit spent nothing upstream, so it is not charged to a budget.
      if (!cached) runtime.waitUntil(bundle.limiter.recordUsage(facts, embeddingsUsage(usage)));
      if (draft !== undefined) draft.usage = embeddingsUsage(usage);
    }
    if (cacheKey !== null && !cached) {
      runtime.waitUntil(
        storeCached(bundle, cacheKey, {
          kind: "completion",
          completion: result.response,
          usage: usage === undefined ? null : embeddingsUsage(usage),
        }),
      );
    }
    return c.json(redactEmbeddingsResponse(result.response, request.model));
  };
}
