import type { Context } from "hono";
import { badRequest, OmniError } from "../../errors.js";
import {
  ContentAccumulator,
  capturePrompt,
  captureRequestBody,
  captureRequestHeaders,
} from "../../logs/content.js";
import type { ChatCompletionRequest } from "../../openai/types.js";
import type { RequestFacts } from "../../routing/types.js";
import type { RuntimeBundle } from "../../runtime/bundle.js";
import type { RuntimeContext } from "../../types.js";
import { estimateInputTokens, inputTokenBodyByteCeiling } from "../../util/input-tokens.js";
import { shouldCaptureContent, writeKeyAllowsModel } from "../../writekeys/types.js";
import { buildRequestFacts } from "../facts.js";
import { draftOf, type RequestLogDraft } from "../logging.js";
import {
  acquireConcurrencySlot,
  executeChat,
  type PipelineObserver,
  storeCached,
} from "../pipeline.js";
import {
  createPublicChatResponseMetadata,
  redactChatCompletion,
  redactChatCompletionStream,
  redactProviderError,
} from "../response.js";
import type { AppEnv } from "../types.js";

/**
 * Dependencies shared by every `/v1` route handler.
 *
 * Everything configuration-derived comes from {@link requireBundle}, read once
 * per request. A request therefore serves entirely from the bundle it started
 * with, even if a reload swaps in a new one mid-flight.
 */
export interface RouteDeps {
  /**
   * The bundle to serve this request with. Throws a 503 when the proxy has no
   * active configuration.
   */
  requireBundle: () => RuntimeBundle;
  /** Per-request runtime: `waitUntil` bound to the platform execution context. */
  runtimeFor: (c: Context<AppEnv>) => RuntimeContext;
  /**
   * Resolve the client IP. Takes `trustProxyHeaders` from the bundle rather
   * than capturing it, since it is reconfigurable.
   */
  clientIp: (c: Context<AppEnv>, trustProxyHeaders: boolean) => string | null;
}

function inputTokenLimitExceeded(maxInputTokens: number): OmniError {
  return new OmniError(
    413,
    `request input exceeds the configured limit of ${maxInputTokens} tokens`,
    {
      code: "input_token_limit_exceeded",
    },
  );
}

/**
 * Reject a parsed request whose provider-neutral token estimate exceeds the
 * configured per-request limit.
 */
export function enforceInputTokenLimit(
  body: Record<string, unknown>,
  maxInputTokens: number,
): void {
  if (estimateInputTokens(body) > maxInputTokens) {
    throw inputTokenLimitExceeded(maxInputTokens);
  }
}

/**
 * Read a request stream within the maximum UTF-8 representation that could fit
 * `maxInputTokens`, cancelling as soon as the ceiling is crossed.
 */
async function readBodyText(c: Context<AppEnv>, maxInputTokens: number): Promise<string> {
  const maxBufferedBytes = inputTokenBodyByteCeiling(maxInputTokens);
  const body = c.req.raw.body;
  if (body === null) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > maxBufferedBytes) {
        try {
          await reader.cancel();
        } catch {
          // The 413 response is still correct when cancellation fails.
        }
        throw inputTokenLimitExceeded(maxInputTokens);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OmniError) throw error;
    throw badRequest("request body is not valid JSON", { code: "invalid_json" });
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Parse the request body as a JSON object, then enforce its provider-neutral
 * input-token estimate. Anything non-object is a 400.
 */
export async function readJsonObject(
  c: Context<AppEnv>,
  maxInputTokens: number,
): Promise<Record<string, unknown>> {
  const maxBufferedBytes = inputTokenBodyByteCeiling(maxInputTokens);
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBufferedBytes) {
    throw inputTokenLimitExceeded(maxInputTokens);
  }
  let text: string;
  try {
    text = await readBodyText(c, maxInputTokens);
  } catch (error) {
    if (error instanceof OmniError) throw error;
    throw badRequest("request body is not valid JSON", { code: "invalid_json" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("request body is not valid JSON", { code: "invalid_json" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  enforceInputTokenLimit(body, maxInputTokens);
  return body;
}

/** Build (and stash on the context) the expression facts for this request. */
export function factsFor(
  c: Context<AppEnv>,
  body: ChatCompletionRequest | { model?: string },
  ip: string | null,
): RequestFacts {
  const facts = buildRequestFacts({
    method: c.req.method,
    path: c.req.path,
    headers: c.req.raw.headers,
    ip,
    body,
    identity: c.get("identity") ?? null,
    writeKey: c.get("writeKey") ?? null,
  });
  c.set("facts", facts);
  return facts;
}

/**
 * Enforce a write key's own model allowlist.
 *
 * Reported as `model_not_found` rather than a permission error, matching
 * `routing.allowedModels`: a client should not be able to discover which models
 * exist by probing for the difference between "forbidden" and "absent".
 */
export function assertModelAllowedForClient(c: Context<AppEnv>, model: string): void {
  const writeKey = c.get("writeKey") ?? null;
  if (writeKey === null || writeKeyAllowsModel(writeKey, model)) return;
  throw new OmniError(
    404,
    `The model \`${model}\` does not exist or you do not have access to it.`,
    {
      code: "model_not_found",
      param: "model",
    },
  );
}

/**
 * Report what the pipeline decided into the log draft.
 *
 * Returns undefined when logging is off, so the pipeline does no work for it.
 */
export function observerFor(draft: RequestLogDraft | undefined): PipelineObserver | undefined {
  if (draft === undefined) return undefined;
  return {
    routed: (decision) => {
      draft.modelRouted = decision.model;
      draft.providerId = decision.providerId;
      draft.routeName = decision.routeName;
    },
    rateLimited: (rule) => {
      draft.rateLimitRule = rule;
    },
    cached: () => {
      draft.cached = true;
    },
  };
}

/**
 * How much of a streamed answer is worth keeping.
 *
 * A cache entry is a convenience, and an unbounded one fed by responses nobody has
 * measured is how a database fills up. A stream past this is served normally and
 * simply not stored.
 */
const MAX_CACHED_STREAM_BYTES = 256 * 1024;

/**
 * Tee a stream, returning the branch to serve and a promise of the other branch's
 * text.
 *
 * The captured branch is the *upstream* SSE, before redaction — so a replay goes
 * through the same redaction a live answer does and carries the replaying request's
 * own identifiers. Capture stops at the cap and reports null, which also means a
 * client that hangs up early stores nothing.
 */
function teeForCache(sse: ReadableStream<Uint8Array>): {
  serve: ReadableStream<Uint8Array>;
  captured: Promise<string | null>;
} {
  const [serve, copy] = sse.tee();
  const captured = (async (): Promise<string | null> => {
    const reader = copy.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        size += value.byteLength;
        if (size > MAX_CACHED_STREAM_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      // An upstream that broke mid-stream has no complete answer to cache.
      return null;
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  })();
  return { serve, captured };
}

/** Assembled assistant text from a non-streamed completion. */
function completionText(completion: { choices?: { message?: { content?: unknown } }[] }): string {
  const content = completion.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
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
 * provider's completion / SSE stream. Provider metadata is redacted at the
 * response boundary while token usage is retained internally for accounting.
 */
export function createChatHandler(deps: RouteDeps): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    // Captured once: this request is served entirely by this bundle, so a
    // reload cannot swap the router out from under a response already streaming.
    const bundle = deps.requireBundle();
    const body = await readJsonObject(c, bundle.maxInputTokens);
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw badRequest("you must provide a model parameter", { param: "model" });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw badRequest("'messages' is a required property and must be a non-empty array", {
        param: "messages",
      });
    }
    const request = body as ChatCompletionRequest;

    const draft = draftOf(c);
    const capture =
      draft !== undefined &&
      shouldCaptureContent(c.get("writeKey") ?? null, bundle.logging.content);
    // Before the allowlist check, not after: "which model was this client
    // refused" is the whole reason that row gets looked at, and a rejection
    // thrown first would log it with no model at all.
    if (draft !== undefined) {
      draft.modelRequested = request.model;
      draft.stream = request.stream === true;
      if (capture) {
        const prompt = capturePrompt(request.messages, bundle.logging.maxContentBytes);
        const capturedBody = captureRequestBody(body, bundle.logging.maxContentBytes);
        const capturedHeaders = captureRequestHeaders(
          c.req.raw.headers,
          bundle.logging.maxContentBytes,
        );
        draft.messages = prompt.value;
        draft.body = capturedBody.value;
        draft.headers = capturedHeaders.value;
        draft.truncated =
          draft.truncated ||
          prompt.truncated ||
          capturedBody.truncated ||
          capturedHeaders.truncated;
      }
    }

    assertModelAllowedForClient(c, request.model);

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, deps.clientIp(c, bundle.trustProxyHeaders));

    /*
     * The in-flight slot is taken before the upstream call and given back when the
     * response *body* is finished — which for a stream is long after this handler
     * returns. Holding it only for the handler would leave the bound measuring
     * nothing, since a stream spends almost all its life after that point.
     */
    const slot = await acquireConcurrencySlot(bundle, facts);
    let execution: Awaited<ReturnType<typeof executeChat>>;
    try {
      execution = await executeChat(
        bundle,
        facts,
        request,
        runtime,
        { signal: c.req.raw.signal },
        observerFor(draft),
      );
    } catch (error) {
      await slot.release();
      throw error;
    }
    const { result, cacheKey, cached } = execution;
    const metadata = createPublicChatResponseMetadata(request.model, runtime.now());
    if (cached) c.header("x-omni-cache", "hit");
    else if (cacheKey !== null) c.header("x-omni-cache", "miss");

    switch (result.kind) {
      case "completion": {
        await slot.release();
        const usage = result.completion.usage;
        /*
         * A cache hit cost no upstream tokens, so it is not charged to a budget.
         * Charging for it would make the cache invisible to the thing it exists to
         * protect — and would bill a user for work nobody did.
         */
        if (usage !== undefined && !cached) {
          runtime.waitUntil(bundle.limiter.recordUsage(facts, usage));
        }
        if (cacheKey !== null && !cached) {
          runtime.waitUntil(
            storeCached(bundle, cacheKey, {
              kind: "completion",
              completion: result.completion,
              usage: usage ?? null,
            }),
          );
        }
        if (draft !== undefined) {
          draft.usage = usage ?? null;
          if (capture) {
            const accumulator = new ContentAccumulator(bundle.logging.maxContentBytes);
            accumulator.push(completionText(result.completion));
            draft.completion = accumulator.text();
            draft.truncated = draft.truncated || accumulator.truncated;
          }
        }
        return c.json(redactChatCompletion(result.completion, metadata));
      }
      case "stream": {
        // `result.usage` settles on every exit path — done, upstream error, or the
        // client hanging up — which makes it the only correct moment to give the
        // slot back and to decide whether there is an answer worth storing.
        runtime.waitUntil(
          result.usage.then(
            async (usage) => {
              await slot.release();
              if (usage !== null && !cached) await bundle.limiter.recordUsage(facts, usage);
            },
            async () => {
              await slot.release();
            },
          ),
        );
        const accumulator = capture
          ? new ContentAccumulator(bundle.logging.maxContentBytes)
          : undefined;
        if (draft !== undefined) {
          // `result.usage` settles on every exit path — done, upstream error, or
          // the client hanging up — so it is also the "stream is over" signal
          // that tells the logger when the row is complete.
          draft.settled = result.usage.then(
            (usage) => {
              draft.usage = usage;
              if (accumulator !== undefined) {
                draft.completion = accumulator.text();
                draft.truncated = draft.truncated || accumulator.truncated;
              }
            },
            () => {},
          );
        }
        const tap =
          accumulator === undefined ? undefined : (delta: string) => accumulator.push(delta);

        // Cache the upstream's own bytes, not the redacted ones, and only once the
        // stream finished cleanly — a half-delivered answer must never be replayed
        // as a complete one.
        let sse = result.sse;
        if (cacheKey !== null && !cached) {
          const tee = teeForCache(sse);
          sse = tee.serve;
          runtime.waitUntil(
            Promise.all([tee.captured, result.usage.catch(() => null)]).then(([text, usage]) =>
              text === null
                ? undefined
                : storeCached(bundle, cacheKey, { kind: "stream", sse: text, usage }),
            ),
          );
        }
        return new Response(redactChatCompletionStream(sse, metadata, tap), {
          headers: { ...STREAM_RESPONSE_HEADERS, ...(cached ? { "x-omni-cache": "hit" } : {}) },
        });
      }
      case "error": {
        await slot.release();
        // An upstream failure is returned, not thrown, so `app.onError` never
        // sees it — without this the row would say 502 with no reason. Nothing is
        // cached: an error is not an answer.
        const body = redactProviderError(result.body);
        if (draft !== undefined) draft.errorCode = body.error.code ?? null;
        return Response.json(body, { status: result.status });
      }
    }
  };
}
