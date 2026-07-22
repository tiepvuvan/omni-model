import { z } from "zod";

/** Durations like "500ms", "30s", "5m", "1h", "1d". */
export const durationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'expected a duration like "30s", "5m", "1h" or "1d"');

export const corsConfigSchema = z.strictObject({
  allowOrigins: z.array(z.string()).default(["*"]),
  allowMethods: z.array(z.string()).optional(),
  allowHeaders: z.array(z.string()).optional(),
  exposeHeaders: z.array(z.string()).optional(),
  maxAge: z.number().int().positive().optional(),
  credentials: z.boolean().optional(),
});

export const serverConfigSchema = z.strictObject({
  cors: corsConfigSchema.optional(),
  /** Log level for the built-in console logger. */
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /**
   * Trust client-suppliable forwarding headers (`cf-connecting-ip`,
   * `x-forwarded-for`, `x-real-ip`) when deriving the client IP. Leave `false`
   * unless the proxy sits behind a trusted reverse proxy / CDN that overwrites
   * these headers; otherwise a client can spoof its rate-limit key.
   */
  trustProxyHeaders: z.boolean().default(false),
  /** Maximum accepted request body size in bytes; larger bodies get a 413. */
  maxBodyBytes: z
    .number()
    .int()
    .positive()
    .default(128 * 1024),
});

/**
 * Storage, security-provider and model-provider blocks are validated in two
 * steps: the core schema only pins down the discriminating `type` (plus
 * `name` for security providers), and each factory validates its own options.
 * That keeps third-party components definable without core schema changes.
 */
export const storageConfigSchema = z
  .looseObject({ type: z.string().min(1) })
  .default({ type: "memory" });

export const securityProviderConfigSchema = z.looseObject({
  type: z.string().min(1),
  name: z.string().optional(),
});

export const securityConfigSchema = z.strictObject({
  /**
   * "any": the first verifier that recognizes and accepts a credential wins;
   *        a presented-but-invalid credential still rejects the request.
   * "all": every configured verifier must accept the request.
   */
  mode: z.enum(["any", "all"]).default("all"),
  /** Paths (exact or trailing-`*` prefix) that bypass authentication. */
  publicPaths: z.array(z.string()).default([]),
  /**
   * Verifiers for `/v1/*`. **At least one is required** — see
   * `createOmniApp`, which refuses to start without one. There is no opt-out:
   * a proxy that authenticates nobody is an open relay on your provider
   * credits and offers a caller nothing the upstream API doesn't, which is the
   * entire reason this project exists.
   *
   * For local development, the `jwt` verifier with a shared `secret` is a
   * three-line config that needs no external service.
   */
  providers: z.array(securityProviderConfigSchema).default([]),
});

export const rateLimitRuleSchema = z
  .strictObject({
    name: z.string().min(1),
    /** CEL expression; the rule applies only when it evaluates to true. */
    when: z.string().optional(),
    key: z.enum(["user", "device", "ip", "global", "expression"]).default("user"),
    /** CEL expression producing the limit key when `key: expression`. */
    keyExpression: z.string().optional(),
    requests: z
      .strictObject({ limit: z.number().int().positive(), window: durationSchema })
      .optional(),
    tokens: z
      .strictObject({ limit: z.number().int().positive(), window: durationSchema })
      .optional(),
  })
  .refine((rule) => rule.key !== "expression" || rule.keyExpression !== undefined, {
    message: 'key "expression" requires `keyExpression`',
  })
  .refine((rule) => rule.requests !== undefined || rule.tokens !== undefined, {
    message: "a rate limit rule needs at least one of `requests` or `tokens`",
  });

function defaultRateLimits() {
  return [
    {
      name: "per-user-requests",
      key: "user" as const,
      requests: { limit: 30, window: "1h" },
    },
    {
      name: "per-user-daily-tokens",
      key: "user" as const,
      tokens: { limit: 30_000, window: "1d" },
    },
  ];
}

export const providerConfigSchema = z.looseObject({ type: z.string().min(1) });

export const routeConfigSchema = z.strictObject({
  name: z.string().min(1),
  /** CEL expression; the first route whose `when` is true wins. */
  when: z.string(),
  provider: z.string().min(1),
  /** Upstream model override; omit to keep the client-requested model. */
  model: z.string().optional(),
});

export const modelRuleSchema = z.strictObject({
  /** CEL expression, e.g. `request.model.startsWith("claude-")`. */
  match: z.string(),
  provider: z.string().min(1),
  model: z.string().optional(),
});

export const routingConfigSchema = z.strictObject({
  /**
   * Exact client-facing model names that may be requested. An empty list
   * preserves the default: every model name is eligible for routing.
   */
  allowedModels: z.array(z.string().min(1)).default([]),
  /** Evaluated in order against every request; first match wins. */
  routes: z.array(routeConfigSchema).default([]),
  /** Fallback mapping from client-requested model to provider. */
  modelRules: z.array(modelRuleSchema).default([]),
  /** Last resort when no route or model rule matches. */
  defaultProvider: z.string().optional(),
});

export const omniConfigSchema = z.strictObject({
  version: z.literal(1).default(1),
  // `prefault({})` supplies an empty object as the pre-parse input when the key
  // is omitted, so each block's own field defaults apply (and stay the single
  // source of truth).
  server: serverConfigSchema.prefault({}),
  storage: storageConfigSchema,
  security: securityConfigSchema.prefault({}),
  rateLimits: z.array(rateLimitRuleSchema).default(defaultRateLimits),
  providers: z.record(z.string().min(1), providerConfigSchema).default({}),
  routing: routingConfigSchema.prefault({}),
});

export type CorsConfig = z.output<typeof corsConfigSchema>;
export type ServerConfig = z.output<typeof serverConfigSchema>;
export type StorageConfig = z.output<typeof storageConfigSchema>;
export type SecurityProviderConfig = z.output<typeof securityProviderConfigSchema>;
export type SecurityConfig = z.output<typeof securityConfigSchema>;
export type RateLimitRuleConfig = z.output<typeof rateLimitRuleSchema>;
export type ProviderConfig = z.output<typeof providerConfigSchema>;
export type RouteConfig = z.output<typeof routeConfigSchema>;
export type ModelRuleConfig = z.output<typeof modelRuleSchema>;
export type RoutingConfig = z.output<typeof routingConfigSchema>;
export type OmniConfig = z.output<typeof omniConfigSchema>;
