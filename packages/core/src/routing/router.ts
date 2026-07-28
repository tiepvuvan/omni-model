import { ConfigError, OmniError } from "../errors.js";
import type { ChatProvider } from "../providers/types.js";
import type { Logger } from "../types.js";
import type {
  CompiledExpression,
  ExpressionEngine,
  RequestFacts,
  RouteDecision,
  Router,
  RuleEvaluation,
} from "./types.js";

/**
 * One rule, ready to evaluate: its condition compiled and its upstream built.
 *
 * The provider instance is *in* the rule rather than looked up by name when the
 * rule matches. That is what removes the "unknown provider" error class — there
 * is no name, so there is nothing to dangle — and it means a matched rule cannot
 * fail to find where it was pointing.
 */
export interface CompiledRoutingRule {
  when: CompiledExpression;
  /** Label for logs; the rule's `name`, else its id. */
  routeName: string;
  provider: ChatProvider;
  /** Provider type, recorded per request for usage attribution. */
  providerType: string;
  /** Upstream model override; undefined forwards the client-requested model. */
  model: string | undefined;
  /** The non-boolean-result warning fires once per rule, not once per request. */
  warnedNonBoolean: boolean;
}

export interface CreateRouterOptions {
  /** Client-facing names that may be requested. Empty means no restriction. */
  allowedModels?: readonly string[];
  log?: Logger;
}

/**
 * Rules that can never fire because an earlier one matches everything.
 *
 * Adding a rule to a list that already ends in a catch-all appends it *after*
 * that catch-all, where first-match-wins means it is dead on arrival. Nothing
 * about the request reveals this — the proxy answers normally, from the wrong
 * rule — so it has to be pointed out statically.
 *
 * Only a literal `true` counts as a catch-all. A condition that happens to be
 * true for every real request is not detectable here, and guessing would produce
 * false warnings about rules that are working.
 */
export function unreachableRules(
  rules: ReadonlyArray<{ when: string; id?: string | undefined; name?: string | undefined }>,
): { rule: string; shadowedBy: string }[] {
  const label = (rule: { id?: string | undefined; name?: string | undefined }, index: number) =>
    rule.name ?? rule.id ?? `rules[${index}]`;
  const catchAll = rules.findIndex((rule) => rule.when.trim() === "true");
  if (catchAll === -1) return [];
  return rules.slice(catchAll + 1).map((rule, offset) => ({
    rule: label(rule, catchAll + 1 + offset),
    shadowedBy: label(rules[catchAll] as { id?: string; name?: string }, catchAll),
  }));
}

/** Compile one `when` expression, naming where it came from on failure. */
export function compileRoutingExpression(
  engine: ExpressionEngine,
  source: string,
  where: string,
): CompiledExpression {
  try {
    return engine.compile(source);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${where}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Build the request router from rules whose upstreams are already constructed.
 *
 * `resolve` evaluates rules in order and picks the first whose condition is
 * exactly `true`. A condition that throws (a missing claim key, in CEL) or
 * yields a non-boolean counts as no match, so one bad expression cannot take the
 * proxy down; non-boolean results are logged once per rule as a config smell.
 * `explain` is how an operator sees those otherwise-silent failures.
 *
 * With no rule matching, the request is a 404: there is no implicit default, and
 * a catch-all is a last rule with `when: "true"`.
 */
export function createRouter(
  rules: readonly CompiledRoutingRule[],
  options: CreateRouterOptions = {},
): Router {
  const allowedModels = new Set(options.allowedModels ?? []);
  const log = options.log;

  /** The CEL variable namespaces. Shared so `explain` cannot drift from `resolve`. */
  const varsFor = (facts: RequestFacts): Record<string, unknown> => ({
    request: facts.request,
    user: facts.user,
    client: facts.client,
    http: facts.http,
  });

  return {
    resolve(facts: RequestFacts): RouteDecision {
      if (allowedModels.size > 0 && allowedModels.has(facts.request.model) === false) {
        throw new OmniError(
          404,
          `The model \`${facts.request.model}\` is not available for this deployment.`,
          { code: "model_not_found", param: "model" },
        );
      }

      const vars = varsFor(facts);

      for (const rule of rules) {
        let result: unknown;
        try {
          result = rule.when.evaluate(vars);
        } catch (error) {
          log?.debug("routing condition threw; treating as no match", {
            rule: rule.routeName,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (result === true) {
          return {
            provider: rule.provider,
            providerType: rule.providerType,
            model: rule.model ?? facts.request.model,
            routeName: rule.routeName,
          };
        }
        if (typeof result !== "boolean" && !rule.warnedNonBoolean) {
          rule.warnedNonBoolean = true;
          log?.warn("routing condition returned a non-boolean result; treating as no match", {
            rule: rule.routeName,
            resultType: typeof result,
          });
        }
      }

      throw new OmniError(
        404,
        rules.length === 0
          ? "no routing rules are configured, so nothing can be served yet"
          : `The model \`${facts.request.model}\` does not exist or no rule is configured to serve it.`,
        { code: "model_not_found", param: "model" },
      );
    },

    explain(facts: RequestFacts): RuleEvaluation[] {
      const vars = varsFor(facts);
      const evaluations: RuleEvaluation[] = [];
      for (const rule of rules) {
        const base = { rule: rule.routeName, providerType: rule.providerType };
        try {
          const result = rule.when.evaluate(vars);
          if (result === true) {
            evaluations.push({ ...base, outcome: "match" });
            // Later rules never run, so reporting them would be a lie.
            break;
          }
          evaluations.push(
            typeof result === "boolean"
              ? { ...base, outcome: "no-match" }
              : { ...base, outcome: "non-boolean", resultType: typeof result },
          );
        } catch (error) {
          evaluations.push({
            ...base,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return evaluations;
    },
  };
}
