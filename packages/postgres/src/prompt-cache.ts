import type { CachedEntry, Logger, PromptCache, PromptCacheStats } from "@omni-model/core";
import { count, gt, lt, min, sql, sum } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import type { PgPoolLike } from "./pool.js";
import { promptCache } from "./schema.js";

/** Advisory-lock key for cache eviction. Arbitrary but permanent. */
const EVICT_LOCK_ID = 1_869_768_811;

/**
 * The response cache over `omni_prompt_cache`.
 *
 * Shared between replicas, which is the point: an answer paid for by one instance
 * should not be paid for again by the next request that lands elsewhere.
 *
 * Every method swallows its own failures and reports the degraded answer — a null,
 * a zero — because a cache that can fail a request is worse than no cache at all.
 * The one place that matters most is `get`: a database blip must read as a miss.
 */
export class PostgresPromptCache implements PromptCache {
  private readonly db: Db;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly logger?: Logger,
  ) {
    this.db = createDb(pool);
  }

  private failed(operation: string, error: unknown): void {
    this.logger?.warn(`prompt cache ${operation} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  async get(key: string): Promise<CachedEntry | null> {
    try {
      const [row] = await this.db
        .select()
        .from(promptCache)
        // Expiry is enforced on read as well as by the sweep: a row past its TTL
        // must never be served, including in the window before anything deletes it.
        .where(sql`${promptCache.key} = ${key} AND ${promptCache.expiresAt} > now()`)
        .limit(1);
      if (row === undefined) return null;

      const usage =
        row.totalTokens === null
          ? null
          : {
              prompt_tokens: row.promptTokens ?? 0,
              completion_tokens: row.completionTokens ?? 0,
              total_tokens: row.totalTokens,
            };
      if (row.kind === "stream") {
        return row.sse === null ? null : { kind: "stream", sse: row.sse, usage };
      }
      return row.completion === null
        ? null
        : { kind: "completion", completion: row.completion, usage };
    } catch (error) {
      this.failed("read", error);
      return null;
    }
  }

  async put(key: string, entry: CachedEntry, ttlSeconds: number): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(
        entry.kind === "stream" ? entry.sse : JSON.stringify(entry.completion),
      ).length;
      const values = {
        key,
        kind: entry.kind,
        completion: entry.kind === "completion" ? entry.completion : null,
        sse: entry.kind === "stream" ? entry.sse : null,
        promptTokens: entry.usage?.prompt_tokens ?? null,
        completionTokens: entry.usage?.completion_tokens ?? null,
        totalTokens: entry.usage?.total_tokens ?? null,
        bytes,
        expiresAt: sql`now() + ${ttlSeconds}::int * interval '1 second'`,
      };
      await this.db
        .insert(promptCache)
        .values(values)
        // A racing pair of identical requests both miss and both store. Upserting
        // makes that harmless — the second write refreshes the same row rather than
        // failing the request that was only trying to be helpful.
        .onConflictDoUpdate({ target: promptCache.key, set: { ...values, createdAt: sql`now()` } });
    } catch (error) {
      this.failed("write", error);
    }
  }

  async purge(): Promise<number> {
    try {
      const result = await this.db.delete(promptCache);
      return typeof result.rowCount === "number" ? result.rowCount : 0;
    } catch (error) {
      this.failed("purge", error);
      return 0;
    }
  }

  async stats(): Promise<PromptCacheStats> {
    try {
      const [row] = await this.db
        .select({
          entries: count(),
          oldest: min(promptCache.createdAt),
          bytes: sum(promptCache.bytes),
        })
        .from(promptCache)
        .where(gt(promptCache.expiresAt, sql`now()`));
      return {
        entries: Number(row?.entries ?? 0),
        oldestAt: row?.oldest instanceof Date ? row.oldest.getTime() : null,
        bytes: row?.bytes === null || row?.bytes === undefined ? null : Number(row.bytes),
      };
    } catch (error) {
      this.failed("stats", error);
      return { entries: 0, oldestAt: null, bytes: null };
    }
  }

  /**
   * Drop expired rows, then the oldest of whatever exceeds `maxEntries`.
   *
   * Guarded by `pg_try_advisory_lock`, non-blocking, exactly like the log sweep: a
   * replica that loses the race returns immediately instead of queueing behind
   * someone else's delete, so every replica can run this on a timer and only one
   * does the work.
   */
  async evict(maxEntries: number): Promise<number> {
    if (this.pool.connect === undefined) return 0;
    let client: Awaited<ReturnType<NonNullable<PgPoolLike["connect"]>>>;
    try {
      client = await this.pool.connect();
    } catch (error) {
      this.failed("eviction", error);
      return 0;
    }
    try {
      const acquired = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [
        EVICT_LOCK_ID,
      ]);
      if (acquired.rows[0]?.locked !== true) return 0;
      try {
        const expired = await this.db
          .delete(promptCache)
          .where(lt(promptCache.expiresAt, sql`now()`));
        // `DESC` then `OFFSET`: keep the newest `maxEntries` and delete what is
        // older. Ascending would have kept the oldest and thrown away everything
        // recent — the opposite of a cache.
        const overflow = await this.db.delete(promptCache).where(
          sql`${promptCache.key} IN (
            SELECT key FROM ${promptCache}
            ORDER BY created_at DESC
            OFFSET ${maxEntries}
          )`,
        );
        const removed =
          (typeof expired.rowCount === "number" ? expired.rowCount : 0) +
          (typeof overflow.rowCount === "number" ? overflow.rowCount : 0);
        if (removed > 0) this.logger?.info("evicted cached responses", { removed });
        return removed;
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [EVICT_LOCK_ID]);
      }
    } catch (error) {
      this.failed("eviction", error);
      return 0;
    } finally {
      client.release();
    }
  }
}
