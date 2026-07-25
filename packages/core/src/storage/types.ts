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
   * applies from the first write of the key. Backends must make this atomic
   * (the Postgres adapter does it in a single upsert statement) so counters
   * stay correct across concurrent proxy instances; a backend that can only
   * count best-effort must document that.
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
   * `options` is the raw `storage` block from the environment configuration; factories
   * validate it themselves (with zod) so third-party backends can define
   * arbitrary options without changes to the core schema.
   */
  create(
    options: Record<string, unknown>,
    runtime: RuntimeContext,
  ): StorageAdapter | Promise<StorageAdapter>;
}
