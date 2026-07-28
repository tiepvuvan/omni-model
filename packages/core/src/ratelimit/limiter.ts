import { z } from "zod";
import { type RateLimitRuleConfig, rateLimitRuleSchema } from "../config/schema.js";
import { ConfigError } from "../errors.js";
import type { Usage } from "../openai/types.js";
import type { CompiledExpression, ExpressionEngine, RequestFacts } from "../routing/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { Logger } from "../types.js";
import { parseDuration } from "../util/duration.js";
import type { RateLimitDecision, RateLimiter } from "./types.js";

const rulesSchema = z.array(rateLimitRuleSchema);

interface CompiledWindow {
  limit: number;
  windowMs: number;
  /** Window length plus slack so counters outlive minor clock skew. */
  ttlSeconds: number;
}

interface CompiledRule {
  /** Counter keyspace: `id ?? name`. */
  id: string;
  /** Display name, reported in decisions and headers: `name ?? id`. */
  name: string;
  when: CompiledExpression | null;
  tokens: CompiledWindow;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Variables exposed to `when` evaluation. */
function varsFrom(facts: RequestFacts): Record<string, unknown> {
  const { request, user, client, http } = facts;
  return { request, user, client, http };
}

function windowStartFor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * Counter keys are namespaced by the rule's stable `id` (not its display name),
 * so renaming a rule from a dashboard preserves its counters.
 */
function tokenKey(ruleId: string, limitKey: string, windowStart: number): string {
  return `rl:tok:${ruleId}:${limitKey}:${windowStart}`;
}

/**
 * Whose budget this request spends.
 *
 * Always the end user: a rate limit is a statement about a person's consumption,
 * and layer 1 of authentication guarantees there is one. The fallbacks are
 * defensive rather than configurable — a verifier that authenticates without
 * producing a subject would otherwise put every caller in one bucket, so the
 * publishable key, then the IP, then a single shared bucket stand in. Each is *stricter*
 * than a per-user budget, never looser.
 */
function limitKeyFor(facts: RequestFacts): string {
  return facts.user.id ?? facts.client.id ?? facts.http.ip ?? "anonymous";
}

function compileExpression(
  engine: ExpressionEngine,
  source: string,
  ruleName: string,
  field: string,
): CompiledExpression {
  try {
    return engine.compile(source);
  } catch (error) {
    throw new ConfigError(
      `rate limit rule "${ruleName}": invalid \`${field}\` expression: ${errorMessage(error)}`,
    );
  }
}

function compileWindow(
  window: { limit: number; window: string },
  ruleName: string,
  field: string,
): CompiledWindow {
  let windowMs: number;
  try {
    windowMs = parseDuration(window.window);
  } catch (error) {
    throw new ConfigError(`rate limit rule "${ruleName}": ${field}.window: ${errorMessage(error)}`);
  }
  if (windowMs <= 0) {
    throw new ConfigError(
      `rate limit rule "${ruleName}": ${field}.window must be a positive duration`,
    );
  }
  return { limit: window.limit, windowMs, ttlSeconds: Math.ceil(windowMs / 1000) + 60 };
}

/**
 * The rule's two identities, either of which may be the only one written down.
 *
 * `id` is the counter keyspace and `name` is what a 429 and a log row report;
 * each falls back to the other, so a hand-written rule can carry just a name and
 * a dashboard-written one just an id. The schema refinement guarantees one
 * exists — the throw is for narrowing and for a caller bypassing the schema.
 */
function identityOf(rule: RateLimitRuleConfig): { id: string; name: string } {
  const id = rule.id ?? rule.name;
  const name = rule.name ?? rule.id;
  if (id === undefined || name === undefined) {
    throw new ConfigError("a rate limit rule needs an `id` or a `name`");
  }
  return { id, name };
}

function compileRule(rule: RateLimitRuleConfig, engine: ExpressionEngine): CompiledRule {
  const { id, name } = identityOf(rule);
  return {
    id,
    name,
    when: rule.when === undefined ? null : compileExpression(engine, rule.when, name, "when"),
    tokens: compileWindow(rule.tokens, name, "tokens"),
  };
}

/**
 * Create a fixed-window token limiter over the storage adapter's counters.
 *
 * Expressions and window durations are compiled/parsed eagerly so config
 * mistakes throw `ConfigError` at startup, never mid-request.
 *
 * Semantics:
 * - One axis: prompt-plus-completion tokens, per user, per fixed window. Every
 *   rule whose `when` matches is enforced, so budgets layer and the first one
 *   exhausted is the one that rejects.
 * - `check` is read-only. A request is admitted on the budget remaining *before*
 *   it runs, and the tokens it goes on to spend are recorded afterwards by
 *   `recordUsage`. So a single request can overshoot its budget — you cannot
 *   know what a completion costs until it exists — and the overshoot is charged
 *   to the window it landed in.
 * - Storage failures fail OPEN: a rule whose counter cannot be read or written
 *   is treated as passing (logged at error level). A database outage must not
 *   take the API down.
 */
export function createRateLimiter(
  rules: RateLimitRuleConfig[],
  deps: { storage: StorageAdapter; engine: ExpressionEngine; log: Logger; now: () => number },
): RateLimiter {
  const parsed = rulesSchema.safeParse(rules);
  if (!parsed.success) {
    throw new ConfigError(`invalid rate limit rules:\n${z.prettifyError(parsed.error)}`);
  }
  const compiled: CompiledRule[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const rule of parsed.data) {
    const { id, name } = identityOf(rule);
    if (seenIds.has(id)) {
      throw new ConfigError(
        `duplicate rate limit rule id "${id}"; ids isolate counter keyspaces and must be unique ` +
          "(a rule without an explicit `id` uses its `name`)",
      );
    }
    if (seenNames.has(name)) {
      throw new ConfigError(
        `duplicate rate limit rule name "${name}"; names identify rules in decisions and ` +
          "response headers and must be unique",
      );
    }
    seenIds.add(id);
    seenNames.add(name);
    compiled.push(compileRule(rule, deps.engine));
  }

  const { storage, log } = deps;

  const applies = (rule: CompiledRule, vars: Record<string, unknown>): boolean => {
    if (rule.when === null) return true;
    try {
      return rule.when.evaluate(vars) === true;
    } catch (error) {
      log.debug(`rate limit rule "${rule.name}": \`when\` threw; rule does not apply`, {
        rule: rule.name,
        error: errorMessage(error),
      });
      return false;
    }
  };

  /** Rules whose `when` matches this request. */
  const applicableRules = (facts: RequestFacts): CompiledRule[] => {
    const vars = varsFrom(facts);
    return compiled.filter((rule) => applies(rule, vars));
  };

  return {
    async check(facts: RequestFacts): Promise<RateLimitDecision> {
      const nowMs = deps.now();
      const limitKey = limitKeyFor(facts);

      for (const rule of applicableRules(facts)) {
        const windowStart = windowStartFor(nowMs, rule.tokens.windowMs);
        let used: number;
        try {
          used = await storage.getCounter(tokenKey(rule.id, limitKey, windowStart));
        } catch (error) {
          log.error(`rate limit storage read failed; rule "${rule.name}" fails open`, {
            rule: rule.name,
            error: errorMessage(error),
          });
          continue;
        }
        if (used >= rule.tokens.limit) {
          return {
            allowed: false,
            rule: rule.name,
            kind: "tokens",
            limit: rule.tokens.limit,
            retryAfterSeconds: Math.ceil((windowStart + rule.tokens.windowMs - nowMs) / 1000),
          };
        }
      }

      return { allowed: true, rule: null, kind: null, limit: null, retryAfterSeconds: null };
    },

    async recordUsage(facts: RequestFacts, usage: Usage): Promise<void> {
      try {
        const total = usage.total_tokens;
        if (!Number.isFinite(total) || total <= 0) return;
        const nowMs = deps.now();
        const limitKey = limitKeyFor(facts);
        for (const rule of applicableRules(facts)) {
          const windowStart = windowStartFor(nowMs, rule.tokens.windowMs);
          try {
            await storage.increment(
              tokenKey(rule.id, limitKey, windowStart),
              total,
              rule.tokens.ttlSeconds,
            );
          } catch (error) {
            log.warn(`rate limit usage recording failed for rule "${rule.name}"`, {
              rule: rule.name,
              error: errorMessage(error),
            });
          }
        }
      } catch (error) {
        // Runs post-response (often inside waitUntil) and must never throw.
        log.warn("rate limit usage recording failed", { error: errorMessage(error) });
      }
    },
  };
}
