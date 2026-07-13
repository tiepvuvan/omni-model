import type { RuntimeContext } from "@omni-model/core";
import { ConfigError, silentLogger } from "@omni-model/core";
import { describe, expect, it } from "vitest";
import type { KVNamespaceLike } from "../src/cf-types.js";
import { createKVStorageFactory, KVStorageAdapter } from "../src/kv.js";

const T0 = 1_700_000_000_000;

/** In-memory KV double that honors expirationTtl against an adjustable clock. */
class FakeKVNamespace implements KVNamespaceLike {
  readonly puts: Array<{ key: string; value: string; expirationTtl: number | undefined }> = [];
  private readonly entries = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly clock: { now: number };

  constructor(clock: { now: number }) {
    this.clock = clock;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.clock.now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts.push({ key, value, expirationTtl: options?.expirationTtl });
    this.entries.set(key, {
      value,
      expiresAt:
        options?.expirationTtl === undefined ? null : this.clock.now + options.expirationTtl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

function setup(): { clock: { now: number }; kv: FakeKVNamespace; adapter: KVStorageAdapter } {
  const clock = { now: T0 };
  const kv = new FakeKVNamespace(clock);
  return { clock, kv, adapter: new KVStorageAdapter(kv) };
}

function testRuntime(): RuntimeContext {
  return {
    env: {},
    fetch: () => Promise.reject(new Error("network disabled in tests")),
    now: () => T0,
    waitUntil: () => {},
    log: silentLogger,
  };
}

describe("KVStorageAdapter", () => {
  it("has the cloudflare-kv type", () => {
    expect(setup().adapter.type).toBe("cloudflare-kv");
  });

  it("round-trips put/get/delete", async () => {
    const { adapter } = setup();
    expect(await adapter.get("k")).toBeNull();
    await adapter.put("k", "v1");
    expect(await adapter.get("k")).toBe("v1");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  it("writes without expirationTtl when no TTL is given", async () => {
    const { adapter, kv } = setup();
    await adapter.put("k", "v");
    expect(kv.puts).toEqual([{ key: "k", value: "v", expirationTtl: undefined }]);
  });

  it("clamps TTLs below the KV minimum up to 60 seconds", async () => {
    const { adapter, kv } = setup();
    await adapter.put("short", "v", { ttlSeconds: 30 });
    await adapter.put("long", "v", { ttlSeconds: 120 });
    await adapter.put("fractional", "v", { ttlSeconds: 90.5 });
    expect(kv.puts.map((p) => p.expirationTtl)).toEqual([60, 120, 91]);
  });

  it("expires values once the TTL elapses", async () => {
    const { adapter, clock } = setup();
    await adapter.put("k", "v", { ttlSeconds: 120 });
    clock.now = T0 + 119_000;
    expect(await adapter.get("k")).toBe("v");
    clock.now = T0 + 120_000;
    expect(await adapter.get("k")).toBeNull();
  });

  it("increments via read-modify-write and stores plain numeric strings", async () => {
    const { adapter, kv } = setup();
    expect(await adapter.increment("counter", 3, 300)).toBe(3);
    expect(await adapter.increment("counter", 4, 300)).toBe(7);
    expect(kv.puts).toEqual([
      { key: "counter", value: "3", expirationTtl: 300 },
      { key: "counter", value: "7", expirationTtl: 300 },
    ]);
    expect(await adapter.getCounter("counter")).toBe(7);
  });

  it("clamps the increment TTL to the KV minimum", async () => {
    const { adapter, kv } = setup();
    await adapter.increment("counter", 1, 10);
    expect(kv.puts[0]?.expirationTtl).toBe(60);
  });

  it("restarts an expired counter from the increment amount", async () => {
    const { adapter, clock } = setup();
    await adapter.increment("counter", 5, 60);
    clock.now = T0 + 61_000;
    expect(await adapter.increment("counter", 2, 60)).toBe(2);
  });

  it("treats a non-numeric value as zero for counter reads", async () => {
    const { adapter } = setup();
    await adapter.put("counter", "not-a-number");
    expect(await adapter.getCounter("counter")).toBe(0);
    expect(await adapter.increment("counter", 5, 60)).toBe(5);
  });

  it("returns 0 for an absent counter", async () => {
    const { adapter } = setup();
    expect(await adapter.getCounter("missing")).toBe(0);
  });
});

describe("createKVStorageFactory", () => {
  it("creates an adapter from valid options", async () => {
    const { kv } = setup();
    const factory = createKVStorageFactory(kv);
    expect(factory.type).toBe("cloudflare-kv");
    const adapter = await factory.create({ type: "cloudflare-kv" }, testRuntime());
    expect(adapter.type).toBe("cloudflare-kv");
    await adapter.put("k", "v");
    expect(await adapter.get("k")).toBe("v");
  });

  it("accepts an informational binding option", async () => {
    const factory = createKVStorageFactory(setup().kv);
    const adapter = await factory.create(
      { type: "cloudflare-kv", binding: "OMNI_KV" },
      testRuntime(),
    );
    expect(adapter.type).toBe("cloudflare-kv");
  });

  it("rejects unknown options with a ConfigError", () => {
    const factory = createKVStorageFactory(setup().kv);
    expect(() =>
      factory.create({ type: "cloudflare-kv", nameSpace: "typo" }, testRuntime()),
    ).toThrowError(ConfigError);
  });
});
