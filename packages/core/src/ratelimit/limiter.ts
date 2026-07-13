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

type CompiledKey =
  | { kind: "user" | "device" | "ip" | "global" }
  | { kind: "expression"; expression: CompiledExpression };

interface CompiledRule {
  name: string;
  when: CompiledExpression | null;
  key: CompiledKey;
  requests: CompiledWindow | null;
  tokens: CompiledWindow | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Variables exposed to `when` and `keyExpression` evaluation. */
function varsFrom(facts: RequestFacts): Record<string, unknown> {
  const { request, user, device, http, now } = facts;
  return { request, user, device, http, now };
}

function windowStartFor(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

function requestKey(rule: string, limitKey: string, windowStart: number): string {
  return `rl:req:${rule}:${limitKey}:${windowStart}`;
}

function tokenKey(rule: string, limitKey: string, windowStart: number): string {
  return `rl:tok:${rule}:${limitKey}:${windowStart}`;
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

function compileRule(rule: RateLimitRuleConfig, engine: ExpressionEngine): CompiledRule {
  let key: CompiledKey;
  if (rule.key === "expression") {
    // The schema refinement guarantees `keyExpression` here; guard for narrowing.
    if (rule.keyExpression === undefined) {
      throw new ConfigError(`rate limit rule "${rule.name}": key "expression" needs keyExpression`);
    }
    key = {
      kind: "expression",
      expression: compileExpression(engine, rule.keyExpression, rule.name, "keyExpression"),
    };
  } else {
    key = { kind: rule.key };
  }
  return {
    name: rule.name,
    when: rule.when === undefined ? null : compileExpression(engine, rule.when, rule.name, "when"),
    key,
    requests:
      rule.requests === undefined ? null : compileWindow(rule.requests, rule.name, "requests"),
    tokens: rule.tokens === undefined ? null : compileWindow(rule.tokens, rule.name, "tokens"),
  };
}

/**
 * Create a fixed-window rate limiter over the storage adapter's counters.
 *
 * Expressions and window durations are compiled/parsed eagerly so config
 * mistakes throw `ConfigError` at startup, never mid-request.
 *
 * Semantics:
 * - Token budgets are pre-checked (read-only) before any request counter is
 *   incremented, so a request rejected on an exhausted budget does not consume
 *   request-window slots.
 * - Rejected requests still consume request-window slots — attempts count by
 *   design, so hammering an exhausted limit never earns extra throughput.
 * - Storage failures fail OPEN: a rule whose counter cannot be read or written
 *   is treated as passing (logged at error level). A Redis outage must not
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
  const seenNames = new Set<string>();
  for (const rule of parsed.data) {
    if (seenNames.has(rule.name)) {
      throw new ConfigError(
        `duplicate rate limit rule name "${rule.name}"; rule names isolate counter keyspaces ` +
          "and must be unique",
      );
    }
    seenNames.add(rule.name);
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

  /** Returns null when the key cannot be derived (rule skipped for this request). */
  const deriveKey = (
    rule: CompiledRule,
    facts: RequestFacts,
    vars: Record<string, unknown>,
  ): string | null => {
    switch (rule.key.kind) {
      case "user":
        return facts.user.id ?? facts.device.id ?? facts.http.ip ?? "anonymous";
      case "device":
        return facts.device.id ?? facts.http.ip ?? "anonymous";
      case "ip":
        return facts.http.ip ?? "unknown";
      case "global":
        return "global";
      case "expression": {
        try {
          return String(rule.key.expression.evaluate(vars));
        } catch (error) {
          log.warn(`rate limit rule "${rule.name}": \`keyExpression\` threw; rule skipped`, {
            rule: rule.name,
            error: errorMessage(error),
          });
          return null;
        }
      }
    }
  };

  /** Rules whose `when` matches this request, paired with their derived limit key. */
  const applicableRules = (facts: RequestFacts): { rule: CompiledRule; limitKey: string }[] => {
    const vars = varsFrom(facts);
    const result: { rule: CompiledRule; limitKey: string }[] = [];
    for (const rule of compiled) {
      if (!applies(rule, vars)) continue;
      const limitKey = deriveKey(rule, facts, vars);
      if (limitKey === null) continue;
      result.push({ rule, limitKey });
    }
    return result;
  };

  const violation = (
    rule: CompiledRule,
    kind: "requests" | "tokens",
    window: CompiledWindow,
    windowStart: number,
    nowMs: number,
  ): RateLimitDecision => ({
    allowed: false,
    rule: rule.name,
    kind,
    limit: window.limit,
    retryAfterSeconds: Math.ceil((windowStart + window.windowMs - nowMs) / 1000),
  });

  return {
    async check(facts: RequestFacts): Promise<RateLimitDecision> {
      const nowMs = deps.now();
      const applicable = applicableRules(facts);

      // Phase 1: token budgets, read-only. An exhausted budget rejects before
      // any request counter is consumed.
      for (const { rule, limitKey } of applicable) {
        if (rule.tokens === null) continue;
        const windowStart = windowStartFor(nowMs, rule.tokens.windowMs);
        let used: number;
        try {
          used = await storage.getCounter(tokenKey(rule.name, limitKey, windowStart));
        } catch (error) {
          log.error(`rate limit storage read failed; rule "${rule.name}" fails open`, {
            rule: rule.name,
            error: errorMessage(error),
          });
          continue;
        }
        if (used >= rule.tokens.limit) {
          return violation(rule, "tokens", rule.tokens, windowStart, nowMs);
        }
      }

      // Phase 2: request windows. Every applicable window is incremented even
      // after an earlier rule rejected, so attempts count everywhere.
      let rejected: RateLimitDecision | null = null;
      for (const { rule, limitKey } of applicable) {
        if (rule.requests === null) continue;
        const windowStart = windowStartFor(nowMs, rule.requests.windowMs);
        let count: number;
        try {
          count = await storage.increment(
            requestKey(rule.name, limitKey, windowStart),
            1,
            rule.requests.ttlSeconds,
          );
        } catch (error) {
          log.error(`rate limit storage write failed; rule "${rule.name}" fails open`, {
            rule: rule.name,
            error: errorMessage(error),
          });
          continue;
        }
        if (count > rule.requests.limit && rejected === null) {
          rejected = violation(rule, "requests", rule.requests, windowStart, nowMs);
        }
      }
      return (
        rejected ?? { allowed: true, rule: null, kind: null, limit: null, retryAfterSeconds: null }
      );
    },

    async recordUsage(facts: RequestFacts, usage: Usage): Promise<void> {
      try {
        const total = usage.total_tokens;
        if (!Number.isFinite(total) || total <= 0) return;
        const nowMs = deps.now();
        for (const { rule, limitKey } of applicableRules(facts)) {
          if (rule.tokens === null) continue;
          const windowStart = windowStartFor(nowMs, rule.tokens.windowMs);
          try {
            await storage.increment(
              tokenKey(rule.name, limitKey, windowStart),
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
