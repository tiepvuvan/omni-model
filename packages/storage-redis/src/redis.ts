import { ConfigError, type StorageAdapter, type StorageFactory } from "@omni-model/core";
import { z } from "zod";

/**
 * Minimal structural subset of an ioredis-compatible client. Tests stub it in
 * memory, and embedders can inject a pre-configured client (Cluster, Sentinel,
 * custom TLS) instead of going through {@link redisStorageFactory}.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * INCRBY, then set the TTL only when the post-increment value equals the
 * increment amount — i.e. this call created the key. Runs as one Lua script
 * so no concurrent writer can interleave between the INCRBY and the EXPIRE.
 */
const INCREMENT_SCRIPT = [
  "local v = redis.call('INCRBY', KEYS[1], ARGV[1])",
  "if tonumber(v) == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end",
  "return v",
].join("\n");

export interface RedisStorageAdapterOptions {
  /** Prefix applied to every key so several apps can share one Redis. Default "omni:". */
  keyPrefix?: string;
}

/**
 * Redis-backed storage. Increments run as a single server-side Lua script,
 * so counters are exact under concurrency across any number of proxy
 * instances, and the TTL is set exactly once by whichever writer creates the
 * key. TTLs are enforced by Redis itself; sub-second TTLs round up to one
 * second because EXPIRE/EX only accept whole seconds.
 */
export class RedisStorageAdapter implements StorageAdapter {
  readonly type = "redis";
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;

  constructor(client: RedisClientLike, options: RedisStorageAdapterOptions = {}) {
    this.client = client;
    this.keyPrefix = options.keyPrefix ?? "omni:";
  }

  private prefixed(key: string): string {
    return this.keyPrefix + key;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.prefixed(key));
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttlSeconds = options?.ttlSeconds;
    if (ttlSeconds === undefined) {
      await this.client.set(this.prefixed(key), value);
    } else {
      await this.client.set(this.prefixed(key), value, "EX", wholeSeconds(ttlSeconds));
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.prefixed(key));
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const result = await this.client.eval(
      INCREMENT_SCRIPT,
      1,
      this.prefixed(key),
      amount,
      wholeSeconds(ttlSeconds),
    );
    return Number(result);
  }

  async getCounter(key: string): Promise<number> {
    const raw = await this.client.get(this.prefixed(key));
    return raw === null ? 0 : Number(raw);
  }

  /** Closes the underlying connection (QUIT) — including injected clients. */
  async close(): Promise<void> {
    await this.client.quit();
  }
}

function wholeSeconds(ttlSeconds: number): number {
  return Math.max(1, Math.ceil(ttlSeconds));
}

const redisOptionsSchema = z.strictObject({
  type: z.literal("redis"),
  url: z.string().refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: 'expected a "redis://" or "rediss://" URL',
  }),
  keyPrefix: z.string().min(1).optional(),
});

/**
 * Storage factory for `storage: { type: redis, url: redis://..., keyPrefix? }`.
 * Imports ioredis lazily so the dependency is only loaded when Redis storage
 * is actually configured.
 */
export const redisStorageFactory: StorageFactory = {
  type: "redis",
  async create(options: Record<string, unknown>): Promise<StorageAdapter> {
    const parsed = redisOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ConfigError(`invalid redis storage options:\n${z.prettifyError(parsed.error)}`);
    }
    const { Redis } = await import("ioredis");
    const client = new Redis(parsed.data.url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    // ioredis declares `set`/`eval` through per-command overloads that don't
    // structurally match the variadic RedisClientLike signatures; every call
    // the adapter issues (SET k v [EX n], EVAL script 1 key a b) is a valid
    // overload at runtime.
    return new RedisStorageAdapter(client as unknown as RedisClientLike, {
      keyPrefix: parsed.data.keyPrefix,
    });
  },
};
