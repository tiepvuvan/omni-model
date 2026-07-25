import type { MiddlewareHandler } from "hono";
import { OmniError } from "../errors.js";
import type { AppEnv } from "./types.js";

/** Response bodies that keep being written after the handler returns. */
const STREAMING_CONTENT_TYPE = "text/event-stream";

/** How long to wait for in-flight work before giving up on it. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

export interface DrainResult {
  /** Requests still in flight when draining stopped. Zero means a clean drain. */
  remaining: number;
  /** How long draining took. */
  waitedMs: number;
  /** True when the timeout fired with work still in flight. */
  timedOut: boolean;
}

/**
 * Tracks requests still being served, so a shutdown can wait for them.
 *
 * A proxy's longest-lived request is an SSE stream that has barely started when
 * the handler returns, so counting around the handler is not enough: the
 * interesting window is until the *body* finishes. That is the difference
 * between a redeploy that lets answers finish and one that truncates them
 * mid-sentence.
 */
export interface RequestTracker {
  /** Counts each request until its response is fully written. Mount first. */
  middleware: MiddlewareHandler<AppEnv>;
  inFlight(): number;
  /** Whether {@link beginShutdown} has been called. */
  draining(): boolean;
  /**
   * Stop taking new work. `/v1` answers 503, and `/readyz` reports draining, so
   * a load balancer removes this instance while the requests it already accepted
   * finish.
   */
  beginShutdown(): void;
  /**
   * Resolve when nothing is in flight, or when `timeoutMs` elapses.
   *
   * Bounded on purpose: a client can hold a stream open indefinitely, and an
   * unbounded drain would turn one such client into a stuck deploy.
   */
  drain(timeoutMs?: number): Promise<DrainResult>;
}

export interface CreateRequestTrackerOptions {
  now?: () => number;
  /** Called when a request arrives after shutdown began. */
  onRefused?: (path: string) => void;
}

/**
 * Wrap a streaming body so completion — success, upstream error, or the client
 * hanging up — decrements the counter exactly once.
 */
function trackBody(body: ReadableStream<Uint8Array>, done: () => void): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  // `pipeTo` settles on every exit path: the source ending, an error, or the
  // consumer cancelling. `then(done, done)` makes "either way" explicit rather
  // than leaving a leaked count on the error path.
  void body.pipeTo(writable).then(done, done);
  return readable;
}

export function createRequestTracker(options: CreateRequestTrackerOptions = {}): RequestTracker {
  const now = options.now ?? Date.now;
  let inFlight = 0;
  let shuttingDown = false;
  /** Resolvers waiting for the count to reach zero. */
  const idle = new Set<() => void>();

  const release = (): void => {
    inFlight -= 1;
    if (inFlight > 0) return;
    for (const resolve of idle) resolve();
    idle.clear();
  };

  const middleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (shuttingDown) {
      options.onRefused?.(c.req.path);
      // 503 rather than accepting work we are about to abandon. Retryable, and
      // the header tells a keep-alive client not to reuse this connection.
      throw new OmniError(503, "the server is shutting down; retry this request", {
        type: "api_error",
        code: "shutting_down",
      });
    }

    inFlight += 1;
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      release();
    };

    try {
      await next();
      const body = c.res.body;
      // Only a streamed response is still being written after this point. A JSON
      // response was fully materialised by the handler, so wrapping it would add
      // a copy on the hot path to learn something already known.
      if (body !== null && c.res.headers.get("content-type")?.startsWith(STREAMING_CONTENT_TYPE)) {
        c.res = new Response(trackBody(body, settle), c.res);
        return;
      }
      settle();
    } catch (error) {
      settle();
      throw error;
    }
  };

  return {
    middleware,
    inFlight: () => inFlight,
    draining: () => shuttingDown,
    beginShutdown: () => {
      shuttingDown = true;
    },
    async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
      const started = now();
      if (inFlight === 0) return { remaining: 0, waitedMs: 0, timedOut: false };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await new Promise<boolean>((resolve) => {
        const finish = (result: boolean) => () => resolve(result);
        const onIdle = finish(false);
        idle.add(onIdle);
        timer = setTimeout(() => {
          idle.delete(onIdle);
          resolve(true);
        }, timeoutMs);
        timer.unref?.();
      });
      if (timer !== undefined) clearTimeout(timer);
      return { remaining: inFlight, waitedMs: now() - started, timedOut };
    },
  };
}
