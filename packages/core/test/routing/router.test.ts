import { describe, expect, it } from "vitest";
import type { RoutingConfig } from "../../src/config/schema.js";
import { ConfigError, OmniError } from "../../src/errors.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";
import { createRouter } from "../../src/routing/router.js";
import type { RequestFacts } from "../../src/routing/types.js";
import type { Logger } from "../../src/types.js";

const engine = new CelExpressionEngine();
const providerIds: ReadonlySet<string> = new Set(["openai", "anthropic"]);

function makeFacts(overrides?: {
  model?: string;
  claims?: Record<string, unknown>;
  path?: string;
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

function config(partial: Partial<RoutingConfig>): RoutingConfig {
  return { routes: [], modelRules: [], ...partial };
}

describe("createRouter", () => {
  it("picks the first matching route (first match wins)", () => {
    const router = createRouter(
      config({
        routes: [
          { name: "first", when: 'request.model == "gpt-4o"', provider: "openai" },
          { name: "second", when: 'request.model == "gpt-4o"', provider: "anthropic" },
        ],
      }),
      providerIds,
      engine,
    );
    expect(router.resolve(makeFacts())).toEqual({
      providerId: "openai",
      model: "gpt-4o",
      routeName: "first",
    });
  });

  it("applies the route model override, or passes the requested model through", () => {
    const router = createRouter(
      config({
        routes: [
          {
            name: "override",
            when: 'http.path.contains("cheap")',
            provider: "openai",
            model: "gpt-4o-mini",
          },
          { name: "passthrough", when: "true", provider: "openai" },
        ],
      }),
      providerIds,
      engine,
    );
    expect(router.resolve(makeFacts({ path: "/cheap/v1/chat" })).model).toBe("gpt-4o-mini");
    expect(router.resolve(makeFacts()).model).toBe("gpt-4o");
  });

  it("treats a throwing when-condition as no match and falls through to model rules", () => {
    const { log, calls } = makeSpyLogger();
    const router = createRouter(
      config({
        // Missing key access throws in CEL when claims is empty.
        routes: [{ name: "pro-users", when: 'user.claims.tier == "pro"', provider: "anthropic" }],
        modelRules: [{ match: 'request.model.startsWith("gpt-")', provider: "openai" }],
      }),
      providerIds,
      engine,
      log,
    );
    const decision = router.resolve(makeFacts({ claims: {} }));
    expect(decision).toEqual({ providerId: "openai", model: "gpt-4o", routeName: "model-rule[0]" });
    const debugCalls = calls.filter((c) => c.level === "debug");
    expect(debugCalls).toHaveLength(1);
    expect(debugCalls[0]?.fields?.rule).toBe("pro-users");

    // The same route still matches when the claim is present.
    expect(router.resolve(makeFacts({ claims: { tier: "pro" } })).providerId).toBe("anthropic");
  });

  it("skips a non-boolean when-result and warns once per route", () => {
    const { log, calls } = makeSpyLogger();
    const router = createRouter(
      config({
        routes: [{ name: "bad-expr", when: "request.model", provider: "anthropic" }],
        defaultProvider: "openai",
      }),
      providerIds,
      engine,
      log,
    );
    expect(router.resolve(makeFacts()).providerId).toBe("openai");
    expect(router.resolve(makeFacts()).providerId).toBe("openai");
    const warns = calls.filter((c) => c.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields?.rule).toBe("bad-expr");
  });

  it("matches model rules, honoring their model override", () => {
    const router = createRouter(
      config({
        modelRules: [
          { match: 'request.model.startsWith("claude-")', provider: "anthropic" },
          { match: 'request.model.startsWith("gpt-")', provider: "openai", model: "gpt-4o-mini" },
        ],
      }),
      providerIds,
      engine,
    );
    expect(router.resolve(makeFacts({ model: "claude-3-opus" }))).toEqual({
      providerId: "anthropic",
      model: "claude-3-opus",
      routeName: "model-rule[0]",
    });
    expect(router.resolve(makeFacts({ model: "gpt-4o" }))).toEqual({
      providerId: "openai",
      model: "gpt-4o-mini",
      routeName: "model-rule[1]",
    });
  });

  it("falls back to defaultProvider with a null routeName", () => {
    const router = createRouter(config({ defaultProvider: "openai" }), providerIds, engine);
    expect(router.resolve(makeFacts({ model: "some-model" }))).toEqual({
      providerId: "openai",
      model: "some-model",
      routeName: null,
    });
  });

  it("restricts client model names when an allowlist is configured", () => {
    const router = createRouter(
      config({ allowedModels: ["smart"], defaultProvider: "openai" }),
      providerIds,
      engine,
    );

    expect(router.resolve(makeFacts({ model: "smart" })).providerId).toBe("openai");
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

  it("throws OmniError 404 model_not_found when nothing matches", () => {
    const router = createRouter(config({}), providerIds, engine);
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

  it("throws ConfigError at build time for an unknown route provider, listing known ids", () => {
    const build = (): unknown =>
      createRouter(
        config({ routes: [{ name: "r", when: "true", provider: "does-not-exist" }] }),
        providerIds,
        engine,
      );
    expect(build).toThrow(ConfigError);
    expect(build).toThrow(/does-not-exist/);
    expect(build).toThrow(/anthropic, openai/);
  });

  it("throws ConfigError for unknown modelRule and defaultProvider providers", () => {
    expect(() =>
      createRouter(
        config({ modelRules: [{ match: "true", provider: "nope" }] }),
        providerIds,
        engine,
      ),
    ).toThrow(ConfigError);
    expect(() => createRouter(config({ defaultProvider: "nope" }), providerIds, engine)).toThrow(
      /routing\.defaultProvider/,
    );
  });

  it("throws ConfigError at build time for an invalid when-expression, naming the route", () => {
    const build = (): unknown =>
      createRouter(
        config({ routes: [{ name: "broken", when: "&&&", provider: "openai" }] }),
        providerIds,
        engine,
      );
    expect(build).toThrow(ConfigError);
    expect(build).toThrow(/broken/);
  });
});
