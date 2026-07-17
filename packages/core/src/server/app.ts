import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AuthVerifier, VerifyContext } from "../auth/types.js";
import { type CorsConfig, omniConfigSchema } from "../config/schema.js";
import { ConfigError, OmniError } from "../errors.js";
import { createConsoleLogger } from "../logging.js";
import type { OpenAIErrorBody } from "../openai/types.js";
import type { ChatProvider } from "../providers/types.js";
import { createRateLimiter } from "../ratelimit/limiter.js";
import { createDefaultRegistry } from "../registry.js";
import { CelExpressionEngine } from "../routing/cel.js";
import { createRouter } from "../routing/router.js";
import type { RuntimeContext } from "../types.js";
import { createAuthMiddleware } from "./auth.js";
import { extractClientIp } from "./facts.js";
import { createChatHandler, type RouteDeps } from "./routes/chat.js";
import { createEmbeddingsHandler } from "./routes/embeddings.js";
import { createModelsHandler } from "./routes/models.js";
import type { AppEnv, OmniAppInit } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 * Build the omni-model HTTP app: config -> storage -> auth -> rate limiting
 * -> routing -> provider call, exposed as OpenAI-compatible endpoints
 * (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) plus `/healthz`
 * and any extra routes contributed by auth verifiers.
 *
 * All component construction happens here, so configuration mistakes
 * (unknown types, bad expressions) throw `ConfigError` at startup, never
 * mid-request. The returned Hono app is runtime-agnostic: serve it with
 * `app.fetch` on Node, Workers, Deno or Bun.
 */
export async function createOmniApp(init: OmniAppInit): Promise<Hono<AppEnv>> {
  // Re-validate the config so programmatically built (non-`parseConfig`)
  // configs still get defaults applied and typos rejected at startup.
  const parsedConfig = omniConfigSchema.safeParse(init.config);
  if (!parsedConfig.success) {
    throw new ConfigError(
      `invalid configuration passed to createOmniApp:\n${z.prettifyError(parsedConfig.error)}`,
    );
  }
  const config = parsedConfig.data;

  const registry = init.registry ?? createDefaultRegistry();
  const env = init.env ?? {};
  const baseFetch = init.fetch ?? globalThis.fetch;
  const fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => baseFetch(...args);
  const now = init.now ?? Date.now;
  const log = init.logger ?? createConsoleLogger(config.server.logLevel);
  const fallbackWaitUntil =
    init.waitUntil ??
    ((promise: Promise<unknown>): void => {
      void promise.catch((error) => {
        log.error("background task failed", { error: errorMessage(error) });
      });
    });
  const runtime: RuntimeContext = { env, fetch: fetchImpl, now, waitUntil: fallbackWaitUntil, log };

  let storage = init.storage;
  if (storage === undefined) {
    const factory = registry.storage.get(config.storage.type);
    if (factory === undefined) {
      throw new ConfigError(
        `storage: unknown type "${config.storage.type}" ` +
          `(registered storage types: ${registeredTypes(registry.storage)})`,
      );
    }
    storage = await factory.create(config.storage, runtime);
  }

  const verifiers: AuthVerifier[] = config.security.providers.map((entry, index) => {
    const factory = registry.auth.get(entry.type);
    if (factory === undefined) {
      throw new ConfigError(
        `security.providers[${index}]: unknown auth type "${entry.type}" ` +
          `(registered auth types: ${registeredTypes(registry.auth)})`,
      );
    }
    return factory.create(entry, runtime);
  });

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

  const engine = init.engine ?? new CelExpressionEngine();
  const router = createRouter(config.routing, new Set(providers.keys()), engine, log);
  const limiter = createRateLimiter(config.rateLimits, { storage, engine, log, now });

  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof OmniError) return error.toResponse();
    log.error("unhandled error", { path: c.req.path, error: errorMessage(error) });
    const body: OpenAIErrorBody = {
      error: { message: "internal server error", type: "api_error", param: null, code: null },
    };
    return c.json(body, 500);
  });

  app.notFound((c) => {
    const body: OpenAIErrorBody = {
      error: {
        message: `Unknown request URL: ${c.req.method} ${c.req.path}`,
        type: "invalid_request_error",
        param: null,
        code: "unknown_url",
      },
    };
    return c.json(body, 404);
  });

  if (config.server.cors !== undefined) {
    app.use("*", cors(corsOptions(config.server.cors)));
  }

  // Prefer the platform execution context (Workers). Accessing `executionCtx`
  // THROWS on runtimes without one (Node), hence the try/catch probe.
  const waitUntilFor = (c: Context<AppEnv>): ((promise: Promise<unknown>) => void) => {
    try {
      const executionCtx = c.executionCtx;
      return (promise) => executionCtx.waitUntil(promise);
    } catch {
      return fallbackWaitUntil;
    }
  };
  const runtimeFor = (c: Context<AppEnv>): RuntimeContext => ({
    env,
    fetch: fetchImpl,
    now,
    waitUntil: waitUntilFor(c),
    log,
  });
  const verifyContextFor = (c: Context<AppEnv>): VerifyContext => ({ ...runtimeFor(c), storage });

  // Default IP resolver: header-only, gated on trustProxyHeaders. Platforms
  // with socket access (Node) override this via `init.clientIp`.
  const clientIp =
    init.clientIp ??
    ((c: Context<AppEnv>): string | null =>
      extractClientIp(c.req.raw.headers, config.server.trustProxyHeaders));

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Verifier-contributed routes (e.g. App Attest challenge issuance) mount
  // outside /v1 and are therefore not behind the auth middleware.
  for (const verifier of verifiers) {
    for (const route of verifier.routes ?? []) {
      app.on(route.method, route.path, (c) => route.handler(c.req.raw, verifyContextFor(c)));
    }
  }

  if (verifiers.length === 0) {
    // A proxy with no verifier authenticates nobody: anyone who finds the URL
    // spends your provider credits, and a caller gains nothing over calling the
    // upstream API directly. That is never worth shipping by accident, so it
    // fails at startup (rule: config errors never surface mid-request) unless
    // it was asked for explicitly.
    if (!config.security.allowUnauthenticated) {
      throw new ConfigError(
        "security.providers is empty, so /v1/* would accept unauthenticated requests — " +
          "an open relay on your provider credits. Add a verifier (firebase-auth, " +
          "firebase-app-check, apple-app-attest, apple-device-check, jwt, supabase), " +
          "or set security.allowUnauthenticated: true to run without one (local development " +
          "or a private network only).",
      );
    }
    log.warn("security.allowUnauthenticated is set: /v1/* is open to anyone who finds this URL");
  } else {
    app.use(
      "/v1/*",
      createAuthMiddleware({
        mode: config.security.mode,
        publicPaths: config.security.publicPaths,
        verifiers,
        contextFor: verifyContextFor,
      }),
    );
  }

  const deps: RouteDeps = {
    providers,
    router,
    limiter,
    log,
    runtimeFor,
    clientIp,
    maxBodyBytes: config.server.maxBodyBytes,
  };
  app.post("/v1/chat/completions", createChatHandler(deps));
  app.get("/v1/models", createModelsHandler(deps));
  app.post("/v1/embeddings", createEmbeddingsHandler(deps));

  return app;
}
