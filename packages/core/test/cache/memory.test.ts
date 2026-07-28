import { describe, expect, it } from "vitest";
import { MemoryPromptCache } from "../../src/cache/memory.js";

const entry = (value: string) =>
  ({ kind: "completion", completion: { value }, usage: null }) as const;

describe("MemoryPromptCache eviction", () => {
  it("removes the oldest rows until both count and byte budgets fit", async () => {
    let now = 1;
    const cache = new MemoryPromptCache(() => now);
    await cache.put("old", entry("a".repeat(100)), 60);
    now += 1;
    await cache.put("middle", entry("b".repeat(100)), 60);
    now += 1;
    await cache.put("new", entry("c".repeat(100)), 60);

    const oneEntryBytes = (await cache.stats()).bytes ?? 0;
    const removed = await cache.evict(10, Math.ceil(oneEntryBytes / 2));

    expect(removed).toBe(2);
    expect(await cache.get("old")).toBeNull();
    expect(await cache.get("middle")).toBeNull();
    expect(await cache.get("new")).not.toBeNull();
  });

  it("also retains the existing entry-count safety limit", async () => {
    const cache = new MemoryPromptCache();
    await cache.put("old", entry("old"), 60);
    await cache.put("new", entry("new"), 60);

    expect(await cache.evict(1, Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(await cache.get("old")).toBeNull();
    expect(await cache.get("new")).not.toBeNull();
  });
});
