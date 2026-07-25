import { ConfigError, silentLogger } from "@omni-model/core";
import { describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import { LATEST_VERSION, MIGRATIONS } from "../src/migrations/sql.js";
import type { PgPoolLike } from "../src/pool.js";
import { MigrationRecordingPool } from "./support/fake-pool.js";

describe("MIGRATIONS", () => {
  test("versions are gapless, start at 1, and never repeat", () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length);
    expect(LATEST_VERSION).toBe(MIGRATIONS.length);
  });

  test("only ever creates or alters omni_-prefixed relations", () => {
    // The package claims the `omni_` namespace; touching anything else would
    // collide with whatever else lives in the operator's database. A migration
    // that only ALTERs creates nothing, which is fine — the constraint is on the
    // names, not the count.
    // Identifiers may be quoted: drizzle-kit generates `CREATE TABLE "omni_kv"`,
    // while the hand-written trigger statements are unquoted.
    const touched: string[] = [];
    for (const migration of MIGRATIONS) {
      for (const [, name] of migration.sql.matchAll(
        /(?:CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)(?: IF NOT EXISTS)?|ALTER TABLE|DROP TRIGGER(?: IF EXISTS)?) "?(\w+)"?/g,
      )) {
        touched.push(name as string);
      }
    }
    expect(touched.length).toBeGreaterThan(0);
    for (const name of touched) expect(name).toMatch(/^omni_/);
  });

  test("never hardcodes a schema, so search_path decides where tables live", () => {
    // drizzle-kit emits `REFERENCES "public"."omni_…"`. Left in, that pins every
    // deployment to the `public` schema and breaks the documented "point it at
    // its own schema" isolation — silently, because the CREATEs are unqualified
    // and only the foreign keys fail.
    for (const migration of MIGRATIONS) {
      expect(migration.sql, `migration ${migration.version} qualifies a schema`).not.toMatch(
        /"?public"?\s*\.\s*"?omni_/i,
      );
    }
  });
});

describe("runMigrations", () => {
  test("applies every migration in order on an empty database", async () => {
    const pool = new MigrationRecordingPool();
    const result = await runMigrations(pool, { logger: silentLogger });

    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(result.version).toBe(LATEST_VERSION);
    expect(result.ahead).toBeUndefined();
    expect(pool.ledger).toEqual(new Set(MIGRATIONS.map((m) => m.version)));
  });

  test("takes the advisory lock before reading the ledger, inside a transaction", async () => {
    const pool = new MigrationRecordingPool();
    await runMigrations(pool);

    const sql = pool.normalized;
    const begin = sql.indexOf("BEGIN");
    const lock = sql.findIndex((s) => s.startsWith("SELECT pg_advisory_xact_lock"));
    const ledger = sql.findIndex((s) => s.startsWith("CREATE TABLE IF NOT EXISTS omni_migrations"));
    const read = sql.findIndex((s) => s.startsWith("SELECT version FROM omni_migrations"));

    // Ordering is the whole correctness argument for concurrent boots: read the
    // ledger before the lock and two instances can both decide to apply.
    expect(begin).toBe(0);
    expect(begin).toBeLessThan(lock);
    expect(lock).toBeLessThan(ledger);
    expect(ledger).toBeLessThan(read);
    expect(sql.at(-1)).toBe("COMMIT");
  });

  test("a second run on an up-to-date database applies nothing", async () => {
    const pool = new MigrationRecordingPool({
      applied: MIGRATIONS.map((migration) => migration.version),
    });
    const result = await runMigrations(pool);

    expect(result.applied).toEqual([]);
    expect(result.version).toBe(LATEST_VERSION);
    expect(pool.normalized).not.toContain(expect.stringContaining("INSERT INTO omni_migrations"));
  });

  test("applies only the pending tail when partially migrated", async () => {
    const pool = new MigrationRecordingPool({ applied: [1, 2] });
    const result = await runMigrations(pool);

    expect(result.applied).toEqual(MIGRATIONS.slice(2).map((migration) => migration.version));
  });

  test("running twice in a row is idempotent", async () => {
    const pool = new MigrationRecordingPool();
    const first = await runMigrations(pool);
    const second = await runMigrations(pool);

    expect(first.applied).toHaveLength(MIGRATIONS.length);
    expect(second.applied).toEqual([]);
    expect(pool.releaseCalls).toBe(2);
  });

  test("a failing migration rolls back and releases the connection", async () => {
    const pool = new MigrationRecordingPool({ failOn: "omni_write_keys" });

    await expect(runMigrations(pool)).rejects.toThrow(/simulated failure/);
    expect(pool.normalized).toContain("ROLLBACK");
    expect(pool.normalized).not.toContain("COMMIT");
    // Releasing matters: a leaked client would hold the advisory lock until the
    // pool is destroyed, blocking every other instance's boot.
    expect(pool.releaseCalls).toBe(1);
  });

  test("a database ahead of this build is reported, not rejected", async () => {
    // A rolling deploy runs old replicas against the new schema; failing here
    // would take them all down.
    const pool = new MigrationRecordingPool({
      applied: [...MIGRATIONS.map((m) => m.version), LATEST_VERSION + 3],
    });
    const result = await runMigrations(pool);

    expect(result.applied).toEqual([]);
    expect(result.ahead).toBe(LATEST_VERSION + 3);
    expect(result.version).toBe(LATEST_VERSION + 3);
  });

  test("rejects a pool without connect() and explains why", async () => {
    const stateless: PgPoolLike = { query: async () => ({ rows: [] }) };

    await expect(runMigrations(stateless)).rejects.toBeInstanceOf(ConfigError);
    await expect(runMigrations(stateless)).rejects.toThrow(/connect\(\)/);
  });

  test("propagates a connect() failure without leaking a release", async () => {
    const pool = new MigrationRecordingPool({ connectError: new Error("too many clients") });

    await expect(runMigrations(pool)).rejects.toThrow(/too many clients/);
    expect(pool.releaseCalls).toBe(0);
  });
});
