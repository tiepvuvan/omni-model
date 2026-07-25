import { silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import { LATEST_VERSION, MIGRATIONS } from "../src/migrations/sql.js";
import type { PgPoolLike } from "../src/pool.js";
import { PostgresStorageAdapter } from "../src/storage.js";

/**
 * Integration tests against a real PostgreSQL server. Opt in with
 * `TEST_POSTGRES_URL`, or run `pnpm test:pg`, which starts one via
 * `docker-compose.test.yml`.
 *
 * Each run gets its own Postgres **schema**, so migrations always execute
 * against a genuinely empty database and parallel runs cannot collide. That is
 * what makes "applies cleanly from scratch" a real assertion rather than a
 * statement about leftover state.
 */
const url = process.env.TEST_POSTGRES_URL;

// A skipped suite looks exactly like a passing one, so CI sets OMNI_REQUIRE_PG
// to assert the gate was actually open. Without this, losing the database
// service would quietly stop testing any of the SQL below.
if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error(
    "OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset: the integration suite would have " +
      "skipped itself silently.",
  );
}

// Unique per run, and a valid unquoted identifier.
const schema = `omni_it_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

/** A pool whose every connection resolves unqualified names inside `schema`. */
function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

async function tableNames(pool: PgPoolLike): Promise<string[]> {
  const result = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
    [schema],
  );
  return result.rows.map((row) => String(row.tablename));
}

describe.skipIf(!url)("postgres integration", () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await Promise.all(pools.map((pool) => pool.end().catch(() => {})));
  });

  test("applies the whole schema from scratch", async () => {
    const pool = scopedPool();
    const result = await runMigrations(pool, { logger: silentLogger });

    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(result.version).toBe(LATEST_VERSION);
    expect(await tableNames(pool)).toEqual([
      "omni_config_revisions",
      "omni_kv",
      "omni_migrations",
      "omni_request_contents",
      "omni_request_logs",
      "omni_secrets",
      "omni_write_keys",
    ]);
  });

  test("re-running is a no-op", async () => {
    const pool = scopedPool();
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
    expect(result.version).toBe(LATEST_VERSION);

    const ledger = await pool.query("SELECT count(*)::int AS n FROM omni_migrations");
    expect(ledger.rows[0]?.n).toBe(MIGRATIONS.length);
  });

  test("concurrent runners on a fresh schema apply each migration exactly once", async () => {
    // `version` is a PRIMARY KEY, so a lost race surfaces as a unique violation.
    // All six resolving IS the proof the advisory lock serialized them.
    const raceSchema = `${schema}_race`;
    await admin.query(`CREATE SCHEMA ${raceSchema}`);
    const racers = Array.from({ length: 6 }, () => {
      const pool = new Pool({ connectionString: url, options: `-c search_path=${raceSchema}` });
      pools.push(pool);
      return pool as unknown as PgPoolLike;
    });

    try {
      const results = await Promise.all(racers.map((pool) => runMigrations(pool)));

      // Exactly one runner did the work; the rest found it done.
      const didWork = results.filter((result) => result.applied.length > 0);
      expect(didWork).toHaveLength(1);
      expect(didWork[0]?.applied).toEqual(MIGRATIONS.map((m) => m.version));
      for (const result of results) expect(result.version).toBe(LATEST_VERSION);

      const ledger = await (racers[0] as PgPoolLike).query(
        "SELECT count(*)::int AS n FROM omni_migrations",
      );
      expect(ledger.rows[0]?.n).toBe(MIGRATIONS.length);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${raceSchema} CASCADE`);
    }
  });

  test("kv roundtrip and real TTL expiry", async () => {
    const adapter = new PostgresStorageAdapter(scopedPool());
    await adapter.put("k", "v");
    expect(await adapter.get("k")).toBe("v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();

    await adapter.put("t", "v", { ttlSeconds: 1 });
    expect(await adapter.get("t")).toBe("v");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await adapter.get("t")).toBeNull();
  });

  test("counters stay exact under concurrency across separate pools", async () => {
    // This is the claim the docs make about scaling out: two proxy instances
    // sharing one database must not lose an increment.
    const a = new PostgresStorageAdapter(scopedPool());
    const b = new PostgresStorageAdapter(scopedPool());
    const key = `concurrent-${Date.now()}`;

    const bumps = Array.from({ length: 100 }, (_, i) =>
      (i % 2 === 0 ? a : b).increment(key, 1, 300),
    );
    const values = await Promise.all(bumps);

    expect(await a.getCounter(key)).toBe(100);
    // Every caller saw a distinct post-increment value: none were lost or reused.
    expect(new Set(values).size).toBe(100);
  });

  test("at most one config revision can be active", async () => {
    const pool = scopedPool();
    await pool.query(
      "INSERT INTO omni_config_revisions (document, is_active) VALUES ($1::jsonb, TRUE)",
      ['{"version":1}'],
    );
    await expect(
      pool.query(
        "INSERT INTO omni_config_revisions (document, is_active) VALUES ($1::jsonb, TRUE)",
        ['{"version":1}'],
      ),
    ).rejects.toThrow(/omni_config_revisions_active_idx|duplicate key/);

    // Inactive rows are unconstrained, so history accumulates freely.
    await pool.query("INSERT INTO omni_config_revisions (document) VALUES ($1::jsonb)", [
      '{"version":1}',
    ]);
    const count = await pool.query("SELECT count(*)::int AS n FROM omni_config_revisions");
    expect(count.rows[0]?.n).toBe(2);
  });

  test("activating a revision notifies listeners", async () => {
    // Phase 2 relies on this to reload config without polling.
    const pool = scopedPool();
    // Own the table for this test so it does not depend on what ran before.
    await pool.query("DELETE FROM omni_config_revisions");
    const inserted = await pool.query(
      "INSERT INTO omni_config_revisions (document) VALUES ('{}'::jsonb) RETURNING id",
    );
    const id = String(inserted.rows[0]?.id);

    const listenerPool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    pools.push(listenerPool);
    const listener = await listenerPool.connect();
    try {
      const received = new Promise<string>((resolve) => {
        listener.on("notification", (message) => resolve(message.payload ?? ""));
      });
      // LISTEN must be established first: a NOTIFY reaches only the sessions
      // listening at commit time, which is exactly why Phase 2 also polls.
      await listener.query("LISTEN omni_config_changed");

      await pool.query("UPDATE omni_config_revisions SET is_active = TRUE WHERE id = $1", [id]);

      await expect(received).resolves.toBe(id);
    } finally {
      listener.release(true);
    }
  });

  test("request logs cascade with their content but survive a revoked write key", async () => {
    const pool = scopedPool();
    const key = await pool.query(
      "INSERT INTO omni_write_keys (name, key_hash, prefix, last4) " +
        "VALUES ('test', $1, 'omk_live_', 'abcd') RETURNING id",
      [`hash-${Date.now()}`],
    );
    const keyId = String(key.rows[0]?.id);

    const log = await pool.query(
      "INSERT INTO omni_request_logs (write_key_id, model_requested, status) " +
        "VALUES ($1, 'gpt-4o-mini', 200) RETURNING id",
      [keyId],
    );
    const logId = String(log.rows[0]?.id);
    await pool.query(
      "INSERT INTO omni_request_contents (request_log_id, completion) VALUES ($1, 'hi')",
      [logId],
    );

    // Hard-deleting a key must not erase its usage history.
    await pool.query("DELETE FROM omni_write_keys WHERE id = $1", [keyId]);
    const orphan = await pool.query("SELECT write_key_id FROM omni_request_logs WHERE id = $1", [
      logId,
    ]);
    expect(orphan.rows[0]?.write_key_id).toBeNull();

    // Content, by contrast, is owned by its log row.
    await pool.query("DELETE FROM omni_request_logs WHERE id = $1", [logId]);
    const contents = await pool.query(
      "SELECT count(*)::int AS n FROM omni_request_contents WHERE request_log_id = $1",
      [logId],
    );
    expect(contents.rows[0]?.n).toBe(0);
  });
});
