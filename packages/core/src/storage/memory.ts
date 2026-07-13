import type { StorageAdapter, StorageFactory } from "./types.js";

interface Entry {
  value: string;
  expiresAt: number | null;
}

/**
 * In-memory storage, the default backend. Suitable for a single long-lived
 * instance and for tests; state is neither shared across instances/isolates
 * nor persisted across restarts.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly type = "memory";
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttlSeconds = options?.ttlSeconds;
    this.entries.set(key, {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const entry = this.live(key);
    if (entry === null) {
      this.entries.set(key, { value: String(amount), expiresAt: this.now() + ttlSeconds * 1000 });
      return amount;
    }
    const next = Number(entry.value) + amount;
    entry.value = String(next);
    return next;
  }

  async getCounter(key: string): Promise<number> {
    const entry = this.live(key);
    return entry === null ? 0 : Number(entry.value);
  }
}

export const memoryStorageFactory: StorageFactory = {
  type: "memory",
  // Use the injected clock so counter expiry stays in step with the limiter's
  // `now()` (they must agree for fixed windows to expire correctly under a
  // fake clock in tests, and under any custom clock in production).
  create: (_options, runtime) => new MemoryStorageAdapter(runtime.now),
};
