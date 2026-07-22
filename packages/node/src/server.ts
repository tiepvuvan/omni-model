import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  ConfigError,
  createConsoleLogger,
  createDefaultRegistry,
  createOmniApp,
  extractClientIp,
  type Logger,
  type OmniConfig,
  parseConfigObject,
  type RuntimeContext,
  type StorageAdapter,
  type StorageFactory,
} from "@omni-model/core";
import type { FirestoreLike } from "@omni-model/storage-firestore";
import { postgresStorageFactory } from "@omni-model/storage-postgres";
import { redisStorageFactory } from "@omni-model/storage-redis";
import { enrichGcpEnvironment } from "./gcp-metadata.js";

function firebaseProjectId(env: Record<string, string | undefined>): string | undefined {
  return env.GOOGLE_CLOUD_PROJECT ?? env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT;
}

/** Initialize or reuse the Admin SDK app backed by Application Default Credentials. */
async function firebaseAdminApp(env: Record<string, string | undefined>) {
  const { getApps, initializeApp } = await import("firebase-admin/app");
  const projectId = firebaseProjectId(env);
  return getApps()[0] ?? initializeApp(projectId ? { projectId } : undefined);
}

/**
 * Build the Firestore storage factory (serverless rate limits for Cloud Run /
 * GCE / Firebase). Firestore auth uses Application Default Credentials — the
 * service account on Cloud Run, `GOOGLE_APPLICATION_CREDENTIALS` locally, or a
 * local emulator via `FIRESTORE_EMULATOR_HOST`. The GCP startup adapter fills
 * `GOOGLE_CLOUD_PROJECT` from metadata when available; `FIREBASE_PROJECT_ID`
 * remains a manual fallback. `FIRESTORE_DATABASE_ID` selects a non-default
 * database. firebase-admin is imported lazily so only Firestore deployments
 * or App Check replay-protected deployments load it.
 */
async function firestoreStorageFactory(
  env: Record<string, string | undefined>,
): Promise<StorageFactory> {
  const { getFirestore } = await import("firebase-admin/firestore");
  const { createFirestoreStorageFactory } = await import("@omni-model/storage-firestore");
  const app = await firebaseAdminApp(env);
  const databaseId = env.FIRESTORE_DATABASE_ID;
  const firestore = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  return createFirestoreStorageFactory(firestore as unknown as FirestoreLike);
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

function consumesFirebaseAppCheckTokens(config: OmniConfig): boolean {
  return config.security.providers.some(
    (provider) => provider.type === "firebase-app-check" && provider.consume === true,
  );
}

/** Options for {@link startServer}. */
export interface StartOptions {
  /** Raw configuration object, typically from `resolveConfigSource`. */
  config: Record<string, unknown>;
  /**
   * Environment for `${VAR}` interpolation and component runtime access
   * (pass `process.env` in production). Defaults to `{}`.
   */
  env?: Record<string, string | undefined>;
  /** Fetch implementation for upstreams and GCP metadata discovery. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Port to bind; `0` picks an ephemeral port. Defaults to `env.PORT`, then 8787. */
  port?: number;
  /** Interface to bind. Defaults to "0.0.0.0" (all interfaces, for containers). */
  hostname?: string;
  /** Defaults to a console logger at the configured `server.logLevel`. */
  logger?: Logger;
}

/** Handle to a running omni-model HTTP server. */
export interface RunningServer {
  /** The actually bound port (useful with `port: 0`). */
  port: number;
  /** The actually bound address. */
  hostname: string;
  /** Stop accepting connections, then close the storage backend. */
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

async function closeStorage(storage: StorageAdapter): Promise<void> {
  await storage.close?.();
}

/**
 * Validate the environment-derived configuration, construct storage from the registry (built-ins plus
 * the Redis, Postgres and Firestore backends), build the omni app and serve it over
 * HTTP. The returned handle owns the storage lifecycle: `close()` stops the
 * HTTP server first, then closes the storage adapter.
 */
export async function startServer(options: StartOptions): Promise<RunningServer> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = await enrichGcpEnvironment({
    config: options.config,
    env: options.env ?? {},
    fetch: fetchImpl,
  });
  const config = parseConfigObject(options.config, env);
  const logger = options.logger ?? createConsoleLogger(config.server.logLevel);
  const consumeFirebaseAppCheckToken = consumesFirebaseAppCheckTokens(config)
    ? await firebaseAppCheckTokenConsumer(env)
    : undefined;

  const registry = createDefaultRegistry();
  registry.storage.set(redisStorageFactory.type, redisStorageFactory);
  registry.storage.set(postgresStorageFactory.type, postgresStorageFactory);
  // Firestore needs a credentialed admin instance (not a URL), so it is wired
  // in on demand — only when selected, so non-Firestore deploys skip firebase-admin.
  if (config.storage.type === "firestore") {
    registry.storage.set("firestore", await firestoreStorageFactory(env));
  }

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
    ...(consumeFirebaseAppCheckToken === undefined ? {} : { consumeFirebaseAppCheckToken }),
    log: logger,
  };

  const factory = registry.storage.get(config.storage.type);
  if (factory === undefined) {
    const registered = [...registry.storage.keys()].sort().join(", ");
    throw new ConfigError(
      `storage: unknown type "${config.storage.type}" (registered storage types: ${registered})`,
    );
  }
  const storage = await factory.create(config.storage, runtime);

  try {
    const app = await createOmniApp({
      config,
      registry,
      env,
      storage,
      logger,
      // Behind a trusted proxy, derive the IP from headers; otherwise use the
      // real socket peer, which a client cannot spoof.
      clientIp: (c) =>
        config.server.trustProxyHeaders
          ? extractClientIp(c.req.raw.headers, true)
          : (getConnInfo(c).remote.address ?? null),
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
      close: async (): Promise<void> => {
        try {
          // Without this, keep-alive sockets keep `close()` pending until
          // clients hang up on their own.
          if ("closeIdleConnections" in server) server.closeIdleConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          });
        } finally {
          await closeStorage(storage);
        }
      },
    };
  } catch (error) {
    // Startup failed after storage was created; don't leak its connections.
    try {
      await closeStorage(storage);
    } catch {
      // The original startup error is the one worth surfacing.
    }
    throw error;
  }
}
