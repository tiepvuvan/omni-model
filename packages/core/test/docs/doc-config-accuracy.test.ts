import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";

/**
 * Regression tests guarding the accuracy of the shipped documentation and
 * example configuration against the real zod schema and CEL engine. Each block
 * mirrors a confirmed doc/config-accuracy defect: a broken snippet that
 * throws/fails validation at runtime even though the docs present it as valid.
 */

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");

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

describe("examples/omni.yaml", () => {
  const config = parseConfig(repoFile("examples/omni.yaml"), {
    OPENAI_API_KEY: "sk-test",
    ANTHROPIC_API_KEY: "sk-test",
    GEMINI_API_KEY: "sk-test",
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

describe("inline CEL snippets in README.md and docs/configuration.md", () => {
  it("every `when:`/`match:` expression evaluates without throwing for a user with no claims", () => {
    const sources = [repoFile("README.md"), repoFile("docs/configuration.md")].join("\n");
    const matches = [...sources.matchAll(/\b(?:when|match):\s*'([^']*)'/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const [, expr] of matches) {
      const compiled = engine.compile(expr);
      expect(() => compiled.evaluate(facts), expr).not.toThrow();
    }
  });
});

describe("docs/configuration.md CEL `now` example", () => {
  it("the documented `now` example expression evaluates to a boolean without throwing", () => {
    const md = repoFile("docs/configuration.md");
    const row = md.match(/\|\s*`now`\s*\|[^|]*\|[^|]*\|\s*`([^`]+)`\s*\|/);
    expect(row, "could not find the `now` row in the CEL context table").not.toBeNull();
    const expr = (row as RegExpMatchArray)[1];
    const result = engine.compile(expr).evaluate(facts);
    expect(typeof result, `expression: ${expr}`).toBe("boolean");
  });

  it("a modulo expression on `now` throws (guard: it must not be documented)", () => {
    // `now` is a double, and CEL's `%` has no `double % int` overload.
    const compiled = engine.compile("now % 86400000 < 43200000");
    expect(() => compiled.evaluate(facts)).toThrow();
  });
});

describe("docs/configuration.md top-level skeleton", () => {
  it("the documented top-level skeleton parses against the real schema", () => {
    const md = repoFile("docs/configuration.md");
    const block = md.match(/Top-level keys:\s*```yaml\n([\s\S]*?)```/);
    expect(block, "could not find the top-level skeleton yaml block").not.toBeNull();
    const skeleton = (block as RegExpMatchArray)[1];
    expect(() => parseConfig(skeleton)).not.toThrow();
  });

  it("`storage: {}` fails validation because storage needs a `type`", () => {
    expect(() => parseConfig("version: 1\nstorage: {}\n")).toThrow(/storage\.type/);
  });
});
