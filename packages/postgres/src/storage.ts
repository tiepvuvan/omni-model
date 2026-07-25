import { ConfigError, type StorageAdapter, type StorageFactory } from "@omni-model/core";
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "./db.js";
import { runMigrations } from "./migrations/run.js";
import { createPgPool, type PgPoolLike } from "./pool.js";
import { kv } from "./schema.js";

/** Write operations between opportunistic expired-row sweeps. */
const CLEANUP_EVERY = 500;

/** `now() + <seconds> * interval '1 second'`, or NULL for no expiry. */
function expiryAfter(seconds: number | null) {
  // A NULL ttl propagates: now() + NULL * interval is NULL, i.e. never expires.
  return sql`now() + ${seconds}::float8 * interval '1 second'`;
}

/** True for a row whose TTL has passed. */
const isExpired = sql`${kv.expiresAt} IS NOT NULL AND ${kv.expiresAt} <= now()`;

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
  private readonly db: Db;
  private writeOps = 0;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
    this.db = createDb(pool);
  }

  async get(key: string): Promise<string | null> {
    const [row] = await this.db
      .select({ value: kv.value })
      .from(kv)
      .where(and(eq(kv.key, key), or(isNull(kv.expiresAt), gt(kv.expiresAt, sql`now()`))))
      .limit(1);
    return row?.value ?? null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const expiresAt = expiryAfter(options?.ttlSeconds ?? null);
    await this.db
      .insert(kv)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({
        target: kv.key,
        set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      });
    this.afterWrite();
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(kv).where(eq(kv.key, key));
    this.afterWrite();
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    // Single-statement upsert: ON CONFLICT sees the live row, so a logically
    // expired (but not yet swept) row is reset to the new amount with a fresh
    // TTL, while a live row accumulates and keeps its original expiry. Doing this
    // as a read-then-write would lose counts under concurrency.
    const [row] = await this.db
      .insert(kv)
      .values({ key, value: String(amount), expiresAt: expiryAfter(ttlSeconds) })
      .onConflictDoUpdate({
        target: kv.key,
        set: {
          value: sql`CASE WHEN ${isExpired} THEN excluded.value
            ELSE (${kv.value}::bigint + ${amount}::bigint)::text END`,
          expiresAt: sql`CASE WHEN ${isExpired} THEN excluded.expires_at
            ELSE ${kv.expiresAt} END`,
        },
      })
      .returning({ value: kv.value });
    this.afterWrite();
    if (row === undefined) {
      throw new Error(`postgres increment of "${key}" returned no row`);
    }
    return Number(row.value);
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
    this.db
      .delete(kv)
      .where(and(isNotNull(kv.expiresAt), lte(kv.expiresAt, sql`now()`)))
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
 * table, and the generated migration SQL cannot honour a rename. Point
 * omni-model at its own database or Postgres schema to isolate it.
 */
export const postgresStorageFactory: StorageFactory = {
  type: "postgres",
  optionsSchema: postgresOptionsSchema,
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
