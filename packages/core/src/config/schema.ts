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

/**
 * Layer 2: which app or device the request came from.
 *
 * Optional, and any number of them. Configuring several is normal — one app
 * attestation scheme per platform — which is why `mode` exists: a deployment
 * serving iOS and the web wants `any` (each client can only satisfy its own
 * platform's scheme), while an iOS-only deployment layering App Attest over App
 * Check wants `all`.
 */
export const appAuthConfigSchema = z.strictObject({
  /**
   * "any": the first configured scheme that accepts wins; a presented-but-invalid
   *        credential still rejects the request, and if none accepts, the request
   *        is rejected.
   * "all": every configured scheme must accept.
   */
  mode: z.enum(["any", "all"]).default("all"),
  providers: z.array(securityProviderConfigSchema).default([]),
});

export const securityConfigSchema = z.strictObject({
  /**
   * Layer 1: which user. Exactly one, and **required** — `firebase-auth`,
   * `supabase` or `jwt`.
   *
   * One rather than a list because a request has one end user, and a deployment
   * has one place identities come from. Two would raise a question with no good
   * answer — which one owns `user.id`, and therefore whose budget a request
   * spends — and `user.id` is what every rate limit counts against.
   *
   * Optional *here* so a document is still parseable without it; a bundle refuses
   * to build without one, so `/v1` stays closed rather than open. That split is
   * deliberate: shape errors belong to the schema, viability to the bundle, and
   * the bundle's message is the one that says what to do about it.
   */
  userAuth: securityProviderConfigSchema.optional(),
  /** Layer 2: app or device attestation, layered over the user. */
  appAuth: appAuthConfigSchema.prefault({}),
  /** Paths (exact or trailing-`*` prefix) that bypass authentication. */
  publicPaths: z.array(z.string()).default([]),
  /**
   * Require every `/v1/*` request to present a write key (`x-omni-key`).
   *
   * Defaults to **false** so enabling it is a deliberate act: turning it on
   * locks out every client that is not already sending a key. Presented keys are
   * always validated either way, so attribution and revocation work as soon as
   * clients start sending them — but revocation only becomes *binding* once this
   * is true, because otherwise a revoked client can simply omit the header.
   */
  requireWriteKey: z.boolean().default(false),
});

export const rateLimitRuleSchema = z
  .strictObject({
    /**
     * Stable identity of the rule, used in counter keys. Defaults to `name`,
     * which is what existing configurations rely on.
     *
     * Set it explicitly for any rule an operator can rename from a dashboard:
     * counters live under `rl:tok:<id>:…`, so a rule whose identity is its
     * display name silently resets every counter when renamed.
     */
    id: z.string().min(1).optional(),
    /**
     * Display name, reported in `x-ratelimit-rule` and in request logs.
     *
     * Optional, and defaults to `id`: a rule created from a dashboard has no
     * field to type a name into, and inventing one to satisfy the schema would
     * store a second copy of the id rather than anything an operator wrote.
     */
    name: z.string().min(1).optional(),
    /**
     * CEL expression; the rule applies only when it evaluates to true.
     *
     * Omitted means "every request", which is a *baseline* rather than a
     * fallback: every matching rule is enforced, so a rule with no condition
     * applies alongside the conditional ones above it and the first budget to
     * run out is the one that rejects.
     */
    when: z.string().optional(),
    /**
     * Prompt plus completion tokens allowed per fixed window, per user.
     *
     * The only kind of budget there is. Tokens are what a request costs, and one
     * unit means the counter is a number an operator can reason about against a
     * provider bill. There is no request-count window: see the note on
     * `rateLimits` for what that gives up.
     */
    tokens: z.strictObject({ limit: z.number().int().positive(), window: durationSchema }),
  })
  .refine((rule) => rule.id !== undefined || rule.name !== undefined, {
    message: "a rate limit rule needs an `id` or a `name`",
  });

function defaultRateLimits() {
  return [{ name: "per-user-daily-tokens", tokens: { limit: 30_000, window: "1d" } }];
}

/**
 * Where a matched request is sent: which upstream, with which credentials, as
 * which model.
 *
 * `type` is the only field pinned here; the rest are the provider factory's own
 * options and are validated by its `optionsSchema` when the bundle is built —
 * the same two-step validation every other pluggable component gets.
 *
 * A target is part of the rule that owns it rather than a shared, named provider
 * referenced from elsewhere. That is deliberate: a reference can dangle, and
 * "which credentials does this rule actually use" stopped being answerable by
 * reading the rule.
 */
export const routeTargetSchema = z.looseObject({
  type: z.string().min(1),
  /**
   * Upstream model name. Omit to forward whatever the client asked for, which is
   * what a rule matching on `request.model` usually wants.
   */
  model: z.string().optional(),
});

export const routingRuleSchema = z.strictObject({
  /**
   * Stable identity, referenced by logs and by the admin API. Defaults to the
   * rule's position, so a hand-written configuration need not invent one — but
   * anything that edits rules programmatically should set it, since a positional
   * id changes meaning when rules are reordered.
   */
  id: z.string().min(1).optional(),
  /** Human label, shown as the route name in request logs. */
  name: z.string().min(1).optional(),
  /** CEL expression; the first rule whose `when` is true wins. */
  when: z.string(),
  target: routeTargetSchema,
});

export const routingConfigSchema = z.strictObject({
  /**
   * Exact client-facing model names that may be requested. An empty list
   * preserves the default: every model name is eligible for routing.
   */
  allowedModels: z.array(z.string().min(1)).default([]),
  /**
   * Evaluated in order against every request; the first match wins and nothing
   * else runs.
   *
   * There is no separate default: a catch-all is a last rule with `when: "true"`.
   * With no rule matching, the request is a 404 — the same answer an unroutable
   * model has always produced, and one concept instead of two.
   */
  rules: z.array(routingRuleSchema).default([]),
});

export const loggingConfigSchema = z.strictObject({
  /**
   * Record one row per `/v1` request: who called, what it cost, where it went.
   * On by default — knowing what your clients are spending is the point of
   * running a proxy — and cheap, because writes are batched off the hot path.
   */
  requests: z.boolean().default(true),
  /**
   * Also store prompt and completion text.
   *
   * Off by default: this is the most sensitive data the proxy handles, and
   * storing it is a decision about your users' privacy, not a default. Enable it
   * globally here, or per client via a write key's `captureContent`.
   */
  content: z.boolean().default(false),
  /** Cap per side (prompt, completion). Longer text is cut and flagged. */
  maxContentBytes: z
    .number()
    .int()
    .positive()
    .default(32 * 1024),
  /** How long metadata rows are kept. */
  retention: durationSchema.default("30d"),
  /**
   * How long captured content is kept. Separate from `retention` so usage
   * history can outlive the prompts, which is usually what you want.
   */
  contentRetention: durationSchema.default("7d"),
});

export const omniConfigSchema = z.strictObject({
  version: z.literal(1).default(1),
  // `prefault({})` supplies an empty object as the pre-parse input when the key
  // is omitted, so each block's own field defaults apply (and stay the single
  // source of truth).
  server: serverConfigSchema.prefault({}),
  storage: storageConfigSchema,
  security: securityConfigSchema.prefault({}),
  /**
   * Token budgets, all counted per user.
   *
   * Every rule whose `when` matches is enforced, so these are layered budgets
   * rather than alternatives, and the first to run out is the one that rejects.
   *
   * Worth knowing what this does *not* do: there is no request-count window, so a
   * flood of requests that spend no tokens — malformed bodies, requests the
   * upstream refuses — is not limited here. Tokens are what a request costs, and
   * that is the axis these rules protect.
   */
  rateLimits: z.array(rateLimitRuleSchema).default(defaultRateLimits),
  // No `providers` block: an upstream is described by the rule that routes to it
  // (`routing.rules[].target`), so there is no name to reference and nothing to
  // leave dangling.
  routing: routingConfigSchema.prefault({}),
  logging: loggingConfigSchema.prefault({}),
});

export type CorsConfig = z.output<typeof corsConfigSchema>;
export type ServerConfig = z.output<typeof serverConfigSchema>;
export type StorageConfig = z.output<typeof storageConfigSchema>;
export type SecurityProviderConfig = z.output<typeof securityProviderConfigSchema>;
export type SecurityConfig = z.output<typeof securityConfigSchema>;
export type RateLimitRuleConfig = z.output<typeof rateLimitRuleSchema>;
export type RouteTargetConfig = z.output<typeof routeTargetSchema>;
export type RoutingRuleConfig = z.output<typeof routingRuleSchema>;
export type RoutingConfig = z.output<typeof routingConfigSchema>;
export type LoggingConfig = z.output<typeof loggingConfigSchema>;
export type OmniConfig = z.output<typeof omniConfigSchema>;
