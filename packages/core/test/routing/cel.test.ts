import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/errors.js";
import { CelExpressionEngine } from "../../src/routing/cel.js";

describe("CelExpressionEngine", () => {
  const engine = new CelExpressionEngine();

  it('is named "cel"', () => {
    expect(engine.name).toBe("cel");
  });

  it("compiles and evaluates boolean expressions", () => {
    expect(engine.compile("1 < 2").evaluate({})).toBe(true);
    expect(engine.compile("true && false").evaluate({})).toBe(false);
    expect(engine.compile("request.stream").evaluate({ request: { stream: true } })).toBe(true);
  });

  it("supports string operations: startsWith and contains", () => {
    const startsWith = engine.compile('request.model.startsWith("gpt-")');
    expect(startsWith.evaluate({ request: { model: "gpt-4o" } })).toBe(true);
    expect(startsWith.evaluate({ request: { model: "claude-3-opus" } })).toBe(false);

    const contains = engine.compile('http.path.contains("/chat/")');
    expect(contains.evaluate({ http: { path: "/v1/chat/completions" } })).toBe(true);
    expect(contains.evaluate({ http: { path: "/v1/embeddings" } })).toBe(false);
  });

  it("supports the has() macro for optional keys", () => {
    const compiled = engine.compile("has(user.claims.tier)");
    expect(compiled.evaluate({ user: { claims: { tier: "pro" } } })).toBe(true);
    expect(compiled.evaluate({ user: { claims: {} } })).toBe(false);
  });

  it('supports the "in" operator on maps', () => {
    const compiled = engine.compile('"tier" in user.claims');
    expect(compiled.evaluate({ user: { claims: { tier: "pro" } } })).toBe(true);
    expect(compiled.evaluate({ user: { claims: {} } })).toBe(false);
  });

  it("supports numeric comparison on now", () => {
    const compiled = engine.compile("now > 1700000000000");
    expect(compiled.evaluate({ now: 1700000000001 })).toBe(true);
    expect(compiled.evaluate({ now: 1699999999999 })).toBe(false);
  });

  it("throws ConfigError with the source on a syntax error", () => {
    expect(() => engine.compile("&&&")).toThrow(ConfigError);
    expect(() => engine.compile("&&&")).toThrow(/"&&&"/);
    expect(() => engine.compile("request.model ==")).toThrow(ConfigError);
  });

  it("propagates runtime errors such as missing map keys", () => {
    const compiled = engine.compile('user.claims.tier == "pro"');
    expect(() => compiled.evaluate({ user: { claims: {} } })).toThrow(/No such key/);
  });

  it("returns a reusable compiled expression", () => {
    const compiled = engine.compile('user.claims.tier == "pro"');
    expect(compiled.evaluate({ user: { claims: { tier: "pro" } } })).toBe(true);
    expect(compiled.evaluate({ user: { claims: { tier: "free" } } })).toBe(false);
  });
});
