import type { Usage } from "../openai/types.js";
import type { RequestFacts } from "../routing/types.js";

export interface RateLimitDecision {
  allowed: boolean;
  /** Name of the first violated rule when `allowed` is false. */
  rule: string | null;
  /**
   * What was exhausted. Only ever `"tokens"`: token budgets are the only kind of
   * limit there is. Kept as a field because a 429 body and a log row report it,
   * and a future second axis would otherwise be a breaking change to both.
   */
  kind: "tokens" | null;
  limit: number | null;
  /** Seconds until the current window resets (when not allowed). */
  retryAfterSeconds: number | null;
}

export interface RateLimiter {
  /**
   * Read every matching rule's counter and reject when one is exhausted.
   *
   * Read-only: a request is admitted on what was spent before it, and what it
   * spends is recorded by `recordUsage` once the response exists.
   */
  check(facts: RequestFacts): Promise<RateLimitDecision>;
  /**
   * Record token usage against all matching token-budget rules. Called after
   * the response completes (via `waitUntil` for streams). Must never throw.
   */
  recordUsage(facts: RequestFacts, usage: Usage): Promise<void>;
}
