import type { Context, MiddlewareHandler } from "hono";
import { OmniError } from "../errors.js";
import { nullRequestLogSink, type RequestLogEntry, type RequestLogSink } from "../logs/types.js";
import type { Usage } from "../openai/types.js";
import type { RuntimeBundle } from "../runtime/bundle.js";
import type { AppEnv } from "./types.js";

/** Header carrying the proxy-generated request id back to the caller. */
export const REQUEST_ID_HEADER = "x-omni-request-id";

/**
 * Accumulates what a request turned out to be.
 *
 * A handler knows things the middleware cannot (which provider was chosen, how
 * many tokens it cost) and the middleware knows things the handler cannot (the
 * final status when a rejection was thrown past it). This is where the two meet.
 */
export interface RequestLogDraft {
  requestId: string;
  startedAt: number;
  modelRequested: string | null;
  modelRouted: string | null;
  providerId: string | null;
  routeName: string | null;
  stream: boolean;
  usage: Usage | null;
  rateLimitRule: string | null;
  cached: boolean;
  /**
   * Set from `app.onError`, not from a catch here: Hono turns a thrown error
   * into a response before an outer middleware's `next()` resolves, so by the
   * time this middleware sees the request again the error is gone.
   */
  errorCode: string | null;
  ttfbMs: number | null;
  /** Captured prompt, when content capture is on for this request. */
  messages: unknown;
  /** Captured completion. For a stream, filled in as deltas arrive. */
  completion: string | null;
  truncated: boolean;
  /**
   * Resolves when a streamed response has finished, so the entry is written with
   * its usage and completion rather than empty. Never rejects.
   */
  settled: Promise<void> | null;
}

export function createRequestLogDraft(requestId: string, startedAt: number): RequestLogDraft {
  return {
    requestId,
    startedAt,
    modelRequested: null,
    modelRouted: null,
    providerId: null,
    routeName: null,
    stream: false,
    usage: null,
    rateLimitRule: null,
    cached: false,
    errorCode: null,
    ttfbMs: null,
    messages: undefined,
    completion: null,
    truncated: false,
    settled: null,
  };
}

/** The draft for this request, or undefined when logging is off. */
export function draftOf(c: Context<AppEnv>): RequestLogDraft | undefined {
  return c.get("logDraft");
}

export interface LoggingMiddlewareOptions {
  sink: RequestLogSink;
  /** Null while unconfigured; nothing is logged then, since nothing is served. */
  bundle: () => RuntimeBundle | null;
  now: () => number;
  newRequestId: () => string;
  /** Post-response work, so a streamed request can be logged after it ends. */
  waitUntil: (c: Context<AppEnv>) => (promise: Promise<unknown>) => void;
}

/**
 * Record one row per `/v1` request.
 *
 * Wraps everything so a request refused by rate limiting, a revoked client key
 * or a bad model is logged too — those are the rows an operator actually looks
 * for. A rejection arrives here as a thrown `OmniError`, which is why this
 * catches, records, and rethrows rather than reading `c.res` alone.
 *
 * Writing happens through `waitUntil`, so no client ever waits for a log.
 */
export function createRequestLoggingMiddleware(
  options: LoggingMiddlewareOptions,
): MiddlewareHandler<AppEnv> {
  const { sink, bundle, now, newRequestId, waitUntil } = options;

  return async (c, next) => {
    const requestId = newRequestId();

    /**
     * Stamp the *final* response.
     *
     * `c.header()` is not enough: it seeds the response Hono builds, but a
     * handler returning a `Response` directly (streaming, upstream errors) and
     * `app.onError` building one both replace it, dropping the header exactly on
     * the failure paths where a request id matters most.
     */
    const stamp = (): void => {
      try {
        c.res.headers.set(REQUEST_ID_HEADER, requestId);
      } catch {
        // Some responses have immutable headers; the id is still in the log.
      }
    };

    // No draft when nothing will read it: with a discarding sink, building one
    // and deferring a stream's completion is pure waste on the hot path.
    if (sink === nullRequestLogSink || bundle()?.logging.requests !== true) {
      await next();
      stamp();
      return;
    }

    const draft = createRequestLogDraft(requestId, now());
    c.set("logDraft", draft);

    try {
      await next();
      stamp();
      finish(c, draft, c.res.status);
    } catch (error) {
      // Reached only for an error that escaped `app.onError` entirely.
      stamp();
      finish(c, draft, error instanceof OmniError ? error.status : 500);
      throw error;
    }
  };

  function finish(c: Context<AppEnv>, draft: RequestLogDraft, status: number): void {
    const active = bundle();
    if (active === null) return;

    const write = (): void => {
      sink.record(buildEntry(c, draft, status, now()));
    };

    // A streamed response has barely started when the handler returns, so its
    // usage and completion are not known yet. `draft.settled` is the signal, and
    // it never rejects — but `then(write, write)` makes that explicit rather
    // than assumed, because losing every streamed row to one rejection would be
    // silent.
    if (draft.settled !== null) {
      waitUntil(c)(draft.settled.then(write, write));
      return;
    }
    write();
  }

  function buildEntry(
    c: Context<AppEnv>,
    draft: RequestLogDraft,
    status: number,
    endedAt: number,
  ): RequestLogEntry {
    const facts = c.get("facts");
    const identity = c.get("identity") ?? null;
    const writeKey = c.get("writeKey") ?? null;
    const entry: RequestLogEntry = {
      requestId: draft.requestId,
      ts: draft.startedAt,
      writeKeyId: writeKey?.id ?? null,
      userId: identity?.userId ?? null,
      deviceId: identity?.deviceId ?? null,
      authProvider: identity?.provider ?? null,
      modelRequested: draft.modelRequested,
      modelRouted: draft.modelRouted,
      providerId: draft.providerId,
      routeName: draft.routeName,
      stream: draft.stream,
      status,
      errorCode: draft.errorCode,
      rateLimitRule: draft.rateLimitRule,
      cached: draft.cached,
      promptTokens: draft.usage?.prompt_tokens ?? null,
      completionTokens: draft.usage?.completion_tokens ?? null,
      totalTokens: draft.usage?.total_tokens ?? null,
      latencyMs: endedAt - draft.startedAt,
      ttfbMs: draft.ttfbMs,
      // Uses the same resolver the rate limiter does, so a log row and a limit
      // decision always agree about who the caller was.
      ip: facts?.http.ip ?? null,
      userAgent: c.req.header("user-agent") ?? null,
    };
    if (draft.messages !== undefined || draft.completion !== null) {
      entry.content = {
        messages: draft.messages ?? null,
        completion: draft.completion,
        truncated: draft.truncated,
      };
    }
    return entry;
  }
}
