import type { Usage } from "../openai/types.js";
import type { RequestFacts } from "../routing/types.js";

export interface RateLimitDecision {
  allowed: boolean;
  /** Name of the first violated rule when `allowed` is false. */
  rule: string | null;
  kind: "requests" | "tokens" | null;
  limit: number | null;
  /** Seconds until the current window resets (when not allowed). */
  retryAfterSeconds: number | null;
}

export interface RateLimiter {
  /**
   * Evaluate every matching rule for this request: consume one request from
   * each request window and reject when any request count or token budget is
   * exhausted.
   */
  check(facts: RequestFacts): Promise<RateLimitDecision>;
  /**
   * Record token usage against all matching token-budget rules. Called after
   * the response completes (via `waitUntil` for streams). Must never throw.
   */
  recordUsage(facts: RequestFacts, usage: Usage): Promise<void>;
}
