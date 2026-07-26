import { describe, expect, it } from "vitest";
import { ConfigError, OmniError } from "../../src/errors.js";
import type { ChatProvider } from "../../src/providers/types.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";
import {
  type CompiledRoutingRule,
  compileRoutingExpression,
  createRouter,
  unreachableRules,
} from "../../src/routing/router.js";
import type { RequestFacts } from "../../src/routing/types.js";
import type { Logger } from "../../src/types.js";

const engine = new CelExpressionEngine();

/** A stand-in upstream; the router never calls it, it only hands it back. */
function fakeProvider(id: string): ChatProvider {
  return {
    id,
    type: id,
    chat: async () => {
      throw new Error("the router must not call the provider");
    },
  } as unknown as ChatProvider;
}

/** One rule, from a compact spec, the way `buildBundle` assembles them. */
function rule(spec: {
  when: string;
  name?: string;
  providerType?: string;
  model?: string;
}): CompiledRoutingRule {
  const providerType = spec.providerType ?? "openai";
  const name = spec.name ?? providerType;
  return {
    when: compileRoutingExpression(engine, spec.when, `rule "${name}" when`),
    routeName: name,
    provider: fakeProvider(providerType),
    providerType,
    model: spec.model,
    warnedNonBoolean: false,
  };
}

function makeFacts(overrides?: {
  model?: string;
  claims?: Record<string, unknown>;
  path?: string;
  clientName?: string;
}): RequestFacts {
  return {
    request: {
      model: overrides?.model ?? "gpt-4o",
      stream: false,
      messageCount: 1,
      maxTokens: null,
      temperature: null,
      user: null,
    },
    user: { id: "u1", authenticated: true, provider: "jwt", claims: overrides?.claims ?? {} },
    device: { id: null },
    client:
      overrides?.clientName === undefined
        ? { id: null, name: null, authenticated: false }
        : { id: "key-1", name: overrides.clientName, authenticated: true },
    http: {
      method: "POST",
      path: overrides?.path ?? "/v1/chat/completions",
      ip: "203.0.113.9",
      headers: {},
    },
    now: 1700000000000,
  };
}

interface LogCall {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown> | undefined;
}

function makeSpyLogger(): { log: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const record =
    (level: LogCall["level"]) =>
    (message: string, fields?: Record<string, unknown>): void => {
      calls.push({ level, message, fields });
    };
  return {
    log: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    calls,
  };
}

describe("createRouter", () => {
  it("picks the first matching rule, and nothing after it runs", () => {
    const router = createRouter([
      rule({ name: "first", when: 'request.model == "gpt-4o"' }),
      rule({ name: "second", when: 'request.model == "gpt-4o"', providerType: "anthropic" }),
    ]);
    const decision = router.resolve(makeFacts());
    expect(decision.routeName).toBe("first");
    expect(decision.providerType).toBe("openai");
    expect(decision.model).toBe("gpt-4o");
  });

  it("hands back the rule's own upstream, so there is nothing to look up", () => {
    // The point of the target living on the rule: a matched rule cannot fail to
    // find where it was pointing.
    const router = createRouter([rule({ name: "only", when: "true", providerType: "anthropic" })]);
    const decision = router.resolve(makeFacts());
    expect(decision.provider.id).toBe("anthropic");
  });

  it("applies the target's model override, or passes the requested model through", () => {
    const router = createRouter([
      rule({ name: "override", when: 'http.path.contains("cheap")', model: "gpt-4o-mini" }),
      rule({ name: "passthrough", when: "true" }),
    ]);
    expect(router.resolve(makeFacts({ path: "/cheap/v1/chat" })).model).toBe("gpt-4o-mini");
    expect(router.resolve(makeFacts()).model).toBe("gpt-4o");
  });

  it("treats a throwing condition as no match and falls through", () => {
    const { log, calls } = makeSpyLogger();
    const router = createRouter(
      [
        // Reading a missing key throws in CEL when claims is empty.
        rule({ name: "pro-users", when: 'user.claims.tier == "pro"', providerType: "anthropic" }),
        rule({ name: "catch-all", when: "true" }),
      ],
      { log },
    );

    expect(router.resolve(makeFacts({ claims: {} })).routeName).toBe("catch-all");
    const debugCalls = calls.filter((call) => call.level === "debug");
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]?.fields?.rule).toBe("pro-users");

    // The same rule matches once the claim is there.
    expect(router.resolve(makeFacts({ claims: { tier: "pro" } })).routeName).toBe("pro-users");
  });

  it("skips a non-boolean result and warns once per rule, not once per request", () => {
    const { log, calls } = makeSpyLogger();
    const router = createRouter(
      [
        rule({ name: "bad-expr", when: "request.model", providerType: "anthropic" }),
        rule({ name: "catch-all", when: "true" }),
      ],
      { log },
    );
    expect(router.resolve(makeFacts()).routeName).toBe("catch-all");
    expect(router.resolve(makeFacts()).routeName).toBe("catch-all");
    const warns = calls.filter((call) => call.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields?.rule).toBe("bad-expr");
  });

  it("routes on the client that called, not only on the model", () => {
    const router = createRouter([
      rule({ name: "premium", when: 'client.name == "ios"', providerType: "anthropic" }),
      rule({ name: "catch-all", when: "true" }),
    ]);
    expect(router.resolve(makeFacts({ clientName: "ios" })).routeName).toBe("premium");
    expect(router.resolve(makeFacts({ clientName: "android" })).routeName).toBe("catch-all");
  });

  it("restricts client model names when an allowlist is configured", () => {
    const router = createRouter([rule({ when: "true" })], { allowedModels: ["smart"] });

    expect(router.resolve(makeFacts({ model: "smart" })).providerType).toBe("openai");
    expect(() => router.resolve(makeFacts({ model: "not-allowed" }))).toThrow(OmniError);
    try {
      router.resolve(makeFacts({ model: "not-allowed" }));
    } catch (error) {
      const omniError = error as OmniError;
      expect(omniError.status).toBe(404);
      expect(omniError.code).toBe("model_not_found");
      expect(omniError.param).toBe("model");
    }
  });

  it("404s when no rule matches, because nothing serves a request implicitly", () => {
    // There is no default provider to fall back to any more: a catch-all is a
    // rule with `when: "true"`, and its absence is a deliberate configuration.
    const router = createRouter([rule({ when: 'request.model == "something-else"' })]);
    let thrown: unknown;
    try {
      router.resolve(makeFacts({ model: "mystery-model" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    const omniError = thrown as OmniError;
    expect(omniError.status).toBe(404);
    expect(omniError.code).toBe("model_not_found");
    expect(omniError.message).toContain("mystery-model");
  });

  it("says so plainly when there are no rules at all", () => {
    // A fresh deployment before anyone has configured routing. "no rules are
    // configured" is a much better answer than "that model does not exist".
    const router = createRouter([]);
    expect(() => router.resolve(makeFacts())).toThrow(/no routing rules are configured/);
  });

  it("throws ConfigError for an invalid expression, naming where it came from", () => {
    expect(() => compileRoutingExpression(engine, "&&&", 'rule "broken" when')).toThrow(
      ConfigError,
    );
    expect(() => compileRoutingExpression(engine, "&&&", 'rule "broken" when')).toThrow(/broken/);
  });
});

/**
 * `explain` exists because `resolve` is deliberately forgiving: a rule that
 * throws is skipped so one bad condition cannot 500 every request. That is right
 * for serving traffic and it is also why a broken rule is invisible — these
 * assertions are what make it visible to an operator.
 */
describe("Router.explain", () => {
  it("reports each rule up to the one that matched", () => {
    const router = createRouter([
      rule({ name: "premium", when: 'client.name == "ios"', providerType: "anthropic" }),
      rule({ name: "catch-all", when: "true" }),
    ]);

    expect(router.explain(makeFacts({ clientName: "ios" }))).toEqual([
      { rule: "premium", providerType: "anthropic", outcome: "match" },
    ]);
    expect(router.explain(makeFacts({ clientName: "android" }))).toEqual([
      { rule: "premium", providerType: "anthropic", outcome: "no-match" },
      { rule: "catch-all", providerType: "openai", outcome: "match" },
    ]);
  });

  it("reports a rule that throws, which resolve() silently skips", () => {
    const router = createRouter([
      rule({ name: "pro-only", when: 'user.claims.plan == "pro"', providerType: "anthropic" }),
      rule({ name: "catch-all", when: "true" }),
    ]);
    const facts = makeFacts();

    // resolve() serves the request from the catch-all, giving no hint that the
    // rule above it is broken.
    expect(router.resolve(facts).routeName).toBe("catch-all");

    const [evaluation] = router.explain(facts);
    expect(evaluation?.outcome).toBe("error");
    expect(evaluation?.rule).toBe("pro-only");
    expect(evaluation?.error).toBeTruthy();
  });

  it("distinguishes a guarded miss from a throw", () => {
    const router = createRouter([
      rule({ name: "pro-only", when: 'has(user.claims.plan) && user.claims.plan == "pro"' }),
    ]);
    expect(router.explain(makeFacts())[0]?.outcome).toBe("no-match");
    expect(router.explain(makeFacts({ claims: { plan: "pro" } }))[0]?.outcome).toBe("match");
  });

  it("reports a non-boolean result, which never counts as a match", () => {
    const router = createRouter([rule({ name: "truthy", when: '"yes"' })]);
    expect(router.explain(makeFacts())).toEqual([
      { rule: "truthy", providerType: "openai", outcome: "non-boolean", resultType: "string" },
    ]);
  });

  it("never throws, even when every rule is broken", () => {
    const router = createRouter([
      rule({ name: "a", when: "user.claims.missing" }),
      rule({ name: "b", when: "device.missing" }),
    ]);
    expect(router.explain(makeFacts()).map((evaluation) => evaluation.outcome)).toEqual([
      "error",
      "error",
    ]);
  });
});

/**
 * A rule after a catch-all is valid, serves traffic, and is dead — the proxy
 * answers normally from the earlier rule, so nothing about a request reveals it.
 * Found by adding a rule through the admin API and watching it never fire.
 */
describe("unreachableRules", () => {
  it("finds a rule shadowed by an earlier catch-all", () => {
    expect(
      unreachableRules([
        { id: "catch-all", when: "true" },
        { id: "premium", when: 'user.claims.tier == "pro"' },
      ]),
    ).toEqual([{ rule: "premium", shadowedBy: "catch-all" }]);
  });

  it("reports every rule after the catch-all, not just the next one", () => {
    expect(
      unreachableRules([
        { id: "a", when: "false" },
        { id: "b", when: " true " },
        { id: "c", when: "false" },
        { id: "d", when: "false" },
      ]).map((entry) => entry.rule),
    ).toEqual(["c", "d"]);
  });

  it("says nothing when the catch-all is last, which is the correct shape", () => {
    expect(
      unreachableRules([
        { id: "premium", when: 'user.claims.tier == "pro"' },
        { id: "catch-all", when: "true" },
      ]),
    ).toEqual([]);
  });

  it("prefers the name over the id, matching what logs show", () => {
    expect(
      unreachableRules([
        { id: "a", name: "everything", when: "true" },
        { id: "b", name: "premium clients", when: "false" },
      ]),
    ).toEqual([{ rule: "premium clients", shadowedBy: "everything" }]);
  });

  it("does not guess about a condition that merely happens to always hold", () => {
    // `1 == 1` is a catch-all in practice, but proving that needs an evaluator and
    // guessing would warn about rules that are working.
    expect(
      unreachableRules([
        { id: "a", when: "1 == 1" },
        { id: "b", when: "false" },
      ]),
    ).toEqual([]);
  });
});
