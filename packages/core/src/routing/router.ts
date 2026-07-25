import type { RoutingConfig } from "../config/schema.js";
import { ConfigError, OmniError } from "../errors.js";
import type { Logger } from "../types.js";
import type {
  CompiledExpression,
  ExpressionEngine,
  RequestFacts,
  RouteDecision,
  Router,
  RuleEvaluation,
} from "./types.js";

/** A route or model rule with its `when`/`match` expression compiled. */
interface CompiledRule {
  when: CompiledExpression;
  providerId: string;
  /** Upstream model override; undefined keeps the client-requested model. */
  model: string | undefined;
  routeName: string;
  /** The non-boolean-result warning fires once per rule, not once per request. */
  warnedNonBoolean: boolean;
}

function compileRule(engine: ExpressionEngine, source: string, where: string): CompiledExpression {
  try {
    return engine.compile(source);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${where}: ${error.message}`);
    }
    throw error;
  }
}

function assertKnownProvider(
  providerId: string,
  providerIds: ReadonlySet<string>,
  where: string,
): void {
  if (providerIds.has(providerId)) return;
  const known = providerIds.size === 0 ? "none are configured" : [...providerIds].sort().join(", ");
  throw new ConfigError(
    `${where} references unknown provider "${providerId}" (known providers: ${known})`,
  );
}

/**
 * Build the request router from validated routing config. All `when`/`match`
 * expressions are compiled and all provider references are checked up front,
 * so config mistakes throw `ConfigError` at startup rather than mid-request.
 *
 * `resolve` evaluates rules in order — `routes`, then `modelRules`, then
 * `defaultProvider` — and picks the first whose condition is exactly `true`.
 * A condition that throws (e.g. a missing claim key in CEL) or yields a
 * non-boolean is treated as no match, so one bad expression cannot take the
 * proxy down; non-boolean results are logged once per rule as a config smell.
 */
export function createRouter(
  config: RoutingConfig,
  providerIds: ReadonlySet<string>,
  engine: ExpressionEngine,
  log?: Logger,
): Router {
  const rules: CompiledRule[] = [];
  const allowedModels = new Set(config.allowedModels);

  config.routes.forEach((route, index) => {
    const where = `routing.routes[${index}] ("${route.name}")`;
    assertKnownProvider(route.provider, providerIds, where);
    rules.push({
      when: compileRule(engine, route.when, `${where} when`),
      providerId: route.provider,
      model: route.model,
      routeName: route.name,
      warnedNonBoolean: false,
    });
  });

  config.modelRules.forEach((rule, index) => {
    const where = `routing.modelRules[${index}]`;
    assertKnownProvider(rule.provider, providerIds, where);
    rules.push({
      when: compileRule(engine, rule.match, `${where} match`),
      providerId: rule.provider,
      model: rule.model,
      routeName: `model-rule[${index}]`,
      warnedNonBoolean: false,
    });
  });

  const defaultProvider = config.defaultProvider;
  if (defaultProvider !== undefined) {
    assertKnownProvider(defaultProvider, providerIds, "routing.defaultProvider");
  }

  /** The CEL variable namespaces. Shared so `explain` cannot drift from `resolve`. */
  const varsFor = (facts: RequestFacts): Record<string, unknown> => ({
    request: facts.request,
    user: facts.user,
    device: facts.device,
    client: facts.client,
    http: facts.http,
    now: facts.now,
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
            providerId: rule.providerId,
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

      if (defaultProvider !== undefined) {
        return { providerId: defaultProvider, model: facts.request.model, routeName: null };
      }

      throw new OmniError(
        404,
        `The model \`${facts.request.model}\` does not exist or no route is configured to serve it.`,
        { code: "model_not_found", param: "model" },
      );
    },

    explain(facts: RequestFacts): RuleEvaluation[] {
      const vars = varsFor(facts);
      const evaluations: RuleEvaluation[] = [];
      for (const rule of rules) {
        const base = { rule: rule.routeName, providerId: rule.providerId };
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
