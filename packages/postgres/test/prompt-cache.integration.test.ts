import { silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import type { PgPoolLike } from "../src/pool.js";
import { PostgresPromptCache } from "../src/prompt-cache.js";

/**
 * The response cache against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL`
 * or run `pnpm test:pg`.
 *
 * Worth a real database rather than only the fake pool: expiry, the upsert and
 * the eviction ordering are all SQL, and the memory implementation cannot tell
 * you whether that SQL is valid.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const schema = `omni_cache_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

describe.skipIf(!url)("PostgresPromptCache (integration)", () => {
  let admin: Pool;
  let cache: PostgresPromptCache;
  let pool: PgPoolLike;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = scopedPool();
    await runMigrations(pool, { logger: silentLogger });
    cache = new PostgresPromptCache(pool, silentLogger);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await Promise.all(pools.map((one) => one.end()));
    await admin.end();
  });

  test("round-trips a completion and its usage", async () => {
    await cache.put(
      "k-completion",
      {
        kind: "completion",
        completion: { id: "up-1", choices: [{ index: 0, message: { content: "hi" } }] },
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      60,
    );

    expect(await cache.get("k-completion")).toEqual({
      kind: "completion",
      completion: { id: "up-1", choices: [{ index: 0, message: { content: "hi" } }] },
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  });

  test("round-trips a streamed answer's raw SSE", async () => {
    await cache.put(
      "k-stream",
      { kind: "stream", sse: 'data: {"a":1}\n\ndata: [DONE]\n\n', usage: null },
      60,
    );

    expect(await cache.get("k-stream")).toEqual({
      kind: "stream",
      sse: 'data: {"a":1}\n\ndata: [DONE]\n\n',
      usage: null,
    });
  });

  test("answers a miss for an unknown key", async () => {
    expect(await cache.get("nothing-here")).toBeNull();
  });

  test("refuses to serve an expired row even before it is deleted", async () => {
    // Expiry is enforced on read, not only by the sweep: a zero-second TTL is
    // already stale, and the row is still there.
    await cache.put("k-expired", { kind: "completion", completion: { id: "x" }, usage: null }, 0);

    expect(await cache.get("k-expired")).toBeNull();
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM omni_prompt_cache WHERE key = $1`,
      ["k-expired"],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  test("replaces rather than failing when the same key is stored twice", async () => {
    // Two identical requests can both miss and both store. Upserting makes that
    // harmless instead of failing the second one for being helpful.
    await cache.put("k-race", { kind: "completion", completion: { id: "first" }, usage: null }, 60);
    await cache.put(
      "k-race",
      { kind: "completion", completion: { id: "second" }, usage: null },
      60,
    );

    const hit = await cache.get("k-race");
    expect(hit).toMatchObject({ completion: { id: "second" } });
  });

  test("reports what is in it, ignoring expired rows", async () => {
    const fresh = new PostgresPromptCache(scopedPool(), silentLogger);
    const stats = await fresh.stats();

    // `k-expired` is present but stale, so it must not be counted.
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.oldestAt).not.toBeNull();
  });

  test("evicts expired rows and then the oldest overflow", async () => {
    const own = `omni_evict_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${own}`);
    try {
      const isolated = new Pool({ connectionString: url, options: `-c search_path=${own}` });
      pools.push(isolated);
      const scoped = isolated as unknown as PgPoolLike;
      await runMigrations(scoped, { logger: silentLogger });
      const store = new PostgresPromptCache(scoped, silentLogger);

      for (const key of ["a", "b", "c", "d"]) {
        await store.put(key, { kind: "completion", completion: { key }, usage: null }, 60);
      }
      await store.put("stale", { kind: "completion", completion: {}, usage: null }, 0);

      // One expired plus two over the cap of two.
      expect(await store.evict(2)).toBe(3);
      expect((await store.stats()).entries).toBe(2);
      // Oldest first, so the two most recent survive.
      expect(await store.get("a")).toBeNull();
      expect(await store.get("d")).not.toBeNull();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${own} CASCADE`);
    }
  });

  test("purges everything", async () => {
    expect(await cache.purge()).toBeGreaterThan(0);
    expect((await cache.stats()).entries).toBe(0);
  });
});
