import type { Context } from "hono";
import { Hono } from "hono";
import type { VerifyContext } from "../auth/types.js";
import { ConfigError, OmniError } from "../errors.js";
import { createConsoleLogger } from "../logging.js";
import { nullRequestLogSink } from "../logs/types.js";
import type { OpenAIErrorBody } from "../openai/types.js";
import { createDefaultRegistry } from "../registry.js";
import { CelExpressionEngine } from "../routing/cel.js";
import type { RuntimeBundle } from "../runtime/bundle.js";
import { type BundleHolder, createBundleHolder } from "../runtime/holder.js";
import { MemoryStorageAdapter } from "../storage/memory.js";
import type { StorageAdapter } from "../storage/types.js";
import type { Logger, RuntimeContext } from "../types.js";
import { createAuthMiddleware } from "./auth.js";
import { extractClientIp } from "./facts.js";
import { createRequestTracker, type RequestTracker } from "./lifecycle.js";
import { createRequestLoggingMiddleware } from "./logging.js";
import { createChatHandler, type RouteDeps } from "./routes/chat.js";
import { createEmbeddingsHandler } from "./routes/embeddings.js";
import { createModelsHandler } from "./routes/models.js";
import type { AppEnv, OmniAppInit, OmniProxyInit } from "./types.js";
import { createWriteKeyMiddleware } from "./writekey.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registeredTypes(registry: ReadonlyMap<string, unknown>): string {
  const types = [...registry.keys()].sort();
  return types.length === 0 ? "none registered" : types.join(", ");
}

/**
 * `/v1/*` before a configuration exists.
 *
 * Deliberately vague to the caller: whether the proxy is brand new or its
 * latest configuration was rejected is operator information, and `/v1` is a
 * public, unauthenticated surface. The detail goes to the log and `/readyz`.
 */
function notConfigured(): OmniError {
  return new OmniError(
    503,
    "omni-model has no active configuration; configure it before sending requests",
    { type: "api_error", code: "not_configured", headers: { "Retry-After": "5" } },
  );
}

/** A running proxy: the HTTP app plus the handle that reconfigures it. */
export interface OmniProxy {
  app: Hono<AppEnv>;
  /** Swap in a new configuration, or report why one was rejected. */
  holder: BundleHolder;
  /** The storage backend the app was built with. */
  storage: StorageAdapter;
  /**
   * In-flight request accounting, for a shutdown that lets answers finish.
   * The host calls `beginShutdown()` then `drain()`; see `RequestTracker`.
   */
  tracker: RequestTracker;
}

async function resolveStorage(
  init: OmniProxyInit,
  registry: ReturnType<typeof createDefaultRegistry>,
  runtime: RuntimeContext,
  log: Logger,
): Promise<StorageAdapter> {
  if (init.storage !== undefined) return init.storage;

  // Storage is bootstrap-level, not part of the reloadable configuration: you
  // cannot move a running proxy to a different database without a restart. It
  // is read from the initial config only.
  const configured = (init.config as { storage?: { type?: unknown } } | undefined)?.storage;
  const type = typeof configured?.type === "string" ? configured.type : undefined;
  if (type === undefined) {
    log.warn("no storage configured; using in-memory storage (nothing is shared or persisted)");
    return new MemoryStorageAdapter(runtime.now);
  }
  const factory = registry.storage.get(type);
  if (factory === undefined) {
    throw new ConfigError(
      `storage: unknown type "${type}" ` +
        `(registered storage types: ${registeredTypes(registry.storage)})`,
    );
  }
  return factory.create(configured as Record<string, unknown>, runtime);
}

/**
 * Build the omni-model HTTP app and the handle that reconfigures it.
 *
 * The app is constructed **once**; everything configuration-derived is read
 * from the current {@link RuntimeBundle} per request. That is what lets
 * providers, verifiers, rate limits, routing and CORS all change at runtime
 * without a new server — and why a reload is invisible to requests already in
 * flight, which keep the bundle they started with.
 *
 * Routes: `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/healthz`,
 * `/readyz`, plus any routes contributed by the active verifiers.
 *
 * Without an initial configuration the app still boots and still serves
 * `/healthz` — `/v1/*` answers 503 until one arrives. Booting is not the same
 * as being open: a bundle cannot exist without at least one verifier.
 */
export async function createOmniProxy(init: OmniProxyInit): Promise<OmniProxy> {
  const registry = init.registry ?? createDefaultRegistry();
  const env = init.env ?? {};
  const baseFetch = init.fetch ?? globalThis.fetch;
  const fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => baseFetch(...args);
  const now = init.now ?? Date.now;
  // The boot logger predates any bundle, so it cannot use `server.logLevel`.
  const bootLog = init.logger ?? createConsoleLogger("info");
  const fallbackWaitUntil =
    init.waitUntil ??
    ((promise: Promise<unknown>): void => {
      void promise.catch((error) => {
        bootLog.error("background task failed", { error: errorMessage(error) });
      });
    });
  const appCheck =
    init.consumeFirebaseAppCheckToken === undefined
      ? {}
      : { consumeFirebaseAppCheckToken: init.consumeFirebaseAppCheckToken };
  const googleAccess =
    init.getGoogleAccessToken === undefined
      ? {}
      : { getGoogleAccessToken: init.getGoogleAccessToken };
  const startupRuntime: RuntimeContext = {
    env,
    fetch: fetchImpl,
    now,
    waitUntil: fallbackWaitUntil,
    ...appCheck,
    ...googleAccess,
    log: bootLog,
  };

  const storage = await resolveStorage(init, registry, startupRuntime, bootLog);
  const engine = init.engine ?? new CelExpressionEngine();
  const holder = createBundleHolder({
    registry,
    storage,
    engine,
    runtime: startupRuntime,
    ...(init.logger === undefined ? {} : { logger: init.logger }),
    ...(init.secrets === undefined ? {} : { secrets: init.secrets }),
    ...(init.promptCache === undefined ? {} : { promptCache: init.promptCache }),
    log: bootLog,
  });

  /** The bundle for this request, or a 503 if there is none. */
  const requireBundle = (): RuntimeBundle => {
    const bundle = holder.current();
    if (bundle === null) throw notConfigured();
    return bundle;
  };

  const app = new Hono<AppEnv>();

  const tracker = createRequestTracker({
    now,
    onRefused: (path) =>
      (holder.current()?.log ?? bootLog).debug("refused a request during shutdown", { path }),
  });

  app.onError((error, c) => {
    // The only place the original error is still available, since Hono converts
    // it to a response before any outer middleware resumes.
    const draft = c.get("logDraft");
    if (draft !== undefined && error instanceof OmniError) draft.errorCode = error.code;
    if (error instanceof OmniError) return error.toResponse();
    const log = holder.current()?.log ?? bootLog;
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

  // CORS is registered unconditionally and reads the bundle, because whether
  // CORS applies at all is reconfigurable. The middleware itself is built once
  // per bundle, not per request.
  app.use("*", async (c, next) => {
    const middleware = holder.current()?.corsMiddleware;
    return middleware === undefined || middleware === null
      ? next()
      : middleware(c, async () => next());
  });

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
    ...appCheck,
    ...googleAccess,
    log: holder.current()?.log ?? bootLog,
  });

  // Default IP resolver: header-only, gated on trustProxyHeaders. Platforms
  // with socket access (Node) override this via `init.clientIp`.
  const clientIp =
    init.clientIp ??
    ((c: Context<AppEnv>, trustProxyHeaders: boolean): string | null =>
      extractClientIp(c.req.raw.headers, trustProxyHeaders));
  const verifyContextFor = (c: Context<AppEnv>, bundle: RuntimeBundle): VerifyContext => ({
    ...runtimeFor(c),
    storage,
    clientIp: clientIp(c, bundle.trustProxyHeaders),
    maxBodyBytes: bundle.maxBodyBytes,
  });

  /**
   * Verifier-contributed routes (e.g. App Attest challenge issuance), dispatched
   * from the bundle rather than mounted.
   *
   * Hono has no way to unregister a route, so mounting them per verifier would
   * make `security.providers` un-reloadable: removing a verifier would leave its
   * endpoints live forever. A single lookup keeps them exactly as dynamic as the
   * verifiers that own them.
   *
   * These sit outside `/v1` and are therefore not behind the auth middleware,
   * which is the point — they are how a client obtains a credential.
   */
  app.use("*", async (c, next) => {
    const bundle = holder.current();
    if (bundle === null) return next();
    const route = bundle.authRoutes.get(`${c.req.method} ${c.req.path}`);
    if (route === undefined) return next();
    return route.handler(c.req.raw, verifyContextFor(c, bundle));
  });

  // Liveness: the process is up. Never depends on configuration, so a
  // misconfigured proxy is not killed and restarted in a loop by its platform.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness: this instance can actually serve /v1.
  app.get("/readyz", (c) => {
    const status = holder.status();
    // Draining wins over configured: the point of failing readiness during a
    // shutdown is to get the load balancer to stop sending work here while the
    // requests already accepted finish.
    if (tracker.draining()) {
      return c.json(
        { status: "draining", revision: status.revision, inFlight: tracker.inFlight() },
        503,
      );
    }
    return c.json(
      {
        status: status.configured ? "ready" : "not_configured",
        revision: status.revision,
        error: status.lastError,
      },
      status.configured ? 200 : 503,
    );
  });

  // Outermost on /v1: counts a request as in flight until its response body is
  // fully written, which for a stream is long after the handler returned. Ahead
  // of logging so a request refused during shutdown is still logged.
  app.use("/v1/*", tracker.middleware);

  // Then logging, so a request refused by anything inside — a rate limit, a
  // revoked client key, an unknown model — still produces a log row.
  app.use(
    "/v1/*",
    createRequestLoggingMiddleware({
      sink: init.requestLogs ?? nullRequestLogSink,
      bundle: () => holder.current(),
      now,
      newRequestId: () => crypto.randomUUID(),
      waitUntil: waitUntilFor,
    }),
  );

  // Write keys next: "which application" is cheaper to answer than "which
  // user", so a revoked client is turned away before any token verification.
  app.use(
    "/v1/*",
    createWriteKeyMiddleware({
      store: init.writeKeys ?? null,
      required: () => requireBundle().requireWriteKey,
      publicPaths: () => requireBundle().publicPaths,
      now,
    }),
  );
  app.use("/v1/*", createAuthMiddleware({ requireBundle, contextFor: verifyContextFor }));

  const deps: RouteDeps = { requireBundle, runtimeFor, clientIp };
  app.post("/v1/chat/completions", createChatHandler(deps));
  app.get("/v1/models", createModelsHandler(deps));
  app.post("/v1/embeddings", createEmbeddingsHandler(deps));

  return { app, holder, storage, tracker };
}

/**
 * Build the app from a configuration known at startup.
 *
 * Convenience wrapper over {@link createOmniProxy} that keeps the historical
 * contract: an invalid configuration throws `ConfigError` here rather than
 * leaving a proxy that answers 503. Use `createOmniProxy` when configuration
 * arrives at runtime.
 */
export async function createOmniApp(init: OmniAppInit): Promise<Hono<AppEnv>> {
  const proxy = await createOmniProxy(init);
  const result = await proxy.holder.reload(init.config);
  if (!result.ok) throw new ConfigError(result.error);
  return proxy.app;
}
