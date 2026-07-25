import { hashWriteKeySecret } from "./keys.js";
import type { CreatedWriteKey, CreateWriteKeyInput, WriteKey, WriteKeyStore } from "./types.js";

/** How long a lookup is reused. Also the worst-case delay before a revocation bites. */
const DEFAULT_TTL_MS = 10_000;

/** Bound on cached entries, so a flood of distinct junk keys cannot grow memory. */
const DEFAULT_MAX_ENTRIES = 5_000;

interface CacheEntry {
  /** null caches a *miss*, which is what makes junk-key floods cheap. */
  value: WriteKey | null;
  expiresAt: number;
}

export interface CachedWriteKeyStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * Per-process cache in front of a {@link WriteKeyStore}.
 *
 * Every `/v1` request presents a key, so an uncached store means a database
 * round trip per request. The cache is deliberately **in-process** rather than in
 * the `StorageAdapter`: that adapter is usually Postgres, so "caching" there
 * would turn one read into a read plus a write and make things worse.
 *
 * Misses are cached too. Without that, spraying random keys at `/v1` would be an
 * unauthenticated way to generate unbounded database load.
 *
 * The cost is that a revocation takes effect on other replicas only after the
 * TTL. That is the trade: a few seconds of exposure against a database query on
 * every request. Lower `ttlMs` to shorten it.
 */
export class CachedWriteKeyStore implements WriteKeyStore {
  readonly type: string;
  private readonly inner: WriteKeyStore;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Keyed by hash, never by the plaintext key. */
  private readonly entries = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(inner: WriteKeyStore, options: CachedWriteKeyStoreOptions = {}) {
    this.inner = inner;
    this.type = inner.type;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  async authenticate(secret: string): Promise<WriteKey | null> {
    // Hashing first means the plaintext is never a map key, so a heap dump does
    // not hand over usable credentials.
    const hash = await hashWriteKeySecret(secret);
    const nowMs = this.now();
    const cached = this.entries.get(hash);
    if (cached !== undefined && cached.expiresAt > nowMs) {
      this.hits += 1;
      return cached.value === null ? null : { ...cached.value };
    }

    this.misses += 1;
    const value = await this.inner.authenticate(secret);
    this.remember(hash, value, nowMs);
    return value === null ? null : { ...value };
  }

  async create(input: CreateWriteKeyInput): Promise<CreatedWriteKey> {
    const created = await this.inner.create(input);
    // Pre-warm so the first request with a brand-new key does not miss, and so a
    // negative entry for this hash (if someone guessed it) cannot linger.
    this.remember(await hashWriteKeySecret(created.secret), created.writeKey, this.now());
    return created;
  }

  async get(id: string): Promise<WriteKey | null> {
    return this.inner.get(id);
  }

  async list(): Promise<WriteKey[]> {
    return this.inner.list();
  }

  async revoke(id: string): Promise<boolean> {
    const revoked = await this.inner.revoke(id);
    // Local effect is immediate; other replicas converge within the TTL.
    if (revoked) this.evictById(id);
    return revoked;
  }

  async close(): Promise<void> {
    this.entries.clear();
    await this.inner.close?.();
  }

  /** Drop everything, e.g. after an out-of-band change to the underlying store. */
  clear(): void {
    this.entries.clear();
  }

  private remember(hash: string, value: WriteKey | null, nowMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      // Evict expired first; fall back to the oldest insertion (Map preserves it).
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= nowMs) this.entries.delete(key);
      }
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
    }
    this.entries.set(hash, { value, expiresAt: nowMs + this.ttlMs });
  }

  private evictById(id: string): void {
    for (const [hash, entry] of this.entries) {
      if (entry.value?.id === id) this.entries.delete(hash);
    }
  }
}
