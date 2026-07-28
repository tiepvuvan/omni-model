import { silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresConfigStore } from "../src/config-store.js";
import { runMigrations } from "../src/migrations/run.js";
import type { PgPoolLike } from "../src/pool.js";

/**
 * The config store against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL`
 * or run `pnpm test:pg`.
 *
 * Its own schema per run, so revision numbering starts at 1 and the
 * single-active constraint is exercised from a known state.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const schema = `omni_cs_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

describe.skipIf(!url)("PostgresConfigStore (integration)", () => {
  let admin: Pool;
  let store: PostgresConfigStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    const pool = scopedPool();
    await runMigrations(pool, { logger: silentLogger });
    store = new PostgresConfigStore(pool, { logger: silentLogger, pollIntervalMs: 100 });
  });

  afterAll(async () => {
    await store?.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    // End these one at a time. Each pool may still be settling a destroyed
    // LISTEN client; ending all of them concurrently can leave pg waiting for a
    // lifecycle callback and make the suite hang after every assertion passed.
    for (const pool of pools) {
      await pool.end().catch(() => {});
    }
  });

  test("starts empty, then round-trips a revision", async () => {
    expect(await store.loadActive()).toBeNull();

    const saved = await store.save(
      { version: 1, providers: { main: { type: "openai" } } },
      { createdBy: "alice", note: "first" },
    );

    expect(saved.revision).toBe(1);
    expect(saved.createdBy).toBe("alice");
    expect(saved.note).toBe("first");
    // JSONB round-trips as a real object, not a string.
    expect(saved.document).toEqual({ version: 1, providers: { main: { type: "openai" } } });
    expect(saved.createdAt).toBeGreaterThan(0);

    expect(await store.loadActive()).toMatchObject({ revision: 1 });
  });

  test("activating a new revision deactivates the previous one atomically", async () => {
    // The partial unique index means this only works if both statements are in
    // one transaction — otherwise the insert collides with the live row.
    const second = await store.save({ version: 1, note: "second" });
    expect(second.revision).toBe(2);

    const active = await store.loadActive();
    expect(active?.revision).toBe(2);

    const count = await (pools[0] as unknown as PgPoolLike).query(
      "SELECT count(*)::int AS n FROM omni_config_revisions WHERE is_active",
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  test("history is newest-first and marks the active revision", async () => {
    const history = await store.history();
    expect(history.map((entry) => [entry.revision, entry.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(history[1]?.createdBy).toBe("alice");
  });

  test("an old revision stays fetchable, which is what makes rollback possible", async () => {
    const first = await store.get(1);
    expect(first).toMatchObject({ revision: 1, createdBy: "alice" });

    // Rolling back is a new revision copying an old document — history is never
    // rewritten, so the audit trail survives.
    const rolledBack = await store.save(first?.document, { note: "rollback to 1" });
    expect(rolledBack.revision).toBe(3);
    expect(rolledBack.document).toEqual(first?.document);
    expect((await store.history()).map((entry) => entry.revision)).toEqual([3, 2, 1]);
  });

  test("get of an unknown revision is null, not an error", async () => {
    expect(await store.get(9999)).toBeNull();
  });

  test("a second instance learns about a revision saved by the first", async () => {
    // This is the whole point of the store: an admin API call on one replica has
    // to reconfigure the others.
    const other = new PostgresConfigStore(scopedPool(), {
      logger: silentLogger,
      pollIntervalMs: 100,
    });
    try {
      // Adopt the current revision first, so we only observe what comes next.
      await other.loadActive();

      const seen: number[] = [];
      const unwatch = other.watch((revision) => seen.push(revision));
      try {
        const saved = await store.save({ version: 1, note: "from the first instance" });

        await expect.poll(() => seen, { timeout: 5_000, interval: 50 }).toContain(saved.revision);
        // The document is readable from the other instance too.
        expect(await other.get(saved.revision)).toMatchObject({
          document: { note: "from the first instance" },
        });
      } finally {
        unwatch();
      }
    } finally {
      await other.close();
    }
  });

  test("a watcher is not woken by its own save", async () => {
    // Otherwise every admin write would cost the writing instance a redundant
    // rebuild of a bundle it had already applied.
    const seen: number[] = [];
    const unwatch = store.watch((revision) => seen.push(revision));
    try {
      await store.save({ version: 1, note: "self" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(seen).toEqual([]);
    } finally {
      unwatch();
    }
  });

  test("unsubscribing stops delivery", async () => {
    const other = new PostgresConfigStore(scopedPool(), {
      logger: silentLogger,
      pollIntervalMs: 100,
    });
    try {
      await other.loadActive();
      const seen: number[] = [];
      other.watch((revision) => seen.push(revision))();

      await store.save({ version: 1, note: "after unwatch" });
      await new Promise((resolve) => setTimeout(resolve, 400));

      expect(seen).toEqual([]);
    } finally {
      await other.close();
    }
  });
});
