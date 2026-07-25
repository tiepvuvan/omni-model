import { CachedWriteKeyStore, silentLogger, writeKeyState } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import type { PgPoolLike } from "../src/pool.js";
import { PostgresWriteKeyStore } from "../src/write-key-store.js";

/**
 * Write keys against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL` or run
 * `pnpm test:pg`.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const schema = `omni_wk_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

describe.skipIf(!url)("PostgresWriteKeyStore (integration)", () => {
  let admin: Pool;
  let pool: PgPoolLike;
  let store: PostgresWriteKeyStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = scopedPool();
    await runMigrations(pool, { logger: silentLogger });
    store = new PostgresWriteKeyStore(pool);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  });

  test("creates a key and authenticates it", async () => {
    const { writeKey, secret } = await store.create({
      name: "ios-app",
      allowedModels: ["cheap", "smart"],
      metadata: { team: "growth" },
      createdBy: "alice",
    });

    expect(writeKey.name).toBe("ios-app");
    expect(writeKey.allowedModels).toEqual(["cheap", "smart"]);
    expect(writeKey.metadata).toEqual({ team: "growth" });
    expect(writeKey.createdBy).toBe("alice");
    expect(writeKey.createdAt).toBeGreaterThan(0);
    expect(writeKey.expiresAt).toBeNull();
    expect(writeKey.disabledAt).toBeNull();

    expect((await store.authenticate(secret))?.id).toBe(writeKey.id);
  });

  test("the database stores only a hash, so a dump cannot be replayed", async () => {
    const { secret } = await store.create({ name: "canary-app" });
    const dump = await pool.query(
      "SELECT string_agg(id::text || name || key_hash || prefix || last4, '|') AS blob " +
        "FROM omni_write_keys",
    );
    const blob = String(dump.rows[0]?.blob);

    expect(blob).not.toContain(secret);
    // The label is stored in the clear on purpose, and is not enough to use.
    expect(blob).toContain(secret.slice(0, 12));
    expect(blob).not.toContain(secret.slice(12, 40));
  });

  test("a NULL allowlist means unrestricted, an empty array means nothing", async () => {
    const open = await store.create({ name: "open" });
    expect(open.writeKey.allowedModels).toBeNull();

    const closed = await store.create({ name: "closed", allowedModels: [] });
    expect(closed.writeKey.allowedModels).toEqual([]);
    // Round-trips as an empty array, not as NULL.
    expect((await store.get(closed.writeKey.id))?.allowedModels).toEqual([]);
  });

  test("round-trips an expiry and reports the state", async () => {
    const past = Date.now() - 60_000;
    const { writeKey, secret } = await store.create({ name: "expiring", expiresAt: past });

    expect(writeKey.expiresAt).toBeCloseTo(past, -3);
    const loaded = await store.authenticate(secret);
    expect(loaded).not.toBeNull();
    expect(writeKeyState(loaded as NonNullable<typeof loaded>, Date.now())).toBe("expired");
  });

  test("revoke is idempotent and keeps the row", async () => {
    const { writeKey, secret } = await store.create({ name: "to-revoke" });

    expect(await store.revoke(writeKey.id)).toBe(true);
    // A second call reports "nothing changed" without a separate read.
    expect(await store.revoke(writeKey.id)).toBe(false);
    expect(await store.revoke("00000000-0000-0000-0000-000000000000")).toBe(false);

    const revoked = await store.authenticate(secret);
    expect(revoked?.disabledAt).not.toBeNull();
    expect(await store.get(writeKey.id)).not.toBeNull();
  });

  test("rejects an unknown key", async () => {
    expect(await store.authenticate("omk_not-a-real-key-at-all-here")).toBeNull();
  });

  test("lists newest first", async () => {
    const names = (await store.list()).map((key) => key.name);
    expect(names).toContain("ios-app");
    const timestamps = (await store.list()).map((key) => key.createdAt);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  test("a second instance authenticates what the first created", async () => {
    // Replicas share the database, so a key minted on one must work on all.
    const other = new PostgresWriteKeyStore(scopedPool());
    const { writeKey, secret } = await store.create({ name: "shared" });

    expect((await other.authenticate(secret))?.id).toBe(writeKey.id);
  });

  test("the cache spares the database and still converges after revocation", async () => {
    let clock = Date.now();
    const cached = new CachedWriteKeyStore(new PostgresWriteKeyStore(scopedPool()), {
      ttlMs: 1000,
      now: () => clock,
    });
    const { writeKey, secret } = await store.create({ name: "cached" });

    expect((await cached.authenticate(secret))?.id).toBe(writeKey.id);
    expect((await cached.authenticate(secret))?.id).toBe(writeKey.id);
    expect(cached.hits).toBe(1);

    // Revoked by *another* instance, so only the TTL can propagate it.
    await store.revoke(writeKey.id);
    expect((await cached.authenticate(secret))?.disabledAt).toBeNull();

    clock += 1001;
    expect((await cached.authenticate(secret))?.disabledAt).not.toBeNull();
  });
});
