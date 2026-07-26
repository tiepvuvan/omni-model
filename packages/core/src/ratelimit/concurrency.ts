import type { RequestFacts } from "../routing/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { Logger } from "../types.js";

/**
 * How many requests one user may have in flight at once.
 *
 * This exists because token budgets are *post-paid*: a request is admitted on the
 * tokens spent before it, and what it costs is only known once the response
 * exists. Fire fifty expensive requests simultaneously and every one of them is
 * admitted against the same empty counter — the budget is exceeded fifty times
 * over before the first response lands. A concurrency bound is what closes that,
 * and it is the reason it is on by default rather than opt-in.
 *
 * The counter is shared through the storage adapter, so the bound holds across
 * replicas rather than per process.
 */
export interface ConcurrencySlot {
  /** Give the slot back. Safe to call twice; the second call does nothing. */
  release(): Promise<void>;
}

export type ConcurrencyDecision =
  | { ok: true; slot: ConcurrencySlot }
  | { ok: false; limit: number };

export interface ConcurrencyLimiter {
  /** Take a slot for this request, or refuse when the user is already at the limit. */
  acquire(facts: RequestFacts): Promise<ConcurrencyDecision>;
}

/**
 * The counter's lifetime.
 *
 * A slot is released in a `finally`, but a process killed mid-request cannot run
 * one — so the counter carries a TTL and a leaked slot heals on its own instead of
 * locking a user out until someone notices. Long enough that a slow completion or
 * a live stream is never mistaken for a leak.
 */
const SLOT_TTL_SECONDS = 15 * 60;

/** Whose slots these are: the same identity a token budget is counted against. */
function keyFor(facts: RequestFacts): string {
  const owner = facts.user.id ?? facts.device.id ?? facts.http.ip ?? "anonymous";
  return `rl:conc:${owner}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create a per-user concurrency limiter over the storage adapter's counters.
 *
 * Fails **open**, like every other limit here: if the counter cannot be read or
 * written the request proceeds. A storage outage must not take the API down, and
 * a bound that turns into an outage is worse than one that lapses.
 */
export function createConcurrencyLimiter(
  perUser: number,
  deps: { storage: StorageAdapter; log: Logger },
): ConcurrencyLimiter {
  const { storage, log } = deps;

  return {
    async acquire(facts: RequestFacts): Promise<ConcurrencyDecision> {
      const key = keyFor(facts);
      let released = false;
      const give = async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await storage.increment(key, -1, SLOT_TTL_SECONDS);
        } catch (error) {
          // The TTL is the backstop: a slot that cannot be given back expires.
          log.warn("releasing a concurrency slot failed", { error: errorMessage(error) });
        }
      };

      let inFlight: number;
      try {
        inFlight = await storage.increment(key, 1, SLOT_TTL_SECONDS);
      } catch (error) {
        log.error("concurrency storage write failed; the limit fails open", {
          error: errorMessage(error),
        });
        return { ok: true, slot: { release: async () => {} } };
      }

      if (inFlight > perUser) {
        // Taken and given straight back rather than checked first: a read-then-write
        // pair lets two simultaneous requests both see room and both proceed, which
        // is exactly the race this limit exists to close.
        await give();
        return { ok: false, limit: perUser };
      }
      return { ok: true, slot: { release: give } };
    },
  };
}
