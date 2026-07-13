import {
  ConfigError,
  type RuntimeContext,
  type StorageAdapter,
  silentLogger,
} from "@omni-model/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type PgPoolLike,
  PostgresStorageAdapter,
  postgresStorageFactory,
} from "../src/postgres.js";

interface Row {
  value: string;
  expiresAt: number | null;
}

const CREATE_TABLE_SQL =
  /^CREATE TABLE IF NOT EXISTS (\w+) \(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at TIMESTAMPTZ\)$/;
const CREATE_INDEX_SQL = /^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \(expires_at\)$/;
const SELECT_SQL =
  /^SELECT value FROM (\w+) WHERE key = \$1 AND \(expires_at IS NULL OR expires_at > now\(\)\)$/;
const PUT_SQL =
  /^INSERT INTO (\w+) \(key, value, expires_at\) VALUES \(\$1, \$2, now\(\) \+ \$3::float8 \* interval '1 second'\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, expires_at = EXCLUDED\.expires_at$/;
const DELETE_SQL = /^DELETE FROM (\w+) WHERE key = \$1$/;
const INCREMENT_SQL =
  /^INSERT INTO (\w+) \(key, value, expires_at\) VALUES \(\$1, \$2::text, now\(\) \+ \$3::float8 \* interval '1 second'\) ON CONFLICT \(key\) DO UPDATE SET value = CASE WHEN \1\.expires_at IS NOT NULL AND \1\.expires_at <= now\(\) THEN EXCLUDED\.value ELSE \(\1\.value::bigint \+ \$2::bigint\)::text END, expires_at = CASE WHEN \1\.expires_at IS NOT NULL AND \1\.expires_at <= now\(\) THEN EXCLUDED\.expires_at ELSE \1\.expires_at END RETURNING value$/;
const CLEANUP_SQL = /^DELETE FROM (\w+) WHERE expires_at IS NOT NULL AND expires_at <= now\(\)$/;

/**
 * In-memory Postgres stand-in. Pattern-matches the adapter's exact SQL shapes
 * and implements their upsert/expiry semantics on a Map with an advanceable
 * clock; any unrecognized statement or missing relation throws.
 */
class FakePgPool implements PgPoolLike {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly indexes = new Set<string>();
  cleanupRuns = 0;
  endCalls = 0;
  private nowMs = 0;

  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const sql = text.replace(/\s+/g, " ").trim();

    const createTable = CREATE_TABLE_SQL.exec(sql);
    if (createTable) {
      const name = createTable[1] as string;
      if (!this.tables.has(name)) this.tables.set(name, new Map());
      return { rows: [] };
    }

    const createIndex = CREATE_INDEX_SQL.exec(sql);
    if (createIndex) {
      this.requireTable(createIndex[2] as string);
      this.indexes.add(createIndex[1] as string);
      return { rows: [] };
    }

    const select = SELECT_SQL.exec(sql);
    if (select) {
      const table = this.requireTable(select[1] as string);
      const row = table.get(values[0] as string);
      if (row === undefined || this.expired(row)) return { rows: [] };
      return { rows: [{ value: row.value }] };
    }

    const put = PUT_SQL.exec(sql);
    if (put) {
      const table = this.requireTable(put[1] as string);
      const [key, value, ttl] = values as [string, string, number | null];
      table.set(key, { value, expiresAt: ttl === null ? null : this.nowMs + ttl * 1000 });
      return { rows: [] };
    }

    const del = DELETE_SQL.exec(sql);
    if (del) {
      this.requireTable(del[1] as string).delete(values[0] as string);
      return { rows: [] };
    }

    const increment = INCREMENT_SQL.exec(sql);
    if (increment) {
      const table = this.requireTable(increment[1] as string);
      const [key, amountText, ttl] = values as [string, string, number];
      const fresh: Row = { value: amountText, expiresAt: this.nowMs + ttl * 1000 };
      const existing = table.get(key);
      // ON CONFLICT semantics: a physically present but expired row resets to
      // the insert values; a live row accumulates and keeps its expiry.
      const row =
        existing === undefined || this.expired(existing)
          ? fresh
          : {
              value: String(BigInt(existing.value) + BigInt(amountText)),
              expiresAt: existing.expiresAt,
            };
      table.set(key, row);
      return { rows: [{ value: row.value }] };
    }

    const cleanup = CLEANUP_SQL.exec(sql);
    if (cleanup) {
      const table = this.requireTable(cleanup[1] as string);
      this.cleanupRuns += 1;
      for (const [key, row] of table) {
        if (this.expired(row)) table.delete(key);
      }
      return { rows: [] };
    }

    throw new Error(`FakePgPool: unrecognized SQL: ${sql}`);
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }

  private expired(row: Row): boolean {
    return row.expiresAt !== null && row.expiresAt <= this.nowMs;
  }

  private requireTable(name: string): Map<string, Row> {
    const table = this.tables.get(name);
    if (table === undefined) throw new Error(`relation "${name}" does not exist`);
    return table;
  }
}

async function makeAdapter(
  options?: ConstructorParameters<typeof PostgresStorageAdapter>[1],
): Promise<{ fake: FakePgPool; adapter: PostgresStorageAdapter }> {
  const fake = new FakePgPool();
  const adapter = new PostgresStorageAdapter(fake, options);
  await adapter.init();
  return { fake, adapter };
}

function testRuntime(): RuntimeContext {
  const fetchStub: typeof fetch = () => Promise.reject(new Error("network disabled in tests"));
  return { env: {}, fetch: fetchStub, now: () => 0, waitUntil: () => {}, log: silentLogger };
}

describe("PostgresStorageAdapter", () => {
  test("init creates the default table and expiry index", async () => {
    const { fake } = await makeAdapter();
    expect(fake.tables.has("omni_kv")).toBe(true);
    expect(fake.indexes.has("omni_kv_expires_idx")).toBe(true);
  });

  test("a custom table name is used for DDL and DML", async () => {
    const { fake, adapter } = await makeAdapter({ table: "custom_kv" });
    await adapter.put("k", "v");
    expect(fake.tables.get("custom_kv")?.has("k")).toBe(true);
    expect(fake.indexes.has("custom_kv_expires_idx")).toBe(true);
  });

  test("rejects table names that are not plain identifiers", () => {
    const fake = new FakePgPool();
    for (const table of ["bad-name", "1abc", 'omni"; DROP TABLE users; --', ""]) {
      expect(() => new PostgresStorageAdapter(fake, { table })).toThrow(ConfigError);
    }
  });

  test("migrate defaults to true and is overridable", () => {
    const fake = new FakePgPool();
    expect(new PostgresStorageAdapter(fake).migrate).toBe(true);
    expect(new PostgresStorageAdapter(fake, { migrate: false }).migrate).toBe(false);
  });

  test("get/put roundtrip and get of an absent key", async () => {
    const { adapter } = await makeAdapter();
    expect(await adapter.get("k")).toBeNull();
    await adapter.put("k", "v1");
    expect(await adapter.get("k")).toBe("v1");
    await adapter.put("k", "v2");
    expect(await adapter.get("k")).toBe("v2");
  });

  test("put with a TTL expires; put without a TTL persists", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.put("ttl", "v", { ttlSeconds: 60 });
    await adapter.put("forever", "v");
    fake.advance(59);
    expect(await adapter.get("ttl")).toBe("v");
    fake.advance(2);
    expect(await adapter.get("ttl")).toBeNull();
    fake.advance(86_400);
    expect(await adapter.get("forever")).toBe("v");
  });

  test("re-put without a TTL clears a previous expiry", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.put("k", "v", { ttlSeconds: 60 });
    await adapter.put("k", "v");
    fake.advance(3600);
    expect(await adapter.get("k")).toBe("v");
  });

  test("delete removes the key", async () => {
    const { adapter } = await makeAdapter();
    await adapter.put("k", "v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  test("counters accumulate and getCounter reads them back", async () => {
    const { adapter } = await makeAdapter();
    expect(await adapter.increment("c", 5, 60)).toBe(5);
    expect(await adapter.increment("c", 3, 60)).toBe(8);
    expect(await adapter.getCounter("c")).toBe(8);
  });

  test("increment sets the TTL only on the first write", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.increment("c", 1, 60);
    fake.advance(30);
    // A second increment must not extend the window.
    expect(await adapter.increment("c", 1, 60)).toBe(2);
    fake.advance(31);
    expect(await adapter.getCounter("c")).toBe(0);
  });

  test("increment on an expired row resets to the amount with a fresh TTL", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.increment("c", 4, 60);
    fake.advance(61);
    expect(await adapter.increment("c", 7, 60)).toBe(7);
    fake.advance(59);
    expect(await adapter.getCounter("c")).toBe(7);
  });

  test("getCounter of an absent key is 0", async () => {
    const { adapter } = await makeAdapter();
    expect(await adapter.getCounter("missing")).toBe(0);
  });

  test("every 500th write sweeps expired rows", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.put("stale", "v", { ttlSeconds: 1 });
    fake.advance(2);
    for (let i = 0; i < 498; i += 1) {
      await adapter.put(`k${i}`, "v");
    }
    expect(fake.cleanupRuns).toBe(0);
    expect(fake.tables.get("omni_kv")?.has("stale")).toBe(true);
    await adapter.put("last", "v");
    // The sweep is fire-and-forget; let the microtask run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.cleanupRuns).toBe(1);
    expect(fake.tables.get("omni_kv")?.has("stale")).toBe(false);
  });

  test("close ends the pool", async () => {
    const { fake, adapter } = await makeAdapter();
    await adapter.close();
    expect(fake.endCalls).toBe(1);
  });

  test("close tolerates pools without end()", async () => {
    const fake = new FakePgPool();
    const poolWithoutEnd: PgPoolLike = { query: (text, values) => fake.query(text, values) };
    const adapter = new PostgresStorageAdapter(poolWithoutEnd);
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

describe("postgresStorageFactory", () => {
  test("has type postgres", () => {
    expect(postgresStorageFactory.type).toBe("postgres");
  });

  test("rejects options without a url", async () => {
    await expect(
      postgresStorageFactory.create({ type: "postgres" }, testRuntime()),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("rejects unknown option keys", async () => {
    await expect(
      postgresStorageFactory.create(
        { type: "postgres", url: "postgres://localhost/db", tabel: "typo" },
        testRuntime(),
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("rejects an invalid table name before touching the database", async () => {
    await expect(
      postgresStorageFactory.create(
        { type: "postgres", url: "postgres://localhost/db", table: "bad-name", migrate: false },
        testRuntime(),
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("with migrate disabled it creates an adapter without connecting", async () => {
    // pg.Pool connects lazily, so this stays fully offline.
    const adapter = await postgresStorageFactory.create(
      { type: "postgres", url: "postgres://nobody@localhost:1/nowhere", migrate: false },
      testRuntime(),
    );
    expect(adapter.type).toBe("postgres");
    await adapter.close?.();
  });
});

const integrationUrl = process.env.TEST_POSTGRES_URL;

describe.skipIf(!integrationUrl)("PostgresStorageAdapter (integration)", () => {
  // The test table persists across runs; keys are unique per run.
  const prefix = `it-${Math.random().toString(36).slice(2)}`;
  let adapter: StorageAdapter | undefined;

  beforeAll(async () => {
    adapter = await postgresStorageFactory.create(
      { type: "postgres", url: integrationUrl ?? "", table: "omni_kv_integration_test" },
      {
        env: {},
        fetch: globalThis.fetch,
        now: () => Date.now(),
        waitUntil: () => {},
        log: silentLogger,
      },
    );
  });

  afterAll(async () => {
    await adapter?.close?.();
  });

  test("kv roundtrip", async () => {
    const store = adapter as StorageAdapter;
    await store.put(`${prefix}:k`, "v");
    expect(await store.get(`${prefix}:k`)).toBe("v");
    await store.delete(`${prefix}:k`);
    expect(await store.get(`${prefix}:k`)).toBeNull();
  });

  test("ttl expires", async () => {
    const store = adapter as StorageAdapter;
    await store.put(`${prefix}:t`, "v", { ttlSeconds: 1 });
    expect(await store.get(`${prefix}:t`)).toBe("v");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await store.get(`${prefix}:t`)).toBeNull();
    await store.delete(`${prefix}:t`);
  });

  test("counters accumulate atomically", async () => {
    const store = adapter as StorageAdapter;
    expect(await store.increment(`${prefix}:c`, 2, 60)).toBe(2);
    expect(await store.increment(`${prefix}:c`, 3, 60)).toBe(5);
    expect(await store.getCounter(`${prefix}:c`)).toBe(5);
    await store.delete(`${prefix}:c`);
  });
});
