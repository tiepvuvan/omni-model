import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/logging.js";
import { MemoryStorageAdapter, memoryStorageFactory } from "../../src/storage/memory.js";
import type { RuntimeContext } from "../../src/types.js";

function runtimeWithClock(now: () => number): RuntimeContext {
  return {
    env: {},
    fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
    now,
    waitUntil: () => {},
    log: silentLogger,
  };
}

describe("MemoryStorageAdapter", () => {
  it("expires entries according to the injected clock", async () => {
    let nowMs = 1_000_000;
    const store = new MemoryStorageAdapter(() => nowMs);
    await store.put("k", "v", { ttlSeconds: 10 });
    nowMs += 9_000;
    expect(await store.get("k")).toBe("v");
    nowMs += 2_000; // now 11s elapsed > 10s ttl
    expect(await store.get("k")).toBeNull();
  });

  it("increments and expires counters on the injected clock", async () => {
    let nowMs = 0;
    const store = new MemoryStorageAdapter(() => nowMs);
    expect(await store.increment("c", 5, 60)).toBe(5);
    expect(await store.increment("c", 3, 60)).toBe(8);
    nowMs += 61_000;
    expect(await store.getCounter("c")).toBe(0);
  });
});

describe("memoryStorageFactory", () => {
  it("builds an adapter driven by the runtime clock, not Date.now", async () => {
    // Regression: the factory previously ignored runtime.now, desyncing
    // counter expiry from the limiter's clock under a fake clock.
    let nowMs = 500_000;
    const adapter = await memoryStorageFactory.create(
      { type: "memory" },
      runtimeWithClock(() => nowMs),
    );
    await adapter.increment("c", 1, 30);
    expect(await adapter.getCounter("c")).toBe(1);
    nowMs += 31_000;
    expect(await adapter.getCounter("c")).toBe(0);
  });
});
