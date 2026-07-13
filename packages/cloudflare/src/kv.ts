import type { StorageAdapter, StorageFactory } from "@omni-model/core";
import { ConfigError } from "@omni-model/core";
import { z } from "zod";
import type { KVNamespaceLike } from "./cf-types.js";

/** Workers KV rejects `expirationTtl` below 60 seconds, so shorter TTLs are clamped up. */
const MIN_KV_TTL_SECONDS = 60;

function kvExpirationTtl(ttlSeconds: number): number {
  return Math.max(MIN_KV_TTL_SECONDS, Math.ceil(ttlSeconds));
}

const optionsSchema = z.strictObject({
  type: z.string().optional(),
  /** KV binding name from wrangler config; consumed by the worker entry, not by this adapter. */
  binding: z.string().min(1).optional(),
});

/**
 * Storage backed by a Workers KV namespace. Counters are stored as plain
 * numeric strings.
 *
 * WARNING: `increment` is a NON-atomic read-modify-write on an eventually
 * consistent store. Concurrent increments from different isolates or edge
 * locations can lose updates, so counts are approximate — good enough for
 * best-effort rate limiting, NOT for strict quotas. Use the `durable-object`
 * storage type when limits must be exact.
 *
 * TTL semantics: KV cannot cheaply read a key's remaining TTL, so every
 * counter write re-applies the original window TTL. A busy window therefore
 * drifts later rather than expiring early — counts persist at least as long
 * as the window, which errs on the side of stricter limiting. TTLs shorter
 * than the KV minimum of 60 seconds are clamped up to 60.
 */
export class KVStorageAdapter implements StorageAdapter {
  readonly type = "cloudflare-kv";
  private readonly namespace: KVNamespaceLike;

  constructor(namespace: KVNamespaceLike) {
    this.namespace = namespace;
  }

  async get(key: string): Promise<string | null> {
    return this.namespace.get(key);
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttlSeconds = options?.ttlSeconds;
    if (ttlSeconds === undefined) {
      await this.namespace.put(key, value);
    } else {
      await this.namespace.put(key, value, { expirationTtl: kvExpirationTtl(ttlSeconds) });
    }
  }

  async delete(key: string): Promise<void> {
    await this.namespace.delete(key);
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const current = await this.namespace.get(key);
    const base = current === null ? 0 : Number(current);
    const next = (Number.isFinite(base) ? base : 0) + amount;
    await this.namespace.put(key, String(next), { expirationTtl: kvExpirationTtl(ttlSeconds) });
    return next;
  }

  async getCounter(key: string): Promise<number> {
    const value = await this.namespace.get(key);
    if (value === null) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

/**
 * Builds the `cloudflare-kv` storage factory. The KV namespace is a Workers
 * binding that only the worker entry can see (`RuntimeContext.env` carries
 * strings only), so the entry constructs the factory from the binding and
 * registers it before config resolution.
 */
export function createKVStorageFactory(namespace: KVNamespaceLike): StorageFactory {
  return {
    type: "cloudflare-kv",
    create: (options) => {
      const parsed = optionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new ConfigError(
          `invalid cloudflare-kv storage options: ${z.prettifyError(parsed.error)}`,
        );
      }
      return new KVStorageAdapter(namespace);
    },
  };
}
