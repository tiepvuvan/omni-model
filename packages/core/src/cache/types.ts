import type { Usage } from "../openai/types.js";

/**
 * A stored upstream answer, keyed by the request that produced it.
 *
 * What is stored is the *upstream's* answer, before the response boundary
 * redacts it — a completion object for a non-streaming request, the raw SSE text
 * for a streaming one. Serving therefore runs the same redaction a live answer
 * does, so a replayed response carries this request's own identifiers rather than
 * the identifiers of whoever populated the entry.
 */
export type CachedEntry =
  | { kind: "completion"; completion: unknown; usage: Usage | null }
  | { kind: "stream"; sse: string; usage: Usage | null };

/**
 * Exact-match cache for prompt/response pairs.
 *
 * Keyed by a hash of the resolved upstream, the resolved model and the request
 * body, so an entry can only ever be served to a request that would have produced
 * it. See `promptCacheKey`.
 *
 * Every method must tolerate a backend outage by degrading rather than throwing:
 * a cache that can fail a request is worse than no cache. `get` answers null and
 * `put` does nothing.
 */
export interface PromptCache {
  get(key: string): Promise<CachedEntry | null>;
  /** Store (or replace) an entry. `ttlSeconds` comes from configuration. */
  put(key: string, entry: CachedEntry, ttlSeconds: number): Promise<void>;
  /** Drop everything. Returns how many entries were removed. */
  purge(): Promise<number>;
  /** What is in there, for the dashboard. */
  stats(): Promise<PromptCacheStats>;
  /**
   * Drop expired rows, then the oldest entries until both limits are satisfied.
   *
   * Called periodically rather than on every write: trimming on the hot path
   * would put a second statement in front of every cacheable response, and the
   * bound is a budget rather than a hard invariant.
   */
  evict(maxEntries: number, maxBytes: number): Promise<number>;
}

export interface PromptCacheStats {
  /** Live (unexpired) entries. */
  entries: number;
  /** Age of the oldest live entry, in epoch milliseconds. */
  oldestAt: number | null;
  /** Total bytes of stored responses, when the backend can say. */
  bytes: number | null;
}
