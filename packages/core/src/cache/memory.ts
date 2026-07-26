import type { CachedEntry, PromptCache, PromptCacheStats } from "./types.js";

interface Row {
  entry: CachedEntry;
  storedAt: number;
  expiresAt: number;
  bytes: number;
}

/**
 * In-process prompt cache.
 *
 * What a deployment on `storage: memory` gets, and what the tests use. Not shared
 * between replicas and lost on restart — which is why the container uses the
 * Postgres one, and why this is the only implementation that can pretend eviction
 * is exact.
 */
export class MemoryPromptCache implements PromptCache {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): Row | null {
    const row = this.rows.get(key);
    if (row === undefined) return null;
    if (row.expiresAt <= this.now()) {
      this.rows.delete(key);
      return null;
    }
    return row;
  }

  async get(key: string): Promise<CachedEntry | null> {
    return this.live(key)?.entry ?? null;
  }

  async put(key: string, entry: CachedEntry, ttlSeconds: number): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    // Re-inserting moves the key to the end of the map, which is what makes
    // insertion order usable as the eviction order below.
    this.rows.delete(key);
    this.rows.set(key, {
      entry,
      storedAt: this.now(),
      expiresAt: this.now() + ttlSeconds * 1000,
      bytes,
    });
  }

  async purge(): Promise<number> {
    const removed = this.rows.size;
    this.rows.clear();
    return removed;
  }

  async stats(): Promise<PromptCacheStats> {
    let entries = 0;
    let oldestAt: number | null = null;
    let bytes = 0;
    for (const key of [...this.rows.keys()]) {
      const row = this.live(key);
      if (row === null) continue;
      entries += 1;
      bytes += row.bytes;
      oldestAt = oldestAt === null ? row.storedAt : Math.min(oldestAt, row.storedAt);
    }
    return { entries, oldestAt, bytes };
  }

  async evict(maxEntries: number): Promise<number> {
    let removed = 0;
    for (const key of [...this.rows.keys()]) {
      if (this.live(key) === null) removed += 1;
    }
    // Oldest first: `Map` iterates in insertion order, and `put` re-inserts.
    const excess = this.rows.size - maxEntries;
    if (excess > 0) {
      for (const key of [...this.rows.keys()].slice(0, excess)) {
        this.rows.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
