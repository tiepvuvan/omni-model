/** A compiled, reusable expression. */
export interface CompiledExpression {
  /** Evaluate against the given variables; may throw on runtime errors. */
  evaluate(vars: Record<string, unknown>): unknown;
}

/**
 * Pluggable expression language. The built-in engine is CEL
 * (Common Expression Language); alternatives can be registered by embedders.
 */
export interface ExpressionEngine {
  readonly name: string;
  /** Compile `source`. Throws `ConfigError` on syntax errors (validated at startup). */
  compile(source: string): CompiledExpression;
}

/**
 * Variables exposed to routing and rate-limit expressions. Documented in
 * docs/reference/configuration.mdx — keep the two in sync when changing this
 * shape, and remember the fact set is built in three places that must agree:
 * `buildRequestFacts`, the limiter's `varsFrom`, and the router's `vars`. Adding
 * a namespace to only some of them makes CEL throw on a missing key at
 * evaluation time, which surfaces as a rule that silently never matches.
 */
export interface RequestFacts {
  request: {
    model: string;
    stream: boolean;
    messageCount: number;
    maxTokens: number | null;
    temperature: number | null;
    user: string | null;
  };
  user: {
    id: string | null;
    authenticated: boolean;
    /** Auth verifier type that authenticated the request. */
    provider: string | null;
    claims: Record<string, unknown>;
  };
  device: { id: string | null };
  /**
   * The calling application, identified by its write key — a different question
   * from `user`, which is who is using that application.
   */
  client: {
    /** Write key id, or null when no key was presented. */
    id: string | null;
    /** Write key name, for readable expressions: `client.name == "ios-app"`. */
    name: string | null;
    authenticated: boolean;
  };
  http: {
    method: string;
    path: string;
    ip: string | null;
    /** Lowercased header names. `authorization` and cookie values are redacted. */
    headers: Record<string, string>;
  };
  /** Epoch milliseconds. */
  now: number;
}

export interface RouteDecision {
  providerId: string;
  /** Final upstream model (route override or the client-requested model). */
  model: string;
  /** Matched route / model-rule name; null when the default provider was used. */
  routeName: string | null;
}

/** What one rule did when evaluated against a set of facts. */
export interface RuleEvaluation {
  /** Route name, or `model-rule[n]` for a model rule. */
  rule: string;
  providerId: string;
  /** `"match"` wins; the others are why it did not. */
  outcome: "match" | "no-match" | "error" | "non-boolean";
  /** Why it threw, for `"error"`. */
  error?: string;
  /** What it returned, for `"non-boolean"`. */
  resultType?: string;
}

export interface Router {
  /** Throws `OmniError` (404 model_not_found) when nothing can serve the request. */
  resolve(facts: RequestFacts): RouteDecision;
  /**
   * Evaluate every rule against `facts` and report what each one did.
   *
   * `resolve` deliberately treats a rule that throws as "no match", because one
   * broken condition must not 500 every request — which also makes the breakage
   * invisible. This reports it instead, using the same compiled expressions, so
   * an operator can be told that a rule never fires and why. It has no effect on
   * the decision and never throws.
   */
  explain(facts: RequestFacts): RuleEvaluation[];
}
