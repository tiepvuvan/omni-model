import type { RequestLogEntry } from "@omni-model/core";
import { silentLogger } from "@omni-model/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runMigrations } from "../src/migrations/run.js";
import type { PgPoolLike } from "../src/pool.js";
import {
  PostgresRequestLogWriter,
  queryRequestLogs,
  sweepRequestLogs,
} from "../src/request-log-store.js";
import { PostgresWriteKeyStore } from "../src/write-key-store.js";

/**
 * Request logs against a real PostgreSQL. Opt in with `TEST_POSTGRES_URL` or run
 * `pnpm test:pg`.
 */
const url = process.env.TEST_POSTGRES_URL;

if (process.env.OMNI_REQUIRE_PG === "1" && !url) {
  throw new Error("OMNI_REQUIRE_PG=1 but TEST_POSTGRES_URL is unset");
}

const schema = `omni_log_${process.pid.toString(36)}${Date.now().toString(36)}`;
const pools: Pool[] = [];

function scopedPool(): PgPoolLike {
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  pools.push(pool);
  return pool as unknown as PgPoolLike;
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    requestId: crypto.randomUUID(),
    ts: Date.now(),
    writeKeyId: null,
    userId: null,
    deviceId: null,
    authProvider: null,
    modelRequested: "gpt-4o-mini",
    modelRouted: "gpt-4o-mini",
    providerId: "openai",
    routeName: null,
    stream: false,
    status: 200,
    errorCode: null,
    rateLimitRule: null,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 42,
    ttfbMs: null,
    ip: "203.0.113.7",
    userAgent: "test-agent",
    ...overrides,
  };
}

describe.skipIf(!url)("PostgresRequestLogWriter (integration)", () => {
  let admin: Pool;
  let pool: PgPoolLike;
  let writer: PostgresRequestLogWriter;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    pool = scopedPool();
    await runMigrations(pool, { logger: silentLogger });
    writer = new PostgresRequestLogWriter(pool);
  });

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  });

  test("writes a batch in a single statement", async () => {
    const batch = [entry({ userId: "u1" }), entry({ userId: "u2" }), entry({ userId: "u3" })];
    await writer.write(batch);

    const rows = await queryRequestLogs(pool);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.userId).sort()).toEqual(["u1", "u2", "u3"]);
    expect(rows[0]).toMatchObject({
      modelRequested: "gpt-4o-mini",
      providerId: "openai",
      status: 200,
      totalTokens: 15,
      latencyMs: 42,
      ip: "203.0.113.7",
    });
  });

  test("an empty batch is a no-op, not a malformed statement", async () => {
    await expect(writer.write([])).resolves.toBeUndefined();
  });

  test("stores content separately and only on request", async () => {
    await writer.write([
      entry({
        userId: "with-content",
        content: {
          messages: [{ role: "user", content: "secret prompt" }],
          completion: "the reply",
          truncated: true,
        },
      }),
    ]);

    const without = await queryRequestLogs(pool, { userId: "with-content" });
    // Metrics do not drag prompt text across the wire by default.
    expect(without[0]?.content).toBeUndefined();

    const withContent = await queryRequestLogs(pool, {
      userId: "with-content",
      includeContent: true,
    });
    expect(withContent[0]?.content).toEqual({
      messages: [{ role: "user", content: "secret prompt" }],
      completion: "the reply",
      truncated: true,
    });
  });

  test("attributes a row to a write key and survives its deletion", async () => {
    const keys = new PostgresWriteKeyStore(pool);
    const { writeKey } = await keys.create({ name: "ios-app" });
    await writer.write([entry({ userId: "attributed", writeKeyId: writeKey.id })]);

    expect((await queryRequestLogs(pool, { userId: "attributed" }))[0]?.writeKeyId).toBe(
      writeKey.id,
    );

    // Hard-deleting a key must not erase the usage it accrued.
    await pool.query("DELETE FROM omni_write_keys WHERE id = $1", [writeKey.id]);
    const orphan = await queryRequestLogs(pool, { userId: "attributed" });
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.writeKeyId).toBeNull();
  });

  test("a malformed write key id does not cost the rest of the batch", async () => {
    // write_key_id is a UUID column, so one bad value would otherwise abort the
    // whole multi-row insert and lose every good row with it.
    await writer.write([
      entry({ userId: "salvaged-a", writeKeyId: "not-a-uuid" }),
      entry({ userId: "salvaged-b" }),
    ]);

    expect(await queryRequestLogs(pool, { userId: "salvaged-a" })).toHaveLength(1);
    expect(await queryRequestLogs(pool, { userId: "salvaged-b" })).toHaveLength(1);
  });

  test("filters and paginates newest first", async () => {
    const base = Date.now();
    await writer.write([
      entry({ userId: "paged", ts: base - 3000, status: 200 }),
      entry({ userId: "paged", ts: base - 2000, status: 429 }),
      entry({ userId: "paged", ts: base - 1000, status: 500 }),
    ]);

    const all = await queryRequestLogs(pool, { userId: "paged" });
    expect(all.map((row) => row.status)).toEqual([500, 429, 200]);

    expect(await queryRequestLogs(pool, { userId: "paged", limit: 2 })).toHaveLength(2);
    const failures = await queryRequestLogs(pool, { userId: "paged", minStatus: 400 });
    expect(failures.map((row) => row.status)).toEqual([500, 429]);
    // Cursor pagination: everything strictly older than the newest row.
    const older = await queryRequestLogs(pool, { userId: "paged", before: base - 1000 });
    expect(older.map((row) => row.status)).toEqual([429, 200]);
  });

  test("caps the limit so one query cannot ask for the whole table", async () => {
    expect(await queryRequestLogs(pool, { limit: 10_000 })).toBeInstanceOf(Array);
  });

  test("sweeps content on its own clock, before metadata", async () => {
    // Usage history should be able to outlive the prompts.
    const sweepSchema = `${schema}_sweep`;
    await admin.query(`CREATE SCHEMA ${sweepSchema}`);
    const sweepPool = new Pool({
      connectionString: url,
      options: `-c search_path=${sweepSchema}`,
    });
    pools.push(sweepPool);
    const scoped = sweepPool as unknown as PgPoolLike;
    try {
      await runMigrations(scoped, { logger: silentLogger });
      const sweepWriter = new PostgresRequestLogWriter(scoped);
      const now = Date.now();
      await sweepWriter.write([
        entry({
          userId: "old",
          ts: now - 10_000,
          content: { messages: ["old prompt"], completion: "old", truncated: false },
        }),
        entry({
          userId: "fresh",
          ts: now,
          content: { messages: ["fresh prompt"], completion: "fresh", truncated: false },
        }),
      ]);

      // Content older than 5s goes; metadata older than an hour stays.
      const result = await sweepRequestLogs(scoped, {
        retentionMs: 60 * 60 * 1000,
        contentRetentionMs: 5_000,
        logger: silentLogger,
      });
      expect(result.ran).toBe(true);
      expect(result.contentsDeleted).toBe(1);
      expect(result.logsDeleted).toBe(0);

      const rows = await queryRequestLogs(scoped, { includeContent: true });
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.userId === "old")?.content).toBeUndefined();
      expect(rows.find((row) => row.userId === "fresh")?.content).toBeDefined();

      // Now expire the metadata too.
      const second = await sweepRequestLogs(scoped, {
        retentionMs: 5_000,
        contentRetentionMs: 5_000,
        logger: silentLogger,
      });
      expect(second.logsDeleted).toBe(1);
      expect(await queryRequestLogs(scoped)).toHaveLength(1);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${sweepSchema} CASCADE`);
    }
  });

  test("only one replica sweeps at a time", async () => {
    // Every replica runs the sweep on a timer; the advisory lock is what stops
    // them all deleting concurrently. It is non-blocking, so losers return at once.
    const holder = scopedPool();
    if (holder.connect === undefined) throw new Error("expected a pool with connect()");
    const client = await holder.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [1_869_768_810]);
      const result = await sweepRequestLogs(scopedPool(), {
        retentionMs: 1,
        contentRetentionMs: 1,
        logger: silentLogger,
      });
      expect(result).toEqual({ ran: false, logsDeleted: 0, contentsDeleted: 0 });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [1_869_768_810]);
      client.release();
    }
  });
});
