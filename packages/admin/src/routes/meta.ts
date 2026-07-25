import {
  buildRequestFacts,
  OmniError,
  omniConfigSchema,
  type RuleEvaluation,
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

const simulateSchema = z.object({
  model: z.string().min(1),
  stream: z.boolean().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  /** Claims the end user's token would carry. */
  claims: z.record(z.string(), z.unknown()).optional(),
  userId: z.string().optional(),
  deviceId: z.string().optional(),
  clientName: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Turn broken rules into sentences an operator can act on.
 *
 * These are the two CEL footguns, and both are silent in production: reading a
 * missing map key throws (so the rule never fires), and only a literal `true`
 * counts as a match (so `"true"` or a truthy value never fires either).
 */
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

export function createMetaRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

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
      authVerifiers: describe(deps.registry.auth),
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
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers(body.headers ?? {}),
      ip: null,
      body: {
        model: body.model,
        ...(body.stream === undefined ? {} : { stream: body.stream }),
        messages: Array.from({ length: body.messageCount ?? 1 }, () => ({
          role: "user" as const,
          content: "simulated",
        })),
      },
      identity:
        body.userId === undefined && body.deviceId === undefined && body.claims === undefined
          ? null
          : {
              provider: "simulated",
              ...(body.userId === undefined ? {} : { userId: body.userId }),
              ...(body.deviceId === undefined ? {} : { deviceId: body.deviceId }),
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
      now: deps.runtime.now(),
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
        provider: decision.providerId,
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
