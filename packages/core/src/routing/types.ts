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
 * docs/configuration.md — keep the two in sync when changing this shape.
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

export interface Router {
  /** Throws `OmniError` (404 model_not_found) when nothing can serve the request. */
  resolve(facts: RequestFacts): RouteDecision;
}
