import type { RuntimeContext } from "../types.js";

/** String key/value storage with optional TTL. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Counters backing rate limits and token budgets. */
export interface CounterStore {
  /**
   * Increment `key` by `amount` and return the post-increment value. The TTL
   * applies from the first write of the key. Backends should make this as
   * atomic as they can (Redis INCRBY, Postgres upsert, Durable Object serial
   * execution); eventually-consistent stores such as Cloudflare KV provide
   * best-effort counting and must document that.
   */
  increment(key: string, amount: number, ttlSeconds: number): Promise<number>;
  /** Current counter value; 0 when the key is absent or expired. */
  getCounter(key: string): Promise<number>;
}

/**
 * A storage backend. One adapter instance serves both key/value needs
 * (App Attest key registry, challenge storage, caches) and counters
 * (rate limits, token budgets).
 */
export interface StorageAdapter extends KVStore, CounterStore {
  readonly type: string;
  close?(): Promise<void>;
}

export interface StorageFactory {
  readonly type: string;
  /**
   * `options` is the raw `storage:` block from the YAML config; factories
   * validate it themselves (with zod) so third-party backends can define
   * arbitrary options without changes to the core schema.
   */
  create(
    options: Record<string, unknown>,
    runtime: RuntimeContext,
  ): StorageAdapter | Promise<StorageAdapter>;
}
