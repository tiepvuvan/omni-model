import {
  buildRequestFacts,
  ConfigError,
  interpolateDeep,
  OmniError,
  omniConfigSchema,
  type RuleEvaluation,
  type RuntimeContext,
  resolveSecretRefs,
  type ZodTypeLike,
} from "@omni-model/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminDeps } from "../deps.js";
import type { AdminEnv } from "../session.js";

/** One registered component type and the options it accepts. */
interface ComponentDescriptor {
  type: string;
  /** JSON Schema for the options, when the factory publishes its schema. */
  optionsSchema: unknown;
}

/**
 * Convert a factory's zod schema to JSON Schema.
 *
 * Returns null rather than throwing: a third-party factory may publish something
 * zod cannot represent as JSON Schema (a transform, a refinement on a union),
 * and one such component must not break the whole endpoint.
 */
function toJsonSchema(schema: ZodTypeLike | undefined): unknown {
  if (schema === undefined) return null;
  try {
    return z.toJSONSchema(schema as z.ZodType, { io: "input" });
  } catch {
    return null;
  }
}

function describe(
  registry: ReadonlyMap<string, { optionsSchema?: ZodTypeLike }>,
): ComponentDescriptor[] {
  return [...registry.entries()]
    .map(([type, factory]) => ({ type, optionsSchema: toJsonSchema(factory.optionsSchema) }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * Auth verifiers, each carrying the layer it belongs to.
 *
 * The layer is what lets the dashboard draw two sections — one required choice of
 * user authentication, any number of app attestation schemes over it — without
 * knowing the type names. A verifier added to the registry lands in the right half
 * on its own.
 */
function describeVerifiers(
  registry: ReadonlyMap<string, { optionsSchema?: ZodTypeLike; layer: "user" | "app" }>,
): (ComponentDescriptor & { layer: "user" | "app" })[] {
  return [...registry.entries()]
    .map(([type, factory]) => ({
      type,
      layer: factory.layer,
      optionsSchema: toJsonSchema(factory.optionsSchema),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

const simulateSchema = z.object({
  model: z.string().min(1),
  inputTokenCount: z.number().int().nonnegative().optional(),
  maxTokens: z.number().finite().nonnegative().optional(),
  temperature: z.number().finite().optional(),
  /** Claims the end user's token would carry. */
  claims: z.record(z.string(), z.unknown()).optional(),
  userId: z.string().optional(),
  providers: z.array(z.string().min(1)).optional(),
  clientName: z.string().optional(),
  ip: z.string().optional(),
  method: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Turn broken rules into sentences an operator can act on.
 *
 * These are the two CEL footguns, and both are silent in production: reading a
 * missing map key throws (so the rule never fires), and only a literal `true`
 * counts as a match (so `"true"` or a truthy value never fires either).
 */
/** A 400 in the shape the proxy's error handler renders. */
function badRequestError(message: string): OmniError {
  return new OmniError(400, message, { code: "invalid_request" });
}

function warningsFor(broken: readonly RuleEvaluation[]): string[] {
  return broken.map((rule) =>
    rule.outcome === "error"
      ? `rule "${rule.rule}" throws for this request and can therefore never match: ` +
        `${rule.error ?? "unknown error"}. Guard optional fields with has(), ` +
        'e.g. has(user.claims.plan) && user.claims.plan == "pro".'
      : `rule "${rule.rule}" returned ${rule.resultType ?? "a non-boolean"} rather than a ` +
        "boolean, and only a literal true counts as a match.",
  );
}

const modelsSchema = z.object({
  /** A candidate `routing.rules[].target`, not necessarily saved yet. */
  target: z.looseObject({ type: z.string().min(1) }),
});

export function createMetaRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  /**
   * List the models a candidate target can serve — and prove its credential works.
   *
   * The existing per-rule probe answers for the *applied* bundle, which is no use
   * while an operator is still typing a key: the point is to check it before it is
   * saved. So this builds a provider from the candidate target, asks the upstream,
   * and reports what it said.
   *
   * Two things make the answer trustworthy. The verdict comes from watching the
   * `fetch`, not from whether `listModels` resolved — that method deliberately falls
   * back to the configured model list on failure, so trusting its return value
   * would report a rejected key as a healthy upstream. And a `{"$secret": id}` in
   * the candidate is resolved first, so re-checking a rule whose key is already
   * sealed works without the operator retyping it.
   */
  app.post("/providers/models", async (c) => {
    const body = modelsSchema.parse(await c.req.json());
    const factory = deps.registry.providers.get(body.target.type);
    if (factory === undefined) {
      throw badRequestError(`unknown provider type "${body.target.type}"`);
    }

    // `${VAR}` from the environment, then `{"$secret": id}` from the keyring —
    // the same order `buildBundle` resolves them in.
    const interpolated = interpolateDeep(body.target, deps.runtime.env);
    const resolved = (await resolveSecretRefs(interpolated, deps.secrets ?? null)) as Record<
      string,
      unknown
    >;
    // `model` is the rule's choice of what to forward as, not a provider option;
    // the factories validate with `strictObject` and would reject it.
    const { model: _model, ...options } = resolved;

    let upstream: { ok: boolean; status?: number; error?: string } | null = null;
    const observed: RuntimeContext = {
      ...deps.runtime,
      fetch: async (...args: Parameters<typeof fetch>) => {
        try {
          const response = await deps.runtime.fetch(...args);
          upstream ??= { ok: response.ok, status: response.status };
          return response;
        } catch (error) {
          upstream ??= { ok: false, error: error instanceof Error ? error.message : String(error) };
          throw error;
        }
      },
    };

    let provider: { listModels?: (ctx: RuntimeContext) => Promise<{ id: string }[]> };
    try {
      provider = factory.create("candidate", options, deps.runtime);
    } catch (error) {
      // A `ConfigError` here is the operator's own input being wrong — a missing
      // base URL, a malformed key — which is a 400, not a 500.
      if (error instanceof ConfigError) throw badRequestError(error.message);
      throw error;
    }

    if (provider.listModels === undefined) {
      return c.json({
        ok: null,
        models: [],
        reason: "this provider type cannot list models",
      });
    }

    let models: string[] = [];
    try {
      models = (await provider.listModels(observed)).map((entry) => entry.id);
    } catch (error) {
      upstream ??= { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    // Always 200: "the upstream refused this key" is a successful answer to
    // "is this key good, and what can it serve".
    return c.json({
      ok: upstream === null ? null : upstream.ok,
      models: upstream?.ok === false ? [] : models,
      status: upstream?.status ?? null,
      error: upstream?.error ?? null,
      ...(upstream === null
        ? { reason: "this provider answers from configuration without contacting the upstream" }
        : {}),
    });
  });

  /**
   * What this build can be configured with.
   *
   * Publishing the factories' own schemas is what lets a dashboard render a form
   * per component type instead of hardcoding one for each — and means the form
   * cannot drift from what the factory actually accepts.
   */
  app.get("/meta", (c) => {
    return c.json({
      providers: describe(deps.registry.providers),
      authVerifiers: describeVerifiers(deps.registry.auth),
      storage: describe(deps.registry.storage),
      configSchema: toJsonSchema(omniConfigSchema as unknown as ZodTypeLike),
      secretsAvailable: deps.secrets !== null,
      logsAvailable: deps.pool !== null,
    });
  });

  /**
   * Evaluate a hypothetical request against the live routing rules.
   *
   * This exists because CEL has two footguns that are otherwise invisible until
   * production: reading a missing map key *throws*, and only a literal `true`
   * counts as a match. A rule with either problem silently never fires. Here the
   * operator sees which rule won, and which ones errored.
   */
  app.post("/routing/simulate", async (c) => {
    const bundle = deps.holder.current();
    if (bundle === null) throw new OmniError(503, "no configuration is applied");
    const body = simulateSchema.parse(await c.req.json());

    const facts = buildRequestFacts({
      method: body.method ?? "POST",
      path: body.path ?? "/v1/chat/completions",
      headers: new Headers(body.headers ?? {}),
      ip: body.ip ?? null,
      body: {
        model: body.model,
        ...(body.maxTokens === undefined ? {} : { max_tokens: body.maxTokens }),
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        messages: [{ role: "user" as const, content: "simulated" }],
      },
      identity:
        body.userId === undefined && body.claims === undefined && body.providers === undefined
          ? null
          : {
              provider: body.providers?.[0] ?? "simulated",
              providers: body.providers ?? ["simulated"],
              ...(body.userId === undefined ? {} : { userId: body.userId }),
              claims: body.claims ?? {},
            },
      writeKey:
        body.clientName === undefined
          ? null
          : {
              id: "00000000-0000-0000-0000-000000000000",
              name: body.clientName,
              prefix: "omk_simulated",
              last4: "sim0",
              allowedModels: null,
              captureContent: null,
              metadata: {},
              createdBy: null,
              createdAt: 0,
              expiresAt: null,
              disabledAt: null,
            },
      ...(body.inputTokenCount === undefined ? {} : { inputTokenCount: body.inputTokenCount }),
    });

    // Rule by rule, including the ones that threw — `resolve` swallows those as
    // "no match", which is right for serving traffic and useless for debugging.
    const rules = bundle.router.explain(facts);
    const broken = rules.filter(
      (rule) => rule.outcome === "error" || rule.outcome === "non-boolean",
    );

    try {
      const decision = bundle.router.resolve(facts);
      return c.json({
        matched: true,
        route: decision.routeName,
        provider: decision.providerType,
        model: decision.model,
        rules,
        warnings: warningsFor(broken),
        facts,
      });
    } catch (error) {
      // A 404 from the router means "nothing would serve this", which is a
      // legitimate simulation result rather than a failure of the endpoint.
      const status = error instanceof OmniError ? error.status : 500;
      if (status !== 404) throw error;
      return c.json({
        matched: false,
        reason: error instanceof Error ? error.message : String(error),
        rules,
        warnings: warningsFor(broken),
        facts,
      });
    }
  });

  return app;
}
