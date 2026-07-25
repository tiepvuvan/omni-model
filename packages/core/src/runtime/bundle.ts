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
import { createRouter } from "../routing/router.js";
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

  readonly providers: ReadonlyMap<string, ChatProvider>;
  readonly router: Router;
  readonly limiter: RateLimiter;
  readonly log: Logger;

  readonly verifiers: readonly AuthVerifier[];
  readonly securityMode: "any" | "all";
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

  const verifiers = buildVerifiers(config, input.registry, runtime);
  // A proxy with no verifier authenticates nobody: anyone who finds the URL
  // spends your provider credits, and a caller gains nothing over calling the
  // upstream API directly. There is deliberately no opt-out.
  if (verifiers.length === 0) {
    throw new ConfigError(
      "security.providers is empty: /v1/* would accept unauthenticated requests, which is an " +
        "open relay on your provider credits. Configure at least one verifier — firebase-auth, " +
        "firebase-app-check, apple-app-attest, apple-device-check, supabase, or jwt. For local " +
        "development, `jwt` with a shared secret needs no external service:\n" +
        "  security:\n" +
        "    providers:\n" +
        "      - type: jwt\n" +
        "        secret: <a long random value>\n" +
        "        algorithms: [HS256]\n" +
        "or, from the environment: OMNI_SECURITY_JWT_ENABLED=true, OMNI_SECURITY_JWT_SECRET=…, " +
        'OMNI_SECURITY_JWT_ALGORITHMS=["HS256"]',
    );
  }

  const providers = buildProviders(config, input.registry, runtime);
  const router = createRouter(config.routing, new Set(providers.keys()), input.engine, log);
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
    verifiers,
    securityMode: config.security.mode,
    publicPaths: config.security.publicPaths,
    requireWriteKey: config.security.requireWriteKey,
    authRoutes: collectAuthRoutes(verifiers),
    logging: config.logging,
    maxBodyBytes: config.server.maxBodyBytes,
    allowedModels: config.routing.allowedModels,
    trustProxyHeaders: config.server.trustProxyHeaders,
    corsMiddleware: config.server.cors === undefined ? null : cors(corsOptions(config.server.cors)),
  };
}

function buildVerifiers(
  config: OmniConfig,
  registry: OmniRegistry,
  runtime: RuntimeContext,
): AuthVerifier[] {
  return config.security.providers.map((entry, index) => {
    const factory = registry.auth.get(entry.type);
    if (factory === undefined) {
      throw new ConfigError(
        `security.providers[${index}]: unknown auth type "${entry.type}" ` +
          `(registered auth types: ${registeredTypes(registry.auth)})`,
      );
    }
    return factory.create(entry, runtime);
  });
}

function buildProviders(
  config: OmniConfig,
  registry: OmniRegistry,
  runtime: RuntimeContext,
): Map<string, ChatProvider> {
  const providers = new Map<string, ChatProvider>();
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const factory = registry.providers.get(providerConfig.type);
    if (factory === undefined) {
      throw new ConfigError(
        `providers.${id}: unknown provider type "${providerConfig.type}" ` +
          `(registered provider types: ${registeredTypes(registry.providers)})`,
      );
    }
    providers.set(id, factory.create(id, providerConfig, runtime));
  }
  return providers;
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
