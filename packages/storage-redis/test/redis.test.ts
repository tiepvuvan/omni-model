import {
  ConfigError,
  type RuntimeContext,
  type StorageAdapter,
  silentLogger,
} from "@omni-model/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RedisClientLike, RedisStorageAdapter, redisStorageFactory } from "../src/redis.js";

interface FakeEntry {
  value: string;
  expiresAt: number | null;
}

/**
 * In-memory Redis stand-in: honors SET ... EX, DEL, and emulates the
 * adapter's INCRBY+EXPIRE Lua script, with an advanceable clock for TTLs.
 */
class FakeRedis implements RedisClientLike {
  readonly store = new Map<string, FakeEntry>();
  quitCalls = 0;
  private nowMs = 0;

  advance(seconds: number): void {
    this.nowMs += seconds * 1000;
  }

  private live(key: string): FakeEntry | null {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.nowMs) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    let expiresAt: number | null = null;
    for (let i = 0; i < args.length; i += 2) {
      const flag = String(args[i]).toUpperCase();
      if (flag !== "EX") throw new Error(`FakeRedis: unsupported SET argument "${flag}"`);
      const seconds = Number(args[i + 1]);
      if (!Number.isInteger(seconds) || seconds <= 0) {
        throw new Error(`FakeRedis: EX requires a positive integer, got ${args[i + 1]}`);
      }
      expiresAt = this.nowMs + seconds * 1000;
    }
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.live(key) !== null;
    this.store.delete(key);
    return existed ? 1 : 0;
  }

  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (!script.includes("INCRBY") || !script.includes("EXPIRE") || numKeys !== 1) {
      throw new Error(`FakeRedis: unexpected eval: ${script}`);
    }
    const [key, amount, ttl] = args as [string, number, number];
    if (!Number.isInteger(Number(ttl)) || Number(ttl) <= 0) {
      throw new Error(`FakeRedis: EXPIRE requires a positive integer, got ${ttl}`);
    }
    const entry = this.live(key);
    // INCRBY creates missing keys (starting at 0) without a TTL; the script's
    // conditional EXPIRE then applies only to that first write.
    const next = (entry === null ? 0 : Number(entry.value)) + Number(amount);
    const updated: FakeEntry = entry === null ? { value: String(next), expiresAt: null } : entry;
    updated.value = String(next);
    this.store.set(key, updated);
    if (next === Number(amount)) {
      updated.expiresAt = this.nowMs + Number(ttl) * 1000;
    }
    return next;
  }

  async quit(): Promise<unknown> {
    this.quitCalls += 1;
    return "OK";
  }
}

function testRuntime(): RuntimeContext {
  const fetchStub: typeof fetch = () => Promise.reject(new Error("network disabled in tests"));
  return { env: {}, fetch: fetchStub, now: () => 0, waitUntil: () => {}, log: silentLogger };
}

describe("RedisStorageAdapter", () => {
  test("get/put roundtrip with the default key prefix", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.put("foo", "bar");
    expect(await adapter.get("foo")).toBe("bar");
    expect(fake.store.has("omni:foo")).toBe(true);
    expect(fake.store.has("foo")).toBe(false);
  });

  test("get of an absent key returns null", async () => {
    const adapter = new RedisStorageAdapter(new FakeRedis());
    expect(await adapter.get("missing")).toBeNull();
  });

  test("put with a TTL expires; put without a TTL persists", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.put("ttl", "v", { ttlSeconds: 60 });
    await adapter.put("forever", "v");
    fake.advance(59);
    expect(await adapter.get("ttl")).toBe("v");
    fake.advance(2);
    expect(await adapter.get("ttl")).toBeNull();
    fake.advance(86_400);
    expect(await adapter.get("forever")).toBe("v");
  });

  test("sub-second TTLs round up to one second", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.put("k", "v", { ttlSeconds: 0.5 });
    fake.advance(0.9);
    expect(await adapter.get("k")).toBe("v");
    fake.advance(0.2);
    expect(await adapter.get("k")).toBeNull();
  });

  test("delete removes the key", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.put("k", "v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  test("counters accumulate and getCounter reads them back", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    expect(await adapter.increment("c", 5, 60)).toBe(5);
    expect(await adapter.increment("c", 3, 60)).toBe(8);
    expect(await adapter.getCounter("c")).toBe(8);
  });

  test("increment sets the TTL only on the first write", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.increment("c", 1, 60);
    fake.advance(30);
    // A second increment must not extend the window.
    expect(await adapter.increment("c", 1, 60)).toBe(2);
    fake.advance(31);
    expect(await adapter.getCounter("c")).toBe(0);
  });

  test("increment after expiry starts a fresh window", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.increment("c", 4, 60);
    fake.advance(61);
    expect(await adapter.increment("c", 7, 60)).toBe(7);
    fake.advance(59);
    expect(await adapter.getCounter("c")).toBe(7);
  });

  test("getCounter of an absent key is 0", async () => {
    const adapter = new RedisStorageAdapter(new FakeRedis());
    expect(await adapter.getCounter("missing")).toBe(0);
  });

  test("a custom keyPrefix is applied to every operation", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake, { keyPrefix: "custom:" });
    await adapter.put("k", "v");
    await adapter.increment("c", 1, 60);
    expect(fake.store.has("custom:k")).toBe(true);
    expect(fake.store.has("custom:c")).toBe(true);
    await adapter.delete("k");
    expect(fake.store.has("custom:k")).toBe(false);
  });

  test("close quits the client", async () => {
    const fake = new FakeRedis();
    const adapter = new RedisStorageAdapter(fake);
    await adapter.close();
    expect(fake.quitCalls).toBe(1);
  });
});

describe("redisStorageFactory", () => {
  test("has type redis", () => {
    expect(redisStorageFactory.type).toBe("redis");
  });

  test("rejects options without a url", async () => {
    await expect(
      redisStorageFactory.create({ type: "redis" }, testRuntime()),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("rejects a non-redis url scheme", async () => {
    await expect(
      redisStorageFactory.create({ type: "redis", url: "http://localhost:6379" }, testRuntime()),
    ).rejects.toThrow(/redis:\/\//);
  });

  test("rejects unknown option keys", async () => {
    await expect(
      redisStorageFactory.create(
        { type: "redis", url: "redis://localhost:6379", keyPrefx: "typo:" },
        testRuntime(),
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

const integrationUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!integrationUrl)("RedisStorageAdapter (integration)", () => {
  const keyPrefix = `omni-test:${Math.random().toString(36).slice(2)}:`;
  let adapter: StorageAdapter | undefined;

  beforeAll(async () => {
    adapter = await redisStorageFactory.create(
      { type: "redis", url: integrationUrl ?? "", keyPrefix },
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
    await store.put("k", "v");
    expect(await store.get("k")).toBe("v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
  });

  test("counters accumulate atomically", async () => {
    const store = adapter as StorageAdapter;
    expect(await store.increment("c", 2, 60)).toBe(2);
    expect(await store.increment("c", 3, 60)).toBe(5);
    expect(await store.getCounter("c")).toBe(5);
    await store.delete("c");
  });

  test("ttl expires", async () => {
    const store = adapter as StorageAdapter;
    await store.put("t", "v", { ttlSeconds: 1 });
    expect(await store.get("t")).toBe("v");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(await store.get("t")).toBeNull();
  });
});
