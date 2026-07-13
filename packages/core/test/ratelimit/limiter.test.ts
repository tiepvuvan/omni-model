import { describe, expect, it, vi } from "vitest";
import type { RateLimitRuleConfig } from "../../src/config/schema.js";
import { ConfigError } from "../../src/errors.js";
import { silentLogger } from "../../src/logging.js";
import type { Usage } from "../../src/openai/types.js";
import { createRateLimiter } from "../../src/ratelimit/limiter.js";
import type {
  CompiledExpression,
  ExpressionEngine,
  RequestFacts,
} from "../../src/routing/types.js";
import { MemoryStorageAdapter } from "../../src/storage/memory.js";
import type { StorageAdapter } from "../../src/storage/types.js";
import type { Logger } from "../../src/types.js";

type Program = (vars: Record<string, unknown>) => unknown;

/** Expression engine backed by a lookup of source -> JS function. */
function fakeEngine(programs: Record<string, Program> = {}): ExpressionEngine {
  return {
    name: "fake",
    compile(source: string): CompiledExpression {
      const program = programs[source];
      if (program === undefined) throw new ConfigError(`unknown expression: ${source}`);
      return { evaluate: (vars) => program(vars) };
    },
  };
}

/** Reads user.claims.<name> like CEL: throws when the claim is absent. */
function claimProgram(name: string, expected: unknown): Program {
  return (vars) => {
    const user = vars.user as RequestFacts["user"];
    const value = user.claims[name];
    if (value === undefined) throw new Error(`no such attribute: ${name}`);
    return value === expected;
  };
}

function makeClock(startMs = 1_000_000_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface FactsOptions {
  userId?: string | null;
  deviceId?: string | null;
  ip?: string | null;
  claims?: Record<string, unknown>;
}

function makeFacts(options: FactsOptions = {}): RequestFacts {
  const userId = options.userId ?? null;
  return {
    request: {
      model: "gpt-4o-mini",
      stream: false,
      messageCount: 1,
      maxTokens: null,
      temperature: null,
      user: null,
    },
    user: {
      id: userId,
      authenticated: userId !== null,
      provider: userId !== null ? "jwt" : null,
      claims: options.claims ?? {},
    },
    device: { id: options.deviceId ?? null },
    http: {
      method: "POST",
      path: "/v1/chat/completions",
      ip: options.ip ?? null,
      headers: {},
    },
    now: 0,
  };
}

function usageOf(total: number): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: total };
}

function spyLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeLimiter(
  rules: RateLimitRuleConfig[],
  options: { storage?: StorageAdapter; engine?: ExpressionEngine; log?: Logger } = {},
) {
  const clock = makeClock();
  const storage = options.storage ?? new MemoryStorageAdapter(clock.now);
  const limiter = createRateLimiter(rules, {
    storage,
    engine: options.engine ?? fakeEngine(),
    log: options.log ?? silentLogger,
    now: clock.now,
  });
  return { limiter, storage, clock };
}

/** Storage whose every operation fails, simulating a backend outage. */
class FailingStorageAdapter implements StorageAdapter {
  readonly type = "failing";
  async get(): Promise<string | null> {
    throw new Error("storage down");
  }
  async put(): Promise<void> {
    throw new Error("storage down");
  }
  async delete(): Promise<void> {
    throw new Error("storage down");
  }
  async increment(): Promise<number> {
    throw new Error("storage down");
  }
  async getCounter(): Promise<number> {
    throw new Error("storage down");
  }
}

const perUser = (limit: number, window = "1m"): RateLimitRuleConfig => ({
  name: "per-user",
  key: "user",
  requests: { limit, window },
});

describe("createRateLimiter", () => {
  describe("request windows", () => {
    it("allows up to the limit, then rejects with rule metadata", async () => {
      const { limiter } = makeLimiter([perUser(60)]);
      const facts = makeFacts({ userId: "alice" });
      for (let i = 0; i < 60; i++) {
        const decision = await limiter.check(facts);
        expect(decision.allowed).toBe(true);
        expect(decision.rule).toBeNull();
        expect(decision.retryAfterSeconds).toBeNull();
      }
      const rejected = await limiter.check(facts);
      expect(rejected).toMatchObject({
        allowed: false,
        rule: "per-user",
        kind: "requests",
        limit: 60,
      });
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
    });

    it("allows again after the window rolls over", async () => {
      const { limiter, clock } = makeLimiter([perUser(2)]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.check(facts);
      await limiter.check(facts);
      expect((await limiter.check(facts)).allowed).toBe(false);
      clock.advance(60_000); // guaranteed to land in the next 1m window
      expect((await limiter.check(facts)).allowed).toBe(true);
    });

    it("isolates counters per user", async () => {
      const { limiter } = makeLimiter([perUser(1)]);
      expect((await limiter.check(makeFacts({ userId: "alice" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ userId: "alice" }))).allowed).toBe(false);
      expect((await limiter.check(makeFacts({ userId: "bob" }))).allowed).toBe(true);
    });

    it("rejected attempts still consume window slots", async () => {
      const { limiter, storage, clock } = makeLimiter([perUser(1)]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.check(facts);
      await limiter.check(facts);
      await limiter.check(facts);
      const windowStart = Math.floor(clock.now() / 60_000) * 60_000;
      expect(await storage.getCounter(`rl:req:per-user:alice:${windowStart}`)).toBe(3);
    });

    it('user key falls back to device id, then ip, then "anonymous"', async () => {
      const { limiter } = makeLimiter([perUser(1)]);
      // No user: device id becomes the key.
      expect((await limiter.check(makeFacts({ deviceId: "dev-1" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ deviceId: "dev-1" }))).allowed).toBe(false);
      // No user or device: ip becomes the key, and distinct ips are isolated.
      expect((await limiter.check(makeFacts({ ip: "1.1.1.1" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ ip: "1.1.1.1" }))).allowed).toBe(false);
      expect((await limiter.check(makeFacts({ ip: "2.2.2.2" }))).allowed).toBe(true);
      // Nothing at all: everyone shares "anonymous".
      expect((await limiter.check(makeFacts())).allowed).toBe(true);
      expect((await limiter.check(makeFacts())).allowed).toBe(false);
    });

    it("device key uses device id and falls back to ip", async () => {
      const rule: RateLimitRuleConfig = {
        name: "per-device",
        key: "device",
        requests: { limit: 1, window: "1m" },
      };
      const { limiter } = makeLimiter([rule]);
      expect((await limiter.check(makeFacts({ deviceId: "dev-1" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ deviceId: "dev-1" }))).allowed).toBe(false);
      expect((await limiter.check(makeFacts({ deviceId: "dev-2" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ ip: "3.3.3.3" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ ip: "3.3.3.3" }))).allowed).toBe(false);
    });

    it("global key shares one counter across all callers", async () => {
      const rule: RateLimitRuleConfig = {
        name: "everyone",
        key: "global",
        requests: { limit: 1, window: "1m" },
      };
      const { limiter } = makeLimiter([rule]);
      expect((await limiter.check(makeFacts({ userId: "alice" }))).allowed).toBe(true);
      expect((await limiter.check(makeFacts({ userId: "bob" }))).allowed).toBe(false);
    });

    it("reports the first violated rule in rule order and still charges later rules", async () => {
      const ruleA: RateLimitRuleConfig = {
        name: "a",
        key: "user",
        requests: { limit: 1, window: "1m" },
      };
      const ruleB: RateLimitRuleConfig = {
        name: "b",
        key: "user",
        requests: { limit: 1, window: "1m" },
      };
      const { limiter, storage, clock } = makeLimiter([ruleA, ruleB]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.check(facts);
      const rejected = await limiter.check(facts);
      expect(rejected).toMatchObject({ allowed: false, rule: "a", kind: "requests" });
      const windowStart = Math.floor(clock.now() / 60_000) * 60_000;
      expect(await storage.getCounter(`rl:req:b:alice:${windowStart}`)).toBe(2);
    });
  });

  describe("when filtering", () => {
    const freeTier: RateLimitRuleConfig = {
      name: "free-tier",
      when: 'user.claims.tier == "free"',
      key: "user",
      requests: { limit: 1, window: "1m" },
    };
    const engine = () => fakeEngine({ 'user.claims.tier == "free"': claimProgram("tier", "free") });

    it("applies the rule only to matching requests", async () => {
      const { limiter } = makeLimiter([freeTier], { engine: engine() });
      const free = makeFacts({ userId: "alice", claims: { tier: "free" } });
      expect((await limiter.check(free)).allowed).toBe(true);
      expect((await limiter.check(free)).allowed).toBe(false);
      const pro = makeFacts({ userId: "bob", claims: { tier: "pro" } });
      for (let i = 0; i < 5; i++) {
        expect((await limiter.check(pro)).allowed).toBe(true);
      }
    });

    it("skips the rule when `when` throws (e.g. missing claim) and logs at debug", async () => {
      const log = spyLogger();
      const { limiter } = makeLimiter([freeTier], { engine: engine(), log });
      const noClaims = makeFacts({ userId: "carol" });
      for (let i = 0; i < 5; i++) {
        expect((await limiter.check(noClaims)).allowed).toBe(true);
      }
      expect(log.debug).toHaveBeenCalled();
    });
  });

  describe("expression keys", () => {
    const perOrg: RateLimitRuleConfig = {
      name: "per-org",
      key: "expression",
      keyExpression: "user.claims.org",
      requests: { limit: 1, window: "1m" },
    };
    const engine = () =>
      fakeEngine({
        "user.claims.org": (vars) => {
          const user = vars.user as RequestFacts["user"];
          const org = user.claims.org;
          if (org === undefined) throw new Error("no such attribute: org");
          return org;
        },
      });

    it("keys counters by the expression result", async () => {
      const { limiter } = makeLimiter([perOrg], { engine: engine() });
      const acme = makeFacts({ userId: "alice", claims: { org: "acme" } });
      const acme2 = makeFacts({ userId: "bob", claims: { org: "acme" } });
      const globex = makeFacts({ userId: "carol", claims: { org: "globex" } });
      expect((await limiter.check(acme)).allowed).toBe(true);
      expect((await limiter.check(acme2)).allowed).toBe(false); // same org, same counter
      expect((await limiter.check(globex)).allowed).toBe(true);
    });

    it("skips the rule and warns when the key expression throws", async () => {
      const log = spyLogger();
      const { limiter } = makeLimiter([perOrg], { engine: engine(), log });
      const noOrg = makeFacts({ userId: "dave" });
      expect((await limiter.check(noOrg)).allowed).toBe(true);
      expect((await limiter.check(noOrg)).allowed).toBe(true);
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe("token budgets", () => {
    const budget: RateLimitRuleConfig = {
      name: "budget",
      key: "user",
      requests: { limit: 50, window: "1h" },
      tokens: { limit: 100, window: "1h" },
    };

    it("accumulates usage and rejects once over the limit without consuming request slots", async () => {
      const { limiter, storage, clock } = makeLimiter([budget]);
      const facts = makeFacts({ userId: "alice" });
      const windowStart = Math.floor(clock.now() / 3_600_000) * 3_600_000;

      expect((await limiter.check(facts)).allowed).toBe(true);
      await limiter.recordUsage(facts, usageOf(60));
      expect((await limiter.check(facts)).allowed).toBe(true); // 60 < 100
      await limiter.recordUsage(facts, usageOf(60));
      expect(await storage.getCounter(`rl:tok:budget:alice:${windowStart}`)).toBe(120);

      const rejected = await limiter.check(facts);
      expect(rejected).toMatchObject({
        allowed: false,
        rule: "budget",
        kind: "tokens",
        limit: 100,
      });
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(3600);
      // The two allowed checks consumed request slots; the token rejection did not.
      expect(await storage.getCounter(`rl:req:budget:alice:${windowStart}`)).toBe(2);
    });

    it("resets the budget when the token window rolls over", async () => {
      const { limiter, clock } = makeLimiter([budget]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(150));
      expect((await limiter.check(facts)).allowed).toBe(false);
      clock.advance(3_600_000);
      expect((await limiter.check(facts)).allowed).toBe(true);
    });

    it("ignores zero, negative and NaN usage", async () => {
      const { limiter, storage, clock } = makeLimiter([budget]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(0));
      await limiter.recordUsage(facts, usageOf(-5));
      await limiter.recordUsage(facts, usageOf(Number.NaN));
      const windowStart = Math.floor(clock.now() / 3_600_000) * 3_600_000;
      expect(await storage.getCounter(`rl:tok:budget:alice:${windowStart}`)).toBe(0);
    });

    it("re-evaluates `when` so usage is only recorded for matching requests", async () => {
      const rule: RateLimitRuleConfig = {
        name: "free-budget",
        when: 'user.claims.tier == "free"',
        key: "user",
        tokens: { limit: 100, window: "1h" },
      };
      const engine = fakeEngine({
        'user.claims.tier == "free"': claimProgram("tier", "free"),
      });
      const { limiter, storage, clock } = makeLimiter([rule], { engine });
      await limiter.recordUsage(
        makeFacts({ userId: "pro", claims: { tier: "pro" } }),
        usageOf(500),
      );
      const windowStart = Math.floor(clock.now() / 3_600_000) * 3_600_000;
      expect(await storage.getCounter(`rl:tok:free-budget:pro:${windowStart}`)).toBe(0);
    });
  });

  describe("storage failures fail open", () => {
    it("check allows the request and logs an error when storage throws", async () => {
      const log = spyLogger();
      const rule: RateLimitRuleConfig = {
        name: "budget",
        key: "user",
        requests: { limit: 1, window: "1m" },
        tokens: { limit: 10, window: "1m" },
      };
      const { limiter } = makeLimiter([rule], { storage: new FailingStorageAdapter(), log });
      const decision = await limiter.check(makeFacts({ userId: "alice" }));
      expect(decision).toEqual({
        allowed: true,
        rule: null,
        kind: null,
        limit: null,
        retryAfterSeconds: null,
      });
      expect(log.error).toHaveBeenCalled();
    });

    it("recordUsage resolves and warns when storage throws", async () => {
      const log = spyLogger();
      const rule: RateLimitRuleConfig = {
        name: "budget",
        key: "user",
        tokens: { limit: 10, window: "1m" },
      };
      const { limiter } = makeLimiter([rule], { storage: new FailingStorageAdapter(), log });
      await expect(
        limiter.recordUsage(makeFacts({ userId: "alice" }), usageOf(5)),
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalled();
    });
  });

  describe("build-time validation", () => {
    it("throws ConfigError when a `when` expression does not compile", () => {
      const rule: RateLimitRuleConfig = {
        name: "bad",
        when: "this does not compile",
        key: "user",
        requests: { limit: 1, window: "1m" },
      };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
      expect(() => makeLimiter([rule])).toThrow(/`when` expression/);
    });

    it("throws ConfigError when a key expression does not compile", () => {
      const rule: RateLimitRuleConfig = {
        name: "bad",
        key: "expression",
        keyExpression: "nope",
        requests: { limit: 1, window: "1m" },
      };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
    });

    it("throws ConfigError when key is expression but keyExpression is missing", () => {
      const rule: RateLimitRuleConfig = {
        name: "bad",
        key: "expression",
        requests: { limit: 1, window: "1m" },
      };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
    });

    it("throws ConfigError on an invalid window duration", () => {
      const rule: RateLimitRuleConfig = {
        name: "bad",
        key: "user",
        requests: { limit: 1, window: "soon" },
      };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
    });

    it("throws ConfigError on a zero-length window", () => {
      const rule: RateLimitRuleConfig = {
        name: "bad",
        key: "user",
        requests: { limit: 1, window: "0s" },
      };
      expect(() => makeLimiter([rule])).toThrow(/positive duration/);
    });

    it("throws ConfigError on duplicate rule names", () => {
      expect(() => makeLimiter([perUser(1), perUser(2)])).toThrow(/duplicate rate limit rule/);
    });
  });
});
