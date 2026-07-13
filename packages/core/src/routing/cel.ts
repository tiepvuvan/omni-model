import { ParseError, parse } from "@marcbachmann/cel-js";
import { ConfigError } from "../errors.js";
import type { CompiledExpression, ExpressionEngine } from "./types.js";

/**
 * The built-in `ExpressionEngine`, backed by CEL (Common Expression Language)
 * via `@marcbachmann/cel-js`. Expressions are parsed once at compile time and
 * the resulting program is reused for every evaluation.
 *
 * CEL semantics worth knowing when writing config expressions:
 * - Accessing a missing map key **throws** at evaluation time (`No such key`),
 *   it does not yield `null`. Guard optional fields with the `has()` macro,
 *   e.g. `has(user.claims.tier) && user.claims.tier == "pro"`, or with the
 *   `in` operator, e.g. `"tier" in user.claims`.
 * - Only the boolean `true` counts as a match for routing/rate-limit `when`
 *   conditions; write comparisons, not bare values.
 */
export class CelExpressionEngine implements ExpressionEngine {
  readonly name = "cel";

  /**
   * Parse `source` into a reusable compiled expression.
   * Throws `ConfigError` on CEL syntax errors; runtime evaluation errors
   * (e.g. missing map keys) propagate from `evaluate` so callers decide policy.
   */
  compile(source: string): CompiledExpression {
    let program: (context?: Record<string, unknown>) => unknown;
    try {
      program = parse(source);
    } catch (error) {
      if (error instanceof ParseError) {
        throw new ConfigError(`invalid CEL expression ${JSON.stringify(source)}: ${error.summary}`);
      }
      throw error;
    }
    return {
      evaluate: (vars) => program(vars),
    };
  }
}
