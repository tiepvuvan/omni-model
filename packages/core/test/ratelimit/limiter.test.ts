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
  clientId?: string | null;
  ip?: string | null;
  claims?: Record<string, unknown>;
}

function makeFacts(options: FactsOptions = {}): RequestFacts {
  const userId = options.userId ?? null;
  return {
    request: {
      model: "gpt-4o-mini",
      inputTokenCount: 12,
      maxTokens: null,
      temperature: null,
    },
    user: {
      id: userId,
      claims: options.claims ?? {},
      providers: userId !== null ? ["jwt"] : [],
    },
    client: { id: options.clientId ?? null, name: null },
    http: {
      method: "POST",
      path: "/v1/chat/completions",
      ip: options.ip ?? null,
      headers: {},
    },
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
  tokens: { limit, window },
});

/** Where a window's counter lives, for asserting on the keyspace directly. */
const windowStart = (nowMs: number, windowMs: number) => Math.floor(nowMs / windowMs) * windowMs;

describe("createRateLimiter", () => {
  describe("token budgets", () => {
    it("allows until the budget is spent, then rejects with rule metadata", async () => {
      const { limiter, storage, clock } = makeLimiter([perUser(100, "1h")]);
      const facts = makeFacts({ userId: "alice" });

      expect((await limiter.check(facts)).allowed).toBe(true);
      await limiter.recordUsage(facts, usageOf(60));
      // 60 of 100 spent: the next request is admitted on what is left.
      expect((await limiter.check(facts)).allowed).toBe(true);
      await limiter.recordUsage(facts, usageOf(60));

      const rejected = await limiter.check(facts);
      expect(rejected).toMatchObject({
        allowed: false,
        rule: "per-user",
        kind: "tokens",
        limit: 100,
      });
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(3600);
      // 120 recorded against a 100 budget: a request can overshoot, because what a
      // completion costs is only knowable once it exists. The overshoot is charged
      // to the window it landed in rather than forgiven.
      expect(await limiter.check(facts)).toMatchObject({ allowed: false });
      expect(
        await storage.getCounter(`rl:tok:per-user:alice:${windowStart(clock.now(), 3_600_000)}`),
      ).toBe(120);
    });

    it("does not spend anything on a request it rejects", async () => {
      // `check` is read-only. A client hammering an exhausted budget must not dig
      // itself deeper, and a 429 costs no upstream tokens to produce.
      const { limiter, storage, clock } = makeLimiter([perUser(10, "1h")]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(10));
      const key = `rl:tok:per-user:alice:${windowStart(clock.now(), 3_600_000)}`;

      for (let i = 0; i < 5; i++) expect((await limiter.check(facts)).allowed).toBe(false);

      expect(await storage.getCounter(key)).toBe(10);
    });

    it("allows again after the window rolls over", async () => {
      const { limiter, clock } = makeLimiter([perUser(100, "1h")]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(150));
      expect((await limiter.check(facts)).allowed).toBe(false);

      clock.advance(3_600_000);

      expect((await limiter.check(facts)).allowed).toBe(true);
    });

    it("gives each user their own budget", async () => {
      const { limiter } = makeLimiter([perUser(100, "1h")]);
      await limiter.recordUsage(makeFacts({ userId: "alice" }), usageOf(200));

      expect((await limiter.check(makeFacts({ userId: "alice" }))).allowed).toBe(false);
      expect((await limiter.check(makeFacts({ userId: "bob" }))).allowed).toBe(true);
    });

    it("ignores zero, negative and NaN usage", async () => {
      const { limiter, storage, clock } = makeLimiter([perUser(100, "1h")]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(0));
      await limiter.recordUsage(facts, usageOf(-5));
      await limiter.recordUsage(facts, usageOf(Number.NaN));

      expect(
        await storage.getCounter(`rl:tok:per-user:alice:${windowStart(clock.now(), 3_600_000)}`),
      ).toBe(0);
    });

    it("reports the first violated rule in rule order", async () => {
      const { limiter } = makeLimiter([
        { id: "small", tokens: { limit: 10, window: "1h" } },
        { id: "large", tokens: { limit: 1000, window: "1h" } },
      ]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(50));

      // Budgets layer rather than replace: both were charged, and the tighter one
      // is what answers.
      expect(await limiter.check(facts)).toMatchObject({ rule: "small", limit: 10 });
    });
  });

  /*
   * Every budget is per user. The fallbacks are defensive — layer 1 of
   * authentication guarantees a user exists — but a verifier that authenticates
   * without producing a subject must not put every caller in one bucket.
   */
  describe("whose budget it is", () => {
    it("counts against the user id", async () => {
      const { limiter, storage, clock } = makeLimiter([perUser(100, "1h")]);
      await limiter.recordUsage(makeFacts({ userId: "alice" }), usageOf(5));

      expect(
        await storage.getCounter(`rl:tok:per-user:alice:${windowStart(clock.now(), 3_600_000)}`),
      ).toBe(5);
    });

    it("falls back to the client id, then the ip, then one shared bucket", async () => {
      const { limiter, storage, clock } = makeLimiter([perUser(100, "1h")]);
      const at = windowStart(clock.now(), 3_600_000);

      await limiter.recordUsage(makeFacts({ clientId: "client-1", ip: "1.2.3.4" }), usageOf(5));
      await limiter.recordUsage(makeFacts({ ip: "1.2.3.4" }), usageOf(7));
      await limiter.recordUsage(makeFacts(), usageOf(9));

      expect(await storage.getCounter(`rl:tok:per-user:client-1:${at}`)).toBe(5);
      expect(await storage.getCounter(`rl:tok:per-user:1.2.3.4:${at}`)).toBe(7);
      // Stricter than a per-user budget, never looser: unidentifiable callers share.
      expect(await storage.getCounter(`rl:tok:per-user:anonymous:${at}`)).toBe(9);
    });
  });

  describe("when filtering", () => {
    const freeTier: RateLimitRuleConfig = {
      name: "free-tier",
      when: 'user.claims.tier == "free"',
      tokens: { limit: 100, window: "1h" },
    };
    const engine = () => fakeEngine({ 'user.claims.tier == "free"': claimProgram("tier", "free") });

    it("applies the rule only to matching requests", async () => {
      const { limiter } = makeLimiter([freeTier], { engine: engine() });
      await limiter.recordUsage(
        makeFacts({ userId: "alice", claims: { tier: "free" } }),
        usageOf(200),
      );

      expect(
        (await limiter.check(makeFacts({ userId: "alice", claims: { tier: "free" } }))).allowed,
      ).toBe(false);
      expect(
        (await limiter.check(makeFacts({ userId: "bob", claims: { tier: "pro" } }))).allowed,
      ).toBe(true);
    });

    it("re-evaluates `when` so usage is only recorded for matching requests", async () => {
      const { limiter, storage, clock } = makeLimiter([freeTier], { engine: engine() });
      await limiter.recordUsage(
        makeFacts({ userId: "pro", claims: { tier: "pro" } }),
        usageOf(500),
      );

      expect(
        await storage.getCounter(`rl:tok:free-tier:pro:${windowStart(clock.now(), 3_600_000)}`),
      ).toBe(0);
    });

    it("skips the rule when `when` throws (e.g. missing claim) and logs at debug", async () => {
      const log = spyLogger();
      const { limiter } = makeLimiter([freeTier], { engine: engine(), log });
      await limiter.recordUsage(makeFacts({ userId: "alice" }), usageOf(500));

      // An unguarded claim read throws, and a throw means "does not apply" — the
      // same silent-failure shape the router has, said out loud in the log.
      expect((await limiter.check(makeFacts({ userId: "alice" }))).allowed).toBe(true);
      expect(log.debug).toHaveBeenCalled();
    });
  });

  describe("storage failures fail open", () => {
    it("check allows the request and logs an error when storage throws", async () => {
      const log = spyLogger();
      const { limiter } = makeLimiter([perUser(10)], {
        storage: new FailingStorageAdapter(),
        log,
      });

      expect(await limiter.check(makeFacts({ userId: "alice" }))).toEqual({
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
      const { limiter } = makeLimiter([perUser(10)], {
        storage: new FailingStorageAdapter(),
        log,
      });

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
        when: "nope",
        tokens: { limit: 1, window: "1m" },
      };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
      expect(() => makeLimiter([rule])).toThrow(/`when` expression/);
    });

    it("throws ConfigError on an invalid window duration", () => {
      const rule: RateLimitRuleConfig = { name: "bad", tokens: { limit: 1, window: "soon" } };
      expect(() => makeLimiter([rule])).toThrow(ConfigError);
    });

    it("throws ConfigError on a zero-length window", () => {
      const rule: RateLimitRuleConfig = { name: "bad", tokens: { limit: 1, window: "0s" } };
      expect(() => makeLimiter([rule])).toThrow(/positive duration/);
    });

    it("throws ConfigError on a rule with no budget", () => {
      // Tokens are the only axis, so a rule without them limits nothing.
      expect(() => makeLimiter([{ name: "pointless" } as unknown as RateLimitRuleConfig])).toThrow(
        ConfigError,
      );
    });

    it("throws ConfigError on duplicate rule names", () => {
      expect(() => makeLimiter([perUser(1), perUser(2)])).toThrow(/duplicate rate limit rule/);
    });
  });

  /*
   * A rule created from a dashboard has an id and no name — there is no field on
   * the screen to type one into. A hand-written rule usually has only a name.
   * Both must work, and both must land in the right place: the id is the counter
   * keyspace, the name is what a 429 reports.
   */
  describe("identity", () => {
    it("reports the id as the rule name when only an id is set", async () => {
      const { limiter } = makeLimiter([{ id: "limit-1", tokens: { limit: 10, window: "1h" } }]);
      const facts = makeFacts({ userId: "alice" });
      await limiter.recordUsage(facts, usageOf(10));

      expect(await limiter.check(facts)).toMatchObject({ allowed: false, rule: "limit-1" });
    });

    it("keys counters by id, so renaming preserves them", async () => {
      const rule = (name: string): RateLimitRuleConfig => ({
        id: "stable",
        name,
        tokens: { limit: 10, window: "1h" },
      });
      const storage = new MemoryStorageAdapter(() => Date.now());
      const facts = makeFacts({ userId: "alice" });

      const before = makeLimiter([rule("Free tier")], { storage });
      await before.limiter.recordUsage(facts, usageOf(10));

      // A new limiter over the same storage is what a config reload builds.
      const after = makeLimiter([rule("Free plan")], { storage });

      expect(await after.limiter.check(facts)).toMatchObject({
        allowed: false,
        rule: "Free plan",
      });
    });

    it("rejects a rule with neither an id nor a name", () => {
      expect(() =>
        makeLimiter([{ tokens: { limit: 1, window: "1m" } } as RateLimitRuleConfig]),
      ).toThrow(/`id` or a `name`/);
    });

    it("detects a duplicate between an explicit id and another rule's name", () => {
      // `shared` is one keyspace written two ways: the second rule's counters
      // would silently share the first's budget.
      expect(() =>
        makeLimiter([
          { name: "shared", tokens: { limit: 1, window: "1m" } },
          { id: "shared", name: "other", tokens: { limit: 9, window: "1m" } },
        ]),
      ).toThrow(/duplicate rate limit rule id "shared"/);
    });
  });
});
