import { ConfigError, type StorageAdapter, type StorageFactory } from "@omni-model/core";
import { z } from "zod";
import { runMigrations } from "./migrations/run.js";
import { createPgPool, type PgPoolLike } from "./pool.js";

/** Write operations between opportunistic expired-row sweeps. */
const CLEANUP_EVERY = 500;

/**
 * Postgres-backed storage on the `omni_kv` table. Every operation — including
 * {@link PostgresStorageAdapter.increment} — is one SQL statement, so counters
 * are atomic under concurrency across any number of proxy instances: the upsert
 * serializes on the row, the first writer of a key sets its TTL, and an expired
 * row is atomically reset to the new amount with a fresh TTL.
 *
 * Expired rows are filtered out of reads immediately but only physically
 * deleted by a background sweep fired every {@link CLEANUP_EVERY}-th write.
 *
 * The schema is owned by the migrations in `./migrations/`, not by this class:
 * one place creates tables, and it is guarded by an advisory lock.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  readonly type = "postgres";
  private readonly pool: PgPoolLike;
  private writeOps = 0;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.pool.query(
      "SELECT value FROM omni_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())",
      [key],
    );
    const value = result.rows[0]?.value;
    return typeof value === "string" ? value : null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    // A NULL ttl propagates: now() + NULL * interval is NULL, i.e. no expiry.
    await this.pool.query(
      "INSERT INTO omni_kv (key, value, expires_at) " +
        "VALUES ($1, $2, now() + $3::float8 * interval '1 second') " +
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at",
      [key, value, options?.ttlSeconds ?? null],
    );
    this.afterWrite();
  }

  async delete(key: string): Promise<void> {
    await this.pool.query("DELETE FROM omni_kv WHERE key = $1", [key]);
    this.afterWrite();
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    // Single-statement upsert: ON CONFLICT sees the live row, so a logically
    // expired (but not yet swept) row is reset to the new amount with a fresh
    // TTL, while a live row accumulates and keeps its original expiry.
    const result = await this.pool.query(
      "INSERT INTO omni_kv (key, value, expires_at) " +
        "VALUES ($1, $2::text, now() + $3::float8 * interval '1 second') " +
        "ON CONFLICT (key) DO UPDATE SET " +
        "value = CASE WHEN omni_kv.expires_at IS NOT NULL AND omni_kv.expires_at <= now() " +
        "THEN EXCLUDED.value ELSE (omni_kv.value::bigint + $2::bigint)::text END, " +
        "expires_at = CASE WHEN omni_kv.expires_at IS NOT NULL AND omni_kv.expires_at <= now() " +
        "THEN EXCLUDED.expires_at ELSE omni_kv.expires_at END " +
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
      .query("DELETE FROM omni_kv WHERE expires_at IS NOT NULL AND expires_at <= now()")
      .catch(() => {});
  }
}

const postgresOptionsSchema = z.strictObject({
  type: z.literal("postgres"),
  url: z.string().min(1),
  /**
   * Run pending migrations at startup. Default true. Set false when the
   * database user cannot run DDL; apply the schema out of band instead
   * (`runMigrations`, or the `migrate` CLI command).
   */
  migrate: z.boolean().optional(),
});

/**
 * Storage factory for `storage: { type: postgres, url: postgres://..., migrate? }`.
 *
 * There is deliberately no table-name option: this package owns every `omni_*`
 * table, and static migration SQL cannot honour a rename. Point omni-model at
 * its own database or Postgres schema to isolate it.
 */
export const postgresStorageFactory: StorageFactory = {
  type: "postgres",
  async create(options: Record<string, unknown>, runtime): Promise<StorageAdapter> {
    const parsed = postgresOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(`invalid postgres storage options:\n${z.prettifyError(parsed.error)}`);
    }
    const pool = await createPgPool(parsed.data.url);
    try {
      if (parsed.data.migrate ?? true) {
        await runMigrations(pool, { logger: runtime.log });
      }
      return new PostgresStorageAdapter(pool);
    } catch (error) {
      // Don't leak connections when migration fails at startup.
      await pool.end?.().catch(() => {});
      throw error;
    }
  },
};
