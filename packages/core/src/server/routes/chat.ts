import type { Context } from "hono";
import { badRequest, OmniError } from "../../errors.js";
import type { ChatCompletionRequest } from "../../openai/types.js";
import type { RequestFacts } from "../../routing/types.js";
import type { RuntimeBundle } from "../../runtime/bundle.js";
import type { RuntimeContext } from "../../types.js";
import { writeKeyAllowsModel } from "../../writekeys/types.js";
import { buildRequestFacts } from "../facts.js";
import { executeChat } from "../pipeline.js";
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

function payloadTooLarge(maxBodyBytes: number): OmniError {
  return new OmniError(413, `request body exceeds the ${maxBodyBytes}-byte limit`, {
    code: "payload_too_large",
  });
}

/**
 * Read a request stream up to `maxBodyBytes`, cancelling it as soon as the
 * limit is crossed. The content-length preflight is cheaper when available,
 * while this protects chunked bodies and lying headers without buffering the
 * whole payload first.
 */
async function readBodyText(c: Context<AppEnv>, maxBodyBytes: number): Promise<string> {
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
      if (size > maxBodyBytes) {
        try {
          await reader.cancel();
        } catch {
          // The 413 response is still correct when cancellation fails.
        }
        throw payloadTooLarge(maxBodyBytes);
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
 * Parse the request body as a JSON object, rejecting bodies over
 * `maxBodyBytes` (checked against the declared `content-length` and the
 * incrementally-read body, since the header can be absent or lie). Anything
 * non-object is a 400.
 */
export async function readJsonObject(
  c: Context<AppEnv>,
  maxBodyBytes: number,
): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw payloadTooLarge(maxBodyBytes);
  }
  let text: string;
  try {
    text = await readBodyText(c, maxBodyBytes);
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
  return parsed as Record<string, unknown>;
}

/** Build (and stash on the context) the expression facts for this request. */
export function factsFor(
  c: Context<AppEnv>,
  body: ChatCompletionRequest | { model?: string },
  now: number,
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
    now,
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
    const body = await readJsonObject(c, bundle.maxBodyBytes);
    if (typeof body.model !== "string" || body.model.length === 0) {
      throw badRequest("you must provide a model parameter", { param: "model" });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw badRequest("'messages' is a required property and must be a non-empty array", {
        param: "messages",
      });
    }
    const request = body as ChatCompletionRequest;
    assertModelAllowedForClient(c, request.model);

    const runtime = deps.runtimeFor(c);
    const facts = factsFor(c, request, runtime.now(), deps.clientIp(c, bundle.trustProxyHeaders));

    const result = await executeChat(bundle, facts, request, runtime, {
      signal: c.req.raw.signal,
    });
    const metadata = createPublicChatResponseMetadata(request.model, runtime.now());

    switch (result.kind) {
      case "completion": {
        const usage = result.completion.usage;
        if (usage !== undefined) {
          runtime.waitUntil(bundle.limiter.recordUsage(facts, usage));
        }
        return c.json(redactChatCompletion(result.completion, metadata));
      }
      case "stream": {
        runtime.waitUntil(
          result.usage.then((usage) =>
            usage === null ? undefined : bundle.limiter.recordUsage(facts, usage),
          ),
        );
        return new Response(redactChatCompletionStream(result.sse, metadata), {
          headers: STREAM_RESPONSE_HEADERS,
        });
      }
      case "error":
        return Response.json(redactProviderError(result.body), { status: result.status });
    }
  };
}
