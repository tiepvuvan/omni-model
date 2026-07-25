import {
  type ConfigStore,
  EnvelopeSecretStore,
  type Keyring,
  type Logger,
  type SecretStore,
  type StorageAdapter,
} from "@omni-model/core";
import { PostgresConfigStore } from "./config-store.js";
import { runMigrations } from "./migrations/run.js";
import { createPgPool, type PgPoolLike } from "./pool.js";
import { PostgresSecretRowStore } from "./secret-store.js";
import { PostgresStorageAdapter } from "./storage.js";

export interface PostgresBackendOptions {
  url: string;
  /** Run pending migrations before returning. Default true. */
  migrate?: boolean;
  logger?: Logger;
  /** Forwarded to the config store; see its options. */
  pollIntervalMs?: number;
  /** Inject a pool instead of building one from `url` (tests, PgBouncer, RDS Proxy). */
  pool?: PgPoolLike;
  /**
   * Master keys for encrypted secrets. Without one there is no secret store, and
   * a configuration referencing a secret is rejected with a message saying so.
   */
  keyring?: Keyring;
}

/**
 * Everything the container needs from PostgreSQL, over **one** connection pool.
 *
 * Rate-limit counters and configuration live in the same database, so they
 * should share a pool: two pools would double the connection count for no
 * benefit and could disagree about availability during a failover.
 */
export interface PostgresBackend {
  pool: PgPoolLike;
  storage: StorageAdapter;
  configStore: ConfigStore;
  /** Null when no keyring was supplied. */
  secretStore: SecretStore | null;
  /** Closes the config store's watcher and then the pool. */
  close(): Promise<void>;
}

/**
 * Connect, migrate, and build the storage adapter and config store.
 *
 * Migrations run before either is handed back, so nothing can read a table that
 * does not exist yet.
 */
export async function createPostgresBackend(
  options: PostgresBackendOptions,
): Promise<PostgresBackend> {
  const pool = options.pool ?? (await createPgPool(options.url));
  try {
    if (options.migrate ?? true) {
      await runMigrations(pool, options.logger === undefined ? {} : { logger: options.logger });
    }
    const configStore = new PostgresConfigStore(pool, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    return {
      pool,
      storage: new PostgresStorageAdapter(pool),
      configStore,
      secretStore:
        options.keyring === undefined
          ? null
          : new EnvelopeSecretStore(new PostgresSecretRowStore(pool), options.keyring, {
              type: "postgres",
            }),
      close: async (): Promise<void> => {
        await configStore.close();
        await pool.end?.();
      },
    };
  } catch (error) {
    // Don't leak connections when migration fails at startup.
    await pool.end?.().catch(() => {});
    throw error;
  }
}
