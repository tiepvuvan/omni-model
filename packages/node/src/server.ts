import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  type BundleHolder,
  ConfigError,
  type ConfigStore,
  createConsoleLogger,
  createDefaultRegistry,
  createOmniProxy,
  environmentConfigDocument,
  extractClientIp,
  type FirebaseAppCheckTokenConsumer,
  hasEnvironmentConfig,
  interpolateDeep,
  type Logger,
  type LogLevel,
  MemoryConfigStore,
  type RuntimeContext,
  type StorageAdapter,
} from "@omni-model/core";
import { createPostgresBackend, postgresStorageFactory } from "@omni-model/postgres";

/**
 * Resolve the GCP/Firebase project for the Admin SDK. There is no metadata
 * server in a plain container, so this must be set explicitly in the
 * environment when the App Check verifier runs with `consume: true`.
 */
function firebaseProjectId(env: Record<string, string | undefined>): string | undefined {
  return env.GOOGLE_CLOUD_PROJECT ?? env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT;
}

/** Initialize or reuse the Admin SDK app backed by Application Default Credentials. */
async function firebaseAdminApp(env: Record<string, string | undefined>) {
  const { getApps, initializeApp } = await import("firebase-admin/app");
  const projectId = firebaseProjectId(env);
  return getApps()[0] ?? initializeApp(projectId ? { projectId } : undefined);
}

/** Build the Firebase Admin replay-protection hook used by the App Check verifier. */
async function firebaseAppCheckTokenConsumer(env: Record<string, string | undefined>) {
  const [app, { getAppCheck }] = await Promise.all([
    firebaseAdminApp(env),
    import("firebase-admin/app-check"),
  ]);
  const appCheck = getAppCheck(app);
  return async (token: string) => {
    const result = await appCheck.verifyToken(token, { consume: true });
    return { alreadyConsumed: result.alreadyConsumed === true };
  };
}

/**
 * A consumer that initializes firebase-admin on first use.
 *
 * App Check `consume` can now be switched on through the admin API, so the hook
 * has to exist before anyone asks for it — otherwise enabling replay protection
 * would need a restart. Initialization failures surface on the first consuming
 * request, which fails closed, and the bootstrap path below additionally warms
 * this eagerly so credential problems show up at boot when they can.
 */
function lazyAppCheckConsumer(
  env: Record<string, string | undefined>,
): FirebaseAppCheckTokenConsumer & { warm: () => Promise<void> } {
  let pending: Promise<(token: string) => Promise<{ alreadyConsumed: boolean }>> | undefined;
  const resolve = (): Promise<(token: string) => Promise<{ alreadyConsumed: boolean }>> => {
    pending ??= firebaseAppCheckTokenConsumer(env);
    return pending;
  };
  const consumer = async (token: string) => (await resolve())(token);
  return Object.assign(consumer, {
    warm: async (): Promise<void> => {
      await resolve();
    },
  });
}

/** Bootstrap readers. These must work on a document that fails validation. */
function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawStorage(document: unknown): Record<string, unknown> | undefined {
  return rawRecord(rawRecord(document)?.storage);
}

function rawLogLevel(document: unknown, env: Record<string, string | undefined>): LogLevel {
  const levels = ["debug", "info", "warn", "error", "silent"];
  const fromEnv = env.OMNI_LOG_LEVEL;
  if (fromEnv !== undefined && levels.includes(fromEnv)) return fromEnv as LogLevel;
  const fromDoc = rawRecord(rawRecord(document)?.server)?.logLevel;
  return typeof fromDoc === "string" && levels.includes(fromDoc) ? (fromDoc as LogLevel) : "info";
}

function rawConsumesAppCheck(document: unknown): boolean {
  const providers = rawRecord(rawRecord(document)?.security)?.providers;
  if (!Array.isArray(providers)) return false;
  return providers.some((entry) => {
    const provider = rawRecord(entry);
    return provider?.type === "firebase-app-check" && provider.consume === true;
  });
}

/** Options for {@link startServer}. */
export interface StartOptions {
  /**
   * Bootstrap configuration document, typically from `resolveConfigSource`.
   * Used to pick the storage backend and, on first boot, seeded into the config
   * store as revision 1. Omit it to boot unconfigured.
   */
  config?: Record<string, unknown>;
  /**
   * Environment for `${VAR}` interpolation and component runtime access
   * (pass `process.env` in production). Defaults to `{}`.
   */
  env?: Record<string, string | undefined>;
  /** Fetch implementation for upstreams. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Port to bind; `0` picks an ephemeral port. Defaults to `env.PORT`, then 8787. */
  port?: number;
  /** Interface to bind. Defaults to "0.0.0.0" (all interfaces, for containers). */
  hostname?: string;
  /** Defaults to a console logger at the bootstrap `server.logLevel`. */
  logger?: Logger;
  /** Inject a config store (tests); otherwise derived from the storage backend. */
  configStore?: ConfigStore;
  /** Inject storage (tests); otherwise built from the bootstrap `storage` block. */
  storage?: StorageAdapter;
}

/** Handle to a running omni-model HTTP server. */
export interface RunningServer {
  /** The actually bound port (useful with `port: 0`). */
  port: number;
  /** The actually bound address. */
  hostname: string;
  /** Reconfigure this instance directly, bypassing the store. */
  holder: BundleHolder;
  /** Where configuration revisions live; saving one reconfigures every instance. */
  configStore: ConfigStore;
  /** Stop accepting connections, stop watching for config changes, close storage. */
  close(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse a port from the environment. Returns `undefined` for unset/blank/NaN
 * so the caller can fall back to the default, while preserving an explicit
 * `0` (bind an ephemeral port) — which `Number(x) || default` would discard.
 */
function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : undefined;
}

interface Backend {
  storage: StorageAdapter;
  configStore: ConfigStore;
  close(): Promise<void>;
}

/**
 * Storage and the config store come from the same place, over one pool when
 * that place is Postgres. Storage is bootstrap-level on purpose: a running proxy
 * cannot be moved to a different database by saving a new revision.
 */
async function createBackend(
  document: unknown,
  runtime: RuntimeContext,
  logger: Logger,
  options: StartOptions,
): Promise<Backend> {
  if (options.storage !== undefined) {
    const storage = options.storage;
    const configStore: ConfigStore = options.configStore ?? new MemoryConfigStore();
    return {
      storage,
      configStore,
      close: async () => {
        await configStore.close?.();
        await storage.close?.();
      },
    };
  }

  const storageConfig = rawStorage(document);
  const type = typeof storageConfig?.type === "string" ? storageConfig.type : "memory";

  if (type === "postgres") {
    const url = storageConfig?.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new ConfigError("storage.postgres requires a url (set OMNI_STORAGE_POSTGRES_URL)");
    }
    const backend = await createPostgresBackend({
      url,
      logger,
      ...(storageConfig?.migrate === false ? { migrate: false } : {}),
    });
    return {
      storage: backend.storage,
      configStore: options.configStore ?? backend.configStore,
      close: () => backend.close(),
    };
  }

  const registry = createDefaultRegistry();
  const factory = registry.storage.get(type);
  if (factory === undefined) {
    // Storage is bootstrap-level, so this is fatal: unlike the rest of the
    // configuration there is no "serve 503 until it is fixed" path — without
    // storage there is nowhere to read a corrected configuration from.
    const registered = [...registry.storage.keys(), postgresStorageFactory.type].sort().join(", ");
    throw new ConfigError(
      `storage: unknown type "${type}" (registered storage types: ${registered})`,
    );
  }
  const storage = await factory.create(storageConfig ?? { type }, runtime);
  // Memory storage has no shared config store, so revisions live in-process and
  // vanish on restart. Fine for development; the warning says so out loud.
  if (options.configStore === undefined) {
    logger.warn(
      "using in-memory configuration storage: revisions are not shared between instances and " +
        "are lost on restart. Set OMNI_STORAGE_TYPE=postgres for a real deployment.",
    );
  }
  const configStore: ConfigStore = options.configStore ?? new MemoryConfigStore();
  return {
    storage,
    configStore,
    close: async () => {
      await configStore.close?.();
      await storage.close?.();
    },
  };
}

/**
 * Boot the proxy: resolve storage, load the active configuration revision (or
 * seed it from the environment on first boot), serve HTTP, and keep watching
 * for revisions activated by other instances.
 *
 * The server starts even with no usable configuration — `/healthz` answers,
 * `/v1/*` returns 503, and `/readyz` explains why. That is what makes a fresh
 * container configurable rather than crash-looping.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? {};
  const bootstrap =
    options.config ?? (hasEnvironmentConfig(env) ? environmentConfigDocument(env) : undefined);
  // Two views of the same document, on purpose:
  //   - `bootstrap` keeps its `${VAR}` references and is what gets *stored*, so
  //     the database never holds a secret.
  //   - `resolved` has them substituted and is what the bootstrap reader below
  //     needs, since a literal "${DATABASE_URL}" is not a connection string.
  const resolved = bootstrap === undefined ? undefined : interpolateDeep(bootstrap, env);
  const logger = options.logger ?? createConsoleLogger(rawLogLevel(resolved, env));
  const appCheck = lazyAppCheckConsumer(env);

  const runtime: RuntimeContext = {
    env,
    fetch: (...args: Parameters<typeof fetch>) => fetchImpl(...args),
    now: Date.now,
    // Node has no execution context to extend; run the work fire-and-forget.
    waitUntil: (promise: Promise<unknown>): void => {
      void promise.catch((error) => {
        logger.error("background task failed", { error: describeError(error) });
      });
    },
    consumeFirebaseAppCheckToken: appCheck,
    log: logger,
  };

  const backend = await createBackend(resolved, runtime, logger, options);
  let unwatch: (() => void) | undefined;

  try {
    // Surface credential problems at boot when the bootstrap config already
    // wants replay protection, rather than on the first consuming request.
    if (rawConsumesAppCheck(resolved)) await appCheck.warm();

    const { app, holder } = await createOmniProxy({
      env,
      storage: backend.storage,
      logger: options.logger,
      fetch: fetchImpl,
      consumeFirebaseAppCheckToken: appCheck,
      // Behind a trusted proxy, derive the IP from headers; otherwise use the
      // real socket peer, which a client cannot spoof.
      clientIp: (c, trustProxyHeaders) =>
        trustProxyHeaders
          ? extractClientIp(c.req.raw.headers, true)
          : (getConnInfo(c).remote.address ?? null),
    });

    await applyInitialConfig(holder, backend.configStore, bootstrap, logger);

    unwatch = backend.configStore.watch((revision) => {
      void reloadRevision(holder, backend.configStore, revision, logger);
    });

    const port = options.port ?? parsePort(env.PORT) ?? 8787;
    const hostname = options.hostname ?? "0.0.0.0";

    let onListening: (info: AddressInfo) => void = () => {};
    let onError: (error: Error) => void = () => {};
    const listening = new Promise<AddressInfo>((resolve, reject) => {
      onListening = resolve;
      onError = reject;
    });
    const server: ServerType = serve({ fetch: app.fetch, port, hostname }, onListening);
    server.once("error", onError);
    const info = await listening;
    server.removeListener("error", onError);

    logger.info(`listening on http://${info.address}:${info.port}`);

    return {
      port: info.port,
      hostname: info.address,
      holder,
      configStore: backend.configStore,
      close: async (): Promise<void> => {
        try {
          unwatch?.();
          // Without this, keep-alive sockets keep `close()` pending until
          // clients hang up on their own.
          if ("closeIdleConnections" in server) server.closeIdleConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        } finally {
          await backend.close();
        }
      },
    };
  } catch (error) {
    // Startup failed after the backend was created; don't leak its connections.
    unwatch?.();
    try {
      await backend.close();
    } catch {
      // The original startup error is the one worth surfacing.
    }
    throw error;
  }
}

/**
 * Adopt the stored configuration, seeding it from the environment on first boot.
 *
 * The seed exists so an automated deploy can reach a working state unattended:
 * without it, a fresh container would always need a human to POST a
 * configuration before it served anything. It runs only when the store is
 * empty, so Postgres stays authoritative from then on.
 */
async function applyInitialConfig(
  holder: BundleHolder,
  configStore: ConfigStore,
  bootstrap: Record<string, unknown> | undefined,
  logger: Logger,
): Promise<void> {
  const active = await configStore.loadActive();
  if (active !== null) {
    const result = await holder.reload(active.document, { revision: active.revision });
    if (!result.ok) {
      logger.error("stored configuration is not usable; serving 503 on /v1 until it is fixed", {
        revision: active.revision,
        error: result.error,
      });
    }
    return;
  }

  if (bootstrap === undefined) {
    logger.warn("no configuration found; /v1 will answer 503 until one is saved");
    return;
  }

  // Validate before persisting: a rejected seed should not become revision 1.
  const result = await holder.reload(bootstrap);
  if (!result.ok) {
    logger.error("environment configuration is not usable; nothing was seeded", {
      error: result.error,
    });
    return;
  }
  const saved = await configStore.save(bootstrap, {
    createdBy: "bootstrap",
    note: "seeded from environment configuration on first boot",
  });
  // Re-apply so the live bundle carries the revision it was stored as.
  await holder.reload(saved.document, { revision: saved.revision });
  logger.info("seeded configuration from the environment", { revision: saved.revision });
}

/** Adopt a revision activated elsewhere. Must never throw: it runs from a watcher. */
async function reloadRevision(
  holder: BundleHolder,
  configStore: ConfigStore,
  revision: number,
  logger: Logger,
): Promise<void> {
  try {
    if (holder.status().revision === revision) return;
    const stored = await configStore.get(revision);
    if (stored === null) {
      logger.warn("configuration revision disappeared before it could be loaded", { revision });
      return;
    }
    const result = await holder.reload(stored.document, { revision });
    if (!result.ok) {
      logger.error("rejected a configuration revision; keeping the previous one", {
        revision,
        error: result.error,
      });
    }
  } catch (error) {
    logger.error("failed to load a configuration revision", {
      revision,
      error: describeError(error),
    });
  }
}
