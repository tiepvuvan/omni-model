import { describe, expect, it } from "vitest";
import { baseConfig, createTestAdmin, errorOf } from "./helpers.js";

/**
 * The cache endpoints.
 *
 * Two, because those are the two questions an operator has: what is in it, and
 * make it empty. Whether caching is *on* is configuration, so it goes through the
 * config endpoints like everything else.
 */
interface CacheState {
  available: boolean;
  enabled: boolean;
  ttl: string | null;
  maxEntries: number | null;
  maxBytes: number | null;
  entries: number;
  oldestAt: number | null;
  bytes: number | null;
}

const cacheConfig = () =>
  baseConfig({
    cache: { enabled: true, ttl: "30m", maxEntries: 500, maxBytes: 64 * 1024 * 1024 },
  });

describe("the response cache", () => {
  it("reports the applied settings alongside what is actually stored", async () => {
    const admin = await createTestAdmin({ config: cacheConfig() });
    await admin.promptCache.put(
      "k",
      { kind: "completion", completion: { id: "x" }, usage: null },
      60,
    );

    const body = (await (await admin.call("/admin/api/cache")).json()) as CacheState;

    // Both halves in one answer: an operator should not have to cross-reference
    // the configuration with the contents to know whether caching is working.
    expect(body).toMatchObject({
      available: true,
      enabled: true,
      ttl: "30m",
      maxEntries: 500,
      maxBytes: 64 * 1024 * 1024,
    });
    expect(body.entries).toBe(1);
    expect(body.bytes).toBeGreaterThan(0);
  });

  it("purges on request and says how much it dropped", async () => {
    const admin = await createTestAdmin({ config: cacheConfig() });
    await admin.promptCache.put("a", { kind: "completion", completion: {}, usage: null }, 60);
    await admin.promptCache.put("b", { kind: "completion", completion: {}, usage: null }, 60);

    const response = await admin.call("/admin/api/cache", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purged: 2 });
    expect((await admin.promptCache.stats()).entries).toBe(0);
  });

  it("still purges a cache that has just been switched off", async () => {
    // The moment an operator most wants to empty it is right after turning it off,
    // which is exactly when the bundle stops holding one — so the endpoints work
    // from the store, not from the bundle's view of it.
    const admin = await createTestAdmin({
      config: baseConfig({ cache: { enabled: false } }),
    });
    await admin.promptCache.put("a", { kind: "completion", completion: {}, usage: null }, 60);

    const body = (await (await admin.call("/admin/api/cache")).json()) as CacheState;
    expect(body.enabled).toBe(false);
    expect(body.entries).toBe(1);

    expect(await (await admin.call("/admin/api/cache", { method: "DELETE" })).json()).toEqual({
      purged: 1,
    });
  });

  it("explains itself when the deployment has no cache at all", async () => {
    const admin = await createTestAdmin({ config: cacheConfig(), promptCache: null });

    const state = (await (await admin.call("/admin/api/cache")).json()) as CacheState;
    expect(state.available).toBe(false);
    expect(state.entries).toBe(0);

    const purge = await admin.call("/admin/api/cache", { method: "DELETE" });
    expect(purge.status).toBe(400);
    expect((await errorOf(purge)).message).toContain("PostgreSQL");
  });
});
