import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AuthRoute, AuthVerifier } from "../auth/types.js";
import { interpolateDeep } from "../config/load.js";
import {
  type CorsConfig,
  type LoggingConfig,
  type OmniConfig,
  omniConfigSchema,
} from "../config/schema.js";
import { ConfigError } from "../errors.js";
import { createConsoleLogger } from "../logging.js";
import type { ChatProvider } from "../providers/types.js";
import { createRateLimiter } from "../ratelimit/limiter.js";
import type { RateLimiter } from "../ratelimit/types.js";
import type { OmniRegistry } from "../registry.js";
import {
  type CompiledRoutingRule,
  compileRoutingExpression,
  createRouter,
  unreachableRules,
} from "../routing/router.js";
import type { ExpressionEngine, Router } from "../routing/types.js";
import type { AppEnv } from "../server/types.js";
import type { StorageAdapter } from "../storage/types.js";
import type { Logger, RuntimeContext } from "../types.js";

/**
 * Everything a request needs, built once from one configuration revision and
 * then never mutated.
 *
 * Configuration is dynamic; a bundle is not. Reconfiguring builds a *new*
 * bundle and swaps the reference, so a request that already started keeps the
 * bundle it began with for its whole lifetime — including a streaming response
 * that outlives the swap. That is what makes a reload invisible to clients:
 * nothing a request depends on can change underneath it.
 *
 * The shape deliberately satisfies `PipelineDeps`, so a bundle can be handed
 * straight to `executeChat` / `executeEmbeddings`.
 */
export interface RuntimeBundle {
  /**
   * The validated configuration this bundle was built from, with `${VAR}`
   * references and `{"$secret": …}` references **already resolved**.
   *
   * It therefore contains credentials in plaintext. Never serialize it to a
   * client, a log line, or an admin API response — return the *stored* revision
   * document instead, which only ever holds references.
   */
  readonly config: OmniConfig;
  /** Source revision, when it came from a `ConfigStore`. */
  readonly revision: number | null;

  /**
   * One upstream per routing rule, keyed by the rule's id.
   *
   * Rules hold their own provider for serving; this is for anything that needs to
   * address one by name — the admin probe asks "is *this rule's* upstream
   * reachable", which is the right question now that credentials belong to a rule.
   */
  readonly providers: ReadonlyMap<string, ChatProvider>;
  readonly router: Router;
  readonly limiter: RateLimiter;
  readonly log: Logger;

  /**
   * Layer 1: who the user is. Exactly one, and always present — a bundle cannot
   * be built without it, which is what keeps `/v1` closed rather than open.
   */
  readonly userVerifier: AuthVerifier;
  /** Layer 2: which app or device. Any number, possibly none. */
  readonly appVerifiers: readonly AuthVerifier[];
  /** How the app layer combines when more than one scheme is configured. */
  readonly appAuthMode: "any" | "all";
  readonly publicPaths: readonly string[];
  /** Whether `/v1/*` demands a write key. */
  readonly requireWriteKey: boolean;
  /** Verifier-contributed routes, keyed `"<METHOD> <path>"`. */
  readonly authRoutes: ReadonlyMap<string, AuthRoute>;

  /** Request/content logging settings. */
  readonly logging: LoggingConfig;
  readonly maxBodyBytes: number;
  readonly allowedModels: readonly string[];
  readonly trustProxyHeaders: boolean;
  /** Prebuilt CORS middleware, or null when CORS is not configured. */
  readonly corsMiddleware: MiddlewareHandler<AppEnv> | null;
}

export interface BuildBundleInput {
  /** Raw or validated configuration document; re-validated here either way. */
  config: unknown;
  registry: OmniRegistry;
  storage: StorageAdapter;
  engine: ExpressionEngine;
  /** Base runtime handed to component factories; its `log` is replaced. */
  runtime: RuntimeContext;
  /** Overrides the per-bundle console logger (tests inject a silent one). */
  logger?: Logger;
  revision?: number | null;
}

/** Paths the proxy itself owns; a verifier route may not shadow them. */
const RESERVED_PREFIXES = ["/v1/", "/admin/"];
const RESERVED_PATHS = ["/healthz", "/readyz"];

function registeredTypes(registry: ReadonlyMap<string, unknown>): string {
  const types = [...registry.keys()].sort();
  return types.length === 0 ? "none registered" : types.join(", ");
}

function corsOptions(config: CorsConfig): NonNullable<Parameters<typeof cors>[0]> {
  const options: NonNullable<Parameters<typeof cors>[0]> = {
    origin: config.allowOrigins.includes("*") ? "*" : config.allowOrigins,
  };
  if (config.allowMethods !== undefined) options.allowMethods = config.allowMethods;
  if (config.allowHeaders !== undefined) options.allowHeaders = config.allowHeaders;
  if (config.exposeHeaders !== undefined) options.exposeHeaders = config.exposeHeaders;
  if (config.maxAge !== undefined) options.maxAge = config.maxAge;
  if (config.credentials !== undefined) options.credentials = config.credentials;
  return options;
}

/**
 * Build a bundle, or throw `ConfigError` describing exactly what is wrong.
 *
 * Synchronous on purpose: the caller builds completely and only then swaps, so
 * there is no window in which a half-built bundle is reachable.
 */
export function buildBundle(input: BuildBundleInput): RuntimeBundle {
  // `${VAR}` references are resolved here, not when the document was stored: a
  // saved revision keeps the reference so the database never holds a secret.
  const interpolated = interpolateDeep(input.config, input.runtime.env);
  const parsed = omniConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    throw new ConfigError(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const config = parsed.data;
  const log = input.logger ?? createConsoleLogger(config.server.logLevel);
  const runtime: RuntimeContext = { ...input.runtime, log };

  const userVerifier = buildUserVerifier(config, input.registry, runtime);
  const appVerifiers = buildAppVerifiers(config, input.registry, runtime);

  const { rules, providers } = buildRoutingRules(config, input.registry, input.engine, runtime);
  // A smell, not an error: the configuration is valid and serves traffic, it just
  // contains a rule that can never fire. Said out loud because nothing about a
  // request reveals it — the proxy answers normally, from an earlier rule.
  for (const dead of unreachableRules(config.routing.rules)) {
    log.warn("routing rule can never match: an earlier catch-all always wins", dead);
  }
  const router = createRouter(rules, { allowedModels: config.routing.allowedModels, log });
  const limiter = createRateLimiter(config.rateLimits, {
    storage: input.storage,
    engine: input.engine,
    log,
    now: runtime.now,
  });

  return {
    config,
    revision: input.revision ?? null,
    providers,
    router,
    limiter,
    log,
    userVerifier,
    appVerifiers,
    appAuthMode: config.security.appAuth.mode,
    publicPaths: config.security.publicPaths,
    requireWriteKey: config.security.requireWriteKey,
    authRoutes: collectAuthRoutes([userVerifier, ...appVerifiers]),
    logging: config.logging,
    maxBodyBytes: config.server.maxBodyBytes,
    allowedModels: config.routing.allowedModels,
    trustProxyHeaders: config.server.trustProxyHeaders,
    corsMiddleware: config.server.cors === undefined ? null : cors(corsOptions(config.server.cors)),
  };
}

/** Registered types belonging to one layer, for an error message that helps. */
function typesInLayer(registry: OmniRegistry, layer: "user" | "app"): string {
  const types = [...registry.auth.values()]
    .filter((factory) => factory.layer === layer)
    .map((factory) => factory.type)
    .sort();
  return types.length === 0 ? "none registered" : types.join(", ");
}

/**
 * Layer 1. Required, and required to *be* a user verifier.
 *
 * A proxy that authenticates nobody is an open relay on your provider credits,
 * and a caller gains nothing over calling the upstream API directly. There is
 * deliberately no opt-out — the refusal is here rather than in the schema so the
 * message can say what to do about it.
 */
function buildUserVerifier(
  config: OmniConfig,
  registry: OmniRegistry,
  runtime: RuntimeContext,
): AuthVerifier {
  const entry = config.security.userAuth;
  if (entry === undefined) {
    throw new ConfigError(
      "security.userAuth is not set: /v1/* would accept unauthenticated requests, which is an " +
        `open relay on your provider credits. Choose one of: ${typesInLayer(registry, "user")}. ` +
        "For local development, `jwt` with a shared secret needs no external service:\n" +
        "  security:\n" +
        "    userAuth:\n" +
        "      type: jwt\n" +
        "      secret: <a long random value>\n" +
        "      algorithms: [HS256]\n" +
        "or, from the environment: OMNI_SECURITY_JWT_ENABLED=true, OMNI_SECURITY_JWT_SECRET=…, " +
        'OMNI_SECURITY_JWT_ALGORITHMS=["HS256"]',
    );
  }
  const factory = registry.auth.get(entry.type);
  if (factory === undefined) {
    throw new ConfigError(
      `security.userAuth: unknown auth type "${entry.type}" ` +
        `(registered auth types: ${registeredTypes(registry.auth)})`,
    );
  }
  // Naming the right home rather than just refusing: putting App Attest here is
  // the obvious mistake, and it is one field away from being correct.
  if (factory.layer !== "user") {
    throw new ConfigError(
      `security.userAuth: "${entry.type}" verifies an app or device, not a user, so it cannot be ` +
        "the user authentication method. Move it to security.appAuth.providers and choose one of: " +
        `${typesInLayer(registry, "user")}.`,
    );
  }
  return factory.create(entry, runtime);
}

/** Layer 2. Any number, each of which must actually be an app verifier. */
function buildAppVerifiers(
  config: OmniConfig,
  registry: OmniRegistry,
  runtime: RuntimeContext,
): AuthVerifier[] {
  return config.security.appAuth.providers.map((entry, index) => {
    const factory = registry.auth.get(entry.type);
    if (factory === undefined) {
      throw new ConfigError(
        `security.appAuth.providers[${index}]: unknown auth type "${entry.type}" ` +
          `(registered auth types: ${registeredTypes(registry.auth)})`,
      );
    }
    if (factory.layer !== "app") {
      throw new ConfigError(
        `security.appAuth.providers[${index}]: "${entry.type}" verifies a user, not an app, so it ` +
          "cannot be layered here. Set it as security.userAuth instead, and choose from: " +
          `${typesInLayer(registry, "app")}.`,
      );
    }
    return factory.create(entry, runtime);
  });
}

/**
 * Compile every rule and construct the upstream each one points at.
 *
 * One provider instance per rule, keyed by the rule's id. Sharing an instance
 * between rules with identical targets was tried and reverted: a provider is a
 * stateless wrapper over `fetch` that holds no sockets, so the saving was
 * nothing, and it made `ChatProvider.id` arbitrary — whichever rule happened to
 * build it first — which then showed up in error messages and logs.
 */
function buildRoutingRules(
  config: OmniConfig,
  registry: OmniRegistry,
  engine: ExpressionEngine,
  runtime: RuntimeContext,
): { rules: CompiledRoutingRule[]; providers: Map<string, ChatProvider> } {
  const providers = new Map<string, ChatProvider>();
  const rules = config.routing.rules.map((rule, index) => {
    const id = rule.id ?? `rules[${index}]`;
    const where = `routing.rules[${index}]${rule.name === undefined ? "" : ` ("${rule.name}")`}`;
    const factory = registry.providers.get(rule.target.type);
    if (factory === undefined) {
      throw new ConfigError(
        `${where}.target: unknown provider type "${rule.target.type}" ` +
          `(registered provider types: ${registeredTypes(registry.providers)})`,
      );
    }
    if (providers.has(id)) {
      throw new ConfigError(
        `${where}: duplicate rule id "${id}"; ids identify a rule in logs and in the admin API, ` +
          "so two rules cannot share one",
      );
    }

    // `model` is the *rule's* choice of what to forward as, not a provider
    // option — and the factories validate with `strictObject`, so passing it
    // through would be rejected as an unrecognized key.
    const { model, ...options } = rule.target;
    // The factory validates its own options and throws `ConfigError`, so a bad
    // credential or base URL is reported here rather than on the first request.
    const provider = factory.create(id, options, runtime);
    providers.set(id, provider);

    return {
      when: compileRoutingExpression(engine, rule.when, `${where} when`),
      routeName: rule.name ?? id,
      provider,
      providerType: rule.target.type,
      model,
      warnedNonBoolean: false,
    };
  });
  return { rules, providers };
}

/**
 * Index verifier-contributed routes for the dispatcher.
 *
 * Hono cannot unregister a route, so these are looked up per request instead of
 * being mounted — that is the only way changing `security.providers` can take
 * effect without a new app. Collisions are rejected here rather than silently
 * shadowing: two verifiers claiming one path, or a verifier claiming a path the
 * proxy owns, is a configuration bug.
 */
function collectAuthRoutes(verifiers: readonly AuthVerifier[]): Map<string, AuthRoute> {
  const routes = new Map<string, AuthRoute>();
  for (const verifier of verifiers) {
    for (const route of verifier.routes ?? []) {
      if (
        RESERVED_PATHS.includes(route.path) ||
        RESERVED_PREFIXES.some((prefix) => route.path.startsWith(prefix))
      ) {
        throw new ConfigError(
          `verifier "${verifier.name}" claims reserved path "${route.path}"; ` +
            `${RESERVED_PATHS.join(", ")} and ${RESERVED_PREFIXES.join("*, ")}* belong to the proxy`,
        );
      }
      const key = `${route.method} ${route.path}`;
      if (routes.has(key)) {
        throw new ConfigError(
          `two verifiers claim the route "${key}"; give at most one verifier of each type that ` +
            "contributes routes, or change its paths",
        );
      }
      routes.set(key, route);
    }
  }
  return routes;
}
