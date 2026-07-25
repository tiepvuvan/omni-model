import {
  ConfigError,
  type RuntimeContext,
  type StorageAdapter,
  silentLogger,
} from "@omni-model/core";
import { describe, expect, test } from "vitest";
import type { PgPoolLike } from "../src/pool.js";
import { PostgresStorageAdapter, postgresStorageFactory } from "../src/storage.js";
import { FakeKvPool } from "./support/fake-pool.js";

function makeAdapter(): { fake: FakeKvPool; adapter: PostgresStorageAdapter } {
  const fake = new FakeKvPool();
  return { fake, adapter: new PostgresStorageAdapter(fake) };
}

function testRuntime(): RuntimeContext {
  const fetchStub: typeof fetch = () => Promise.reject(new Error("network disabled in tests"));
  return { env: {}, fetch: fetchStub, now: () => 0, waitUntil: () => {}, log: silentLogger };
}

describe("PostgresStorageAdapter", () => {
  test("get/put roundtrip and get of an absent key", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.get("k")).toBeNull();
    await adapter.put("k", "v1");
    expect(await adapter.get("k")).toBe("v1");
    await adapter.put("k", "v2");
    expect(await adapter.get("k")).toBe("v2");
  });

  test("put with a TTL expires; put without a TTL persists", async () => {
    const { fake, adapter } = makeAdapter();
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
    const { fake, adapter } = makeAdapter();
    await adapter.put("k", "v", { ttlSeconds: 60 });
    await adapter.put("k", "v");
    fake.advance(3600);
    expect(await adapter.get("k")).toBe("v");
  });

  test("delete removes the key", async () => {
    const { adapter } = makeAdapter();
    await adapter.put("k", "v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  test("counters accumulate and getCounter reads them back", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.increment("c", 5, 60)).toBe(5);
    expect(await adapter.increment("c", 3, 60)).toBe(8);
    expect(await adapter.getCounter("c")).toBe(8);
  });

  test("increment sets the TTL only on the first write", async () => {
    const { fake, adapter } = makeAdapter();
    await adapter.increment("c", 1, 60);
    fake.advance(30);
    // A second increment must not extend the window.
    expect(await adapter.increment("c", 1, 60)).toBe(2);
    fake.advance(31);
    expect(await adapter.getCounter("c")).toBe(0);
  });

  test("increment on an expired row resets to the amount with a fresh TTL", async () => {
    const { fake, adapter } = makeAdapter();
    await adapter.increment("c", 4, 60);
    fake.advance(61);
    expect(await adapter.increment("c", 7, 60)).toBe(7);
    fake.advance(59);
    expect(await adapter.getCounter("c")).toBe(7);
  });

  test("getCounter of an absent key is 0", async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.getCounter("missing")).toBe(0);
  });

  test("increment throws when the upsert returns no row", async () => {
    const pool: PgPoolLike = { query: async () => ({ rows: [] }) };
    const adapter = new PostgresStorageAdapter(pool);
    await expect(adapter.increment("c", 1, 60)).rejects.toThrow(/returned no row/);
  });

  test("every 500th write sweeps expired rows", async () => {
    const { fake, adapter } = makeAdapter();
    await adapter.put("stale", "v", { ttlSeconds: 1 });
    fake.advance(2);
    for (let i = 0; i < 498; i += 1) {
      await adapter.put(`k${i}`, "v");
    }
    expect(fake.cleanupRuns).toBe(0);
    expect(fake.rows.has("stale")).toBe(true);
    await adapter.put("last", "v");
    // The sweep is fire-and-forget; let the microtask run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.cleanupRuns).toBe(1);
    expect(fake.rows.has("stale")).toBe(false);
  });

  test("a failing sweep is swallowed so writes keep succeeding", async () => {
    let writes = 0;
    const pool: PgPoolLike = {
      query: async (text) => {
        if (text.startsWith("DELETE FROM omni_kv WHERE expires_at")) {
          throw new Error("sweep failed");
        }
        writes += 1;
        return { rows: [] };
      },
    };
    const adapter = new PostgresStorageAdapter(pool);
    for (let i = 0; i < 500; i += 1) await adapter.put(`k${i}`, "v");
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toBe(500);
  });

  test("close ends the pool, and tolerates pools without end()", async () => {
    const { fake, adapter } = makeAdapter();
    await adapter.close();
    expect(fake.endCalls).toBe(1);

    const withoutEnd = new PostgresStorageAdapter({ query: (t, v) => fake.query(t, v) });
    await expect(withoutEnd.close()).resolves.toBeUndefined();
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

  test("rejects the removed table option rather than silently ignoring it", async () => {
    // `table` was dropped when migrations took ownership of the schema. A
    // strictObject turns a stale config into a startup error instead of a
    // deployment that quietly writes to the wrong place.
    await expect(
      postgresStorageFactory.create(
        { type: "postgres", url: "postgres://localhost/db", table: "custom_kv" },
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

  test("satisfies the StorageAdapter contract", () => {
    const adapter: StorageAdapter = new PostgresStorageAdapter(new FakeKvPool());
    expect(adapter.type).toBe("postgres");
  });
});
