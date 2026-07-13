import { ConfigError, type StorageAdapter, type StorageFactory } from "@omni-model/core";
import { z } from "zod";

/**
 * Minimal structural subset of a `pg` Pool: parameterized `query` plus an
 * optional `end`. Tests stub it in memory, and embedders can inject their own
 * pool (PgBouncer, RDS Proxy, custom TLS) instead of going through
 * {@link postgresStorageFactory}.
 */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
}

/** The table name is interpolated into SQL, so it must be a plain identifier. */
const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Write operations between opportunistic expired-row sweeps. */
const CLEANUP_EVERY = 500;

export interface PostgresStorageAdapterOptions {
  /** Table name matching `[a-zA-Z_][a-zA-Z0-9_]*`. Default "omni_kv". */
  table?: string;
  /** Whether the factory runs {@link PostgresStorageAdapter.init} at startup. Default true. */
  migrate?: boolean;
}

/**
 * Postgres-backed storage on a single key/value table. Every operation —
 * including {@link increment} — is one SQL statement, so counters are atomic
 * under concurrency across any number of proxy instances: the upsert
 * serializes on the row, the first writer of a key sets its TTL, and an
 * expired row is atomically reset to the new amount with a fresh TTL.
 *
 * Expired rows are filtered out of reads immediately but only physically
 * deleted by a background sweep fired every {@link CLEANUP_EVERY}-th write.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  readonly type = "postgres";
  /** Whether the factory should run {@link init} when creating this adapter. */
  readonly migrate: boolean;
  private readonly pool: PgPoolLike;
  private readonly table: string;
  private writeOps = 0;

  constructor(pool: PgPoolLike, options: PostgresStorageAdapterOptions = {}) {
    const table = options.table ?? "omni_kv";
    if (!TABLE_NAME_PATTERN.test(table)) {
      throw new ConfigError(
        `invalid postgres table name "${table}": must match [a-zA-Z_][a-zA-Z0-9_]* ` +
          "because it is interpolated into SQL statements",
      );
    }
    this.pool = pool;
    this.table = table;
    this.migrate = options.migrate ?? true;
  }

  /**
   * Create the backing table and expiry index if they do not exist. The
   * factory calls this when `migrate` is enabled (the default); embedders
   * that manage schema themselves can disable `migrate` and either call this
   * manually or run equivalent DDL in their own migrations.
   */
  async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} ` +
        "(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TIMESTAMPTZ)",
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_expires_idx ON ${this.table} (expires_at)`,
    );
  }

  async get(key: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM ${this.table} ` +
        "WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())",
      [key],
    );
    const value = result.rows[0]?.value;
    return typeof value === "string" ? value : null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    // A NULL ttl propagates: now() + NULL * interval is NULL, i.e. no expiry.
    await this.pool.query(
      `INSERT INTO ${this.table} (key, value, expires_at) ` +
        "VALUES ($1, $2, now() + $3::float8 * interval '1 second') " +
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
      [key, value, options?.ttlSeconds ?? null],
    );
    this.afterWrite();
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
    this.afterWrite();
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    // Single-statement upsert: ON CONFLICT sees the live row, so a logically
    // expired (but not yet swept) row is reset to the new amount with a fresh
    // TTL, while a live row accumulates and keeps its original expiry.
    const t = this.table;
    const result = await this.pool.query(
      `INSERT INTO ${t} (key, value, expires_at) ` +
        "VALUES ($1, $2::text, now() + $3::float8 * interval '1 second') " +
        "ON CONFLICT (key) DO UPDATE SET " +
        `value = CASE WHEN ${t}.expires_at IS NOT NULL AND ${t}.expires_at <= now() ` +
        `THEN EXCLUDED.value ELSE (${t}.value::bigint + $2::bigint)::text END, ` +
        `expires_at = CASE WHEN ${t}.expires_at IS NOT NULL AND ${t}.expires_at <= now() ` +
        `THEN EXCLUDED.expires_at ELSE ${t}.expires_at END ` +
        "RETURNING value",
      [key, String(amount), ttlSeconds],
    );
    this.afterWrite();
    const value = result.rows[0]?.value;
    if (typeof value !== "string") {
      throw new Error(`postgres increment of "${key}" returned no row`);
    }
    return Number(value);
  }

  async getCounter(key: string): Promise<number> {
    const value = await this.get(key);
    return value === null ? 0 : Number(value);
  }

  /** Ends the underlying pool when it supports `end()` (the factory's pool does). */
  async close(): Promise<void> {
    await this.pool.end?.();
  }

  /** Fire-and-forget sweep of expired rows; failures wait for the next sweep. */
  private afterWrite(): void {
    this.writeOps += 1;
    if (this.writeOps % CLEANUP_EVERY !== 0) return;
    this.pool
      .query(`DELETE FROM ${this.table} WHERE expires_at IS NOT NULL AND expires_at <= now()`)
      .catch(() => {});
  }
}

const postgresOptionsSchema = z.strictObject({
  type: z.literal("postgres"),
  url: z.string().min(1),
  table: z.string().optional(),
  migrate: z.boolean().optional(),
});

/**
 * Storage factory for `storage: { type: postgres, url: postgres://..., table?, migrate? }`.
 * Imports `pg` lazily so the dependency is only loaded when Postgres storage
 * is actually configured.
 */
export const postgresStorageFactory: StorageFactory = {
  type: "postgres",
  async create(options: Record<string, unknown>): Promise<StorageAdapter> {
    const parsed = postgresOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(`invalid postgres storage options:\n${z.prettifyError(parsed.error)}`);
    }
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: parsed.data.url });
    try {
      const adapter = new PostgresStorageAdapter(pool, {
        table: parsed.data.table,
        migrate: parsed.data.migrate,
      });
      if (adapter.migrate) {
        await adapter.init();
      }
      return adapter;
    } catch (error) {
      // Don't leak connections when validation or migration fails at startup.
      await pool.end().catch(() => {});
      throw error;
    }
  },
};
