import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnvironmentConfig } from "../../src/config/env.js";
import { parseConfigObject } from "../../src/config/load.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";

/**
 * Regression tests guarding the accuracy of the shipped documentation and
 * example configuration against the real zod schema and CEL engine. The docs
 * live in `docs/` as a Mintlify site (MDX); these tests scan every page so a
 * broken CEL snippet or unparseable config example fails CI instead of the
 * reader's runtime.
 */

const repoUrl = (rel: string): URL => new URL(`../../../../${rel}`, import.meta.url);
const repoFile = (rel: string): string => readFileSync(fileURLToPath(repoUrl(rel)), "utf8");

/** Every `.mdx` file under `docs/`, recursively. */
function docsPages(): string[] {
  const root = fileURLToPath(repoUrl("docs"));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => readFileSync(`${root}/${name}`, "utf8"));
}

const engine = new CelExpressionEngine();

/** The variables a request exposes to CEL, with a user that carries no claims. */
const facts = {
  request: {
    model: "smart",
    stream: false,
    messageCount: 3,
    maxTokens: null,
    temperature: null,
    user: null,
  },
  user: { id: null, authenticated: false, provider: null, claims: {} as Record<string, unknown> },
  device: { id: null },
  http: {
    method: "POST",
    path: "/v1/chat/completions",
    ip: null,
    headers: {} as Record<string, string>,
  },
  now: 1_700_000_000_000,
};

/** Env used when parsing doc/example configs that reference `${VAR}` secrets. */
const TEST_ENV = {
  OPENAI_API_KEY: "sk-test",
  ANTHROPIC_API_KEY: "sk-test",
  GEMINI_API_KEY: "sk-test",
  REDIS_URL: "redis://localhost:6379",
  // Referenced by the documented local-development verifier.
  OMNI_DEV_SECRET: "dev-secret",
  OMNI_JWT_SECRET: "cloud-run-jwt-secret",
  DATABASE_URL: "postgres://localhost/omni",
  SUPABASE_JWT_SECRET: "secret",
};

describe("environment configuration examples", () => {
  const config = parseEnvironmentConfig({
    ...TEST_ENV,
    OMNI_CONFIG_JSON: JSON.stringify({
      version: 1,
      storage: { type: "memory" },
      security: {
        providers: [{ type: "jwt", secret: "$" + "{OMNI_JWT_SECRET}", algorithms: ["HS256"] }],
      },
      rateLimits: [
        {
          name: "free-tier",
          when: 'has(user.claims.tier) && user.claims.tier == "free"',
          key: "user",
          requests: { limit: 60, window: "1m" },
        },
      ],
      providers: { openai: { type: "openai", apiKey: "$" + "{OPENAI_API_KEY}" } },
      routing: {
        routes: [
          {
            name: "smart",
            when: 'request.model == "smart"',
            provider: "openai",
            model: "gpt-4o-mini",
          },
        ],
        defaultProvider: "openai",
      },
    }),
  });

  it("parses against the real schema", () => {
    expect(config.version).toBe(1);
  });

  it("every CEL expression evaluates without throwing for a user with no claims", () => {
    const expressions: string[] = [];
    for (const rule of config.rateLimits) {
      if (rule.when !== undefined) expressions.push(rule.when);
      if (rule.keyExpression !== undefined) expressions.push(rule.keyExpression);
    }
    for (const route of config.routing.routes) expressions.push(route.when);
    for (const rule of config.routing.modelRules) expressions.push(rule.match);

    expect(expressions.length).toBeGreaterThan(0);
    for (const expr of expressions) {
      const compiled = engine.compile(expr);
      expect(() => compiled.evaluate(facts), expr).not.toThrow();
    }
  });
});

describe("inline CEL snippets in README.md and the docs pages", () => {
  it("every `when:`/`match:` expression evaluates without throwing for a user with no claims", () => {
    const sources = [repoFile("README.md"), ...docsPages()].join("\n");
    const yamlExpressions = [...sources.matchAll(/\b(?:when|match):\s*'([^']*)'/g)].map(
      ([, expression]) => expression as string,
    );
    const jsonExpressions = [
      ...sources.matchAll(/"(?:when|match)"\s*:\s*("(?:\\.|[^"\\])*")/g),
    ].map(([, encoded]) => JSON.parse(encoded as string) as string);
    const expressions = [...yamlExpressions, ...jsonExpressions];
    expect(expressions.length).toBeGreaterThan(0);
    for (const expr of expressions) {
      const compiled = engine.compile(expr);
      expect(() => compiled.evaluate(facts), expr).not.toThrow();
    }
  });
});

describe("the documented CEL `now` example", () => {
  it("evaluates to a boolean without throwing", () => {
    const sources = docsPages().join("\n");
    const match = sources.match(/(?:`|^)\s*(now\s*<\s*\d+)/m);
    expect(match, "could not find a documented `now < …` example").not.toBeNull();
    const expr = (match as RegExpMatchArray)[1];
    const result = engine.compile(expr).evaluate(facts);
    expect(typeof result, `expression: ${expr}`).toBe("boolean");
  });

  it("a modulo expression on `now` throws (guard: it must not be documented)", () => {
    // `now` is a double, and CEL's `%` has no `double % int` overload.
    const compiled = engine.compile("now % 86400000 < 43200000");
    expect(() => compiled.evaluate(facts)).toThrow();
  });
});

describe("full config examples in the reference page parse", () => {
  it("documents every environment configuration shape", () => {
    const md = repoFile("docs/reference/configuration.mdx");
    for (const variable of [
      "OMNI_CONFIG_JSON",
      "OMNI_SERVER_JSON",
      "OMNI_STORAGE_JSON",
      "OMNI_SECURITY_JSON",
      "OMNI_SECURITY_PROVIDERS_JSON",
      "OMNI_RATE_LIMITS_JSON",
      "OMNI_PROVIDERS_JSON",
      "OMNI_ROUTING_JSON",
      "OMNI__",
    ]) {
      expect(md).toContain(variable);
    }
  });

  it("`storage: {}` fails validation because storage needs a `type`", () => {
    expect(() => parseConfigObject({ version: 1, storage: {} })).toThrow(/storage\.type/);
  });
});

describe("the Cloud Run production configuration", () => {
  it("uses environment variables for Firestore storage and JWT authentication", () => {
    const cloudRunPage = repoFile("docs/installation/cloud-run.mdx");
    expect(cloudRunPage).toContain("OMNI__STORAGE__TYPE=firestore");
    expect(cloudRunPage).toContain("OMNI__SECURITY__PROVIDERS__0__TYPE=jwt");

    const config = parseEnvironmentConfig({
      ...TEST_ENV,
      OMNI__STORAGE__TYPE: "firestore",
      OMNI__STORAGE__COLLECTION: "omni_ratelimits",
      OMNI__SECURITY__PROVIDERS__0__TYPE: "jwt",
      OMNI__SECURITY__PROVIDERS__0__SECRET: "$" + "{OMNI_JWT_SECRET}",
      OMNI__SECURITY__PROVIDERS__0__ALGORITHMS: '["HS256"]',
      OMNI__PROVIDERS__OPENAI__TYPE: "openai",
      OMNI__PROVIDERS__OPENAI__API_KEY: "$" + "{OPENAI_API_KEY}",
      OMNI__RATE_LIMITS__0__NAME: "per-user-requests",
      OMNI__RATE_LIMITS__0__KEY: "user",
      OMNI__RATE_LIMITS__0__REQUESTS__LIMIT: "60",
      OMNI__RATE_LIMITS__0__REQUESTS__WINDOW: "1m",
      OMNI__ROUTING__DEFAULT_PROVIDER: "openai",
    });
    expect(config.storage.type).toBe("firestore");
    expect(config.security.providers).toMatchObject([{ type: "jwt" }]);
  });
});
