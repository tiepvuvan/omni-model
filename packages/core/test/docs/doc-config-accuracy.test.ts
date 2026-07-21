import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
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

describe("examples/omni.yaml", () => {
  const config = parseConfig(repoFile("examples/omni.yaml"), TEST_ENV);

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
    const matches = [...sources.matchAll(/\b(?:when|match):\s*'([^']*)'/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, expr] of matches) {
      const compiled = engine.compile(expr);
      expect(() => compiled.evaluate(facts), expr).not.toThrow();
    }
  });
});

describe("the documented CEL `now` example", () => {
  it("evaluates to a boolean without throwing", () => {
    const sources = docsPages().join("\n");
    const match = sources.match(/`(now\s*<[^`]*)`/);
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
  it("every top-level YAML config block validates against the real schema", () => {
    const md = repoFile("docs/reference/configuration.mdx");
    const blocks = [...md.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    // Blocks that are whole configs (declare `version:` or `storage:` at column 0).
    const configs = blocks.filter((b) => /^version:/m.test(b) || /^storage:/m.test(b));
    expect(configs.length).toBeGreaterThan(0);
    for (const yaml of configs) {
      expect(() => parseConfig(yaml, TEST_ENV), yaml.slice(0, 60)).not.toThrow();
    }
  });

  it("`storage: {}` fails validation because storage needs a `type`", () => {
    expect(() => parseConfig("version: 1\nstorage: {}\n")).toThrow(/storage\.type/);
  });
});

describe("the Cloud Run production configuration", () => {
  it("parses with Firestore storage and JWT authentication", () => {
    const cloudRunPage = repoFile("docs/installation/cloud-run.mdx");
    const blocks = [...cloudRunPage.matchAll(/```ya?ml\n([\s\S]*?)```/g)].map((match) => match[1]);
    const configYaml = blocks.find(
      (block) => block.includes("type: firestore") && block.includes("$" + "{OMNI_JWT_SECRET}"),
    );
    expect(configYaml, "could not find the Cloud Run Firestore config example").toBeDefined();
    if (configYaml === undefined) throw new Error("Cloud Run config example missing");

    const config = parseConfig(configYaml, TEST_ENV);
    expect(config.storage.type).toBe("firestore");
    expect(config.security.providers).toMatchObject([{ type: "jwt" }]);
  });
});
