/**
 * What a request cost and where it went. One row per `/v1` request, including
 * the ones that were refused — a 429 or a revoked client key is exactly what an
 * operator needs to see.
 *
 * Deliberately free of message content: that lives in {@link RequestLogContent}
 * so it can be retained on a shorter clock, or never written at all, without
 * touching the metrics.
 */
export interface RequestLogEntry {
  /** Proxy-generated, also returned as `x-omni-request-id`. */
  requestId: string;
  /** Epoch milliseconds when the request arrived. */
  ts: number;

  /** Calling application, when a write key was presented. */
  writeKeyId: string | null;
  userId: string | null;
  deviceId: string | null;
  /** Verifier type that authenticated the request. */
  authProvider: string | null;

  /** The alias the client asked for. */
  modelRequested: string | null;
  /** What the router actually sent upstream. */
  modelRouted: string | null;
  providerId: string | null;
  routeName: string | null;
  stream: boolean;

  status: number;
  /** OpenAI-style error code when the request failed. */
  errorCode: string | null;
  /** Set when a rate-limit rule refused the request. */
  rateLimitRule: string | null;
  /** Served from the response cache, so no upstream was called and nothing was spent. */
  cached: boolean;

  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;

  /** Total wall time. For a stream, until the last byte. */
  latencyMs: number | null;
  /** Time to first byte, which is the number a streaming client feels. */
  ttfbMs: number | null;

  ip: string | null;
  userAgent: string | null;

  /** Present only when content capture is enabled for this request. */
  content?: RequestLogContent;
}

/** Prompt and completion text, captured only when explicitly enabled. */
export interface RequestLogContent {
  /** The request messages (or embeddings input), as sent. */
  messages: unknown;
  completion: string | null;
  /** Whether either side was cut at the configured byte cap. */
  truncated: boolean;
}

/**
 * Where request logs go.
 *
 * `record` is fire-and-forget by contract: it must never throw and never block
 * a response. Logging is observability, not bookkeeping — losing a row is
 * strictly better than failing a request, which is the same fail-open policy
 * rate limiting follows.
 */
export interface RequestLogSink {
  readonly type: string;
  record(entry: RequestLogEntry): void;
  /** Write anything buffered. Called during graceful shutdown. */
  flush(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Batch persistence for {@link RequestLogSink}. Backends implement this and
 * inherit the buffering, batching and drop policy, so there is one place where
 * "logging must not break the proxy" is enforced.
 */
export interface RequestLogWriter {
  write(entries: readonly RequestLogEntry[]): Promise<void>;
  close?(): Promise<void>;
}

/** A sink that discards everything. Used when request logging is disabled. */
export const nullRequestLogSink: RequestLogSink = {
  type: "null",
  record: () => {},
  flush: async () => {},
};
