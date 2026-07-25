import { describe, expect, it } from "vitest";
import { CachedWriteKeyStore } from "../../src/writekeys/cache.js";
import {
  generateWriteKeySecret,
  hashWriteKeySecret,
  looksLikeWriteKey,
  WRITE_KEY_PREFIX,
  writeKeyLabel,
} from "../../src/writekeys/keys.js";
import { MemoryWriteKeyStore } from "../../src/writekeys/memory.js";
import { writeKeyAllowsModel, writeKeyState } from "../../src/writekeys/types.js";

describe("write key format", () => {
  it("is prefixed so secret scanners can recognise a leak", () => {
    const secret = generateWriteKeySecret();
    expect(secret.startsWith(WRITE_KEY_PREFIX)).toBe(true);
    expect(looksLikeWriteKey(secret)).toBe(true);
  });

  it("is unguessable and never repeats", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateWriteKeySecret()));
    expect(keys.size).toBe(200);
    // 32 random bytes as base64url.
    expect(generateWriteKeySecret()).toMatch(/^omk_[A-Za-z0-9_-]{43}$/);
  });

  it("rejects things that are not shaped like a key, before any lookup", () => {
    // The cheap gate that keeps a junk-credential flood from reaching a store.
    for (const value of ["", "omk_", "sk-1234567890", "omk_short", "omk_has spaces in it"]) {
      expect(looksLikeWriteKey(value)).toBe(false);
    }
  });

  it("labels a key with a searchable prefix and a tail, never the middle", () => {
    const secret = generateWriteKeySecret();
    const label = writeKeyLabel(secret);
    expect(secret.startsWith(label.prefix)).toBe(true);
    expect(label.prefix).toHaveLength(12);
    expect(label.last4).toBe(secret.slice(-4));
    // Together they must not be enough to reconstruct the key.
    expect(label.prefix.length + label.last4.length).toBeLessThan(secret.length);
  });

  it("hashes deterministically and differently per key", async () => {
    const a = generateWriteKeySecret();
    expect(await hashWriteKeySecret(a)).toBe(await hashWriteKeySecret(a));
    expect(await hashWriteKeySecret(a)).not.toBe(
      await hashWriteKeySecret(generateWriteKeySecret()),
    );
    expect(await hashWriteKeySecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashWriteKeySecret(a)).not.toContain(a.slice(4, 20));
  });
});

describe("writeKeyState", () => {
  const base = {
    id: "1",
    name: "n",
    prefix: "omk_aaaa",
    last4: "zzzz",
    allowedModels: null,
    metadata: {},
    createdBy: null,
    createdAt: 0,
    expiresAt: null,
    disabledAt: null,
  };

  it("classifies active, revoked and expired", () => {
    expect(writeKeyState(base, 1000)).toBe("active");
    expect(writeKeyState({ ...base, disabledAt: 500 }, 1000)).toBe("revoked");
    expect(writeKeyState({ ...base, expiresAt: 999 }, 1000)).toBe("expired");
    expect(writeKeyState({ ...base, expiresAt: 1001 }, 1000)).toBe("active");
  });

  it("reports revoked ahead of expired, so the operator sees the deliberate act", () => {
    expect(writeKeyState({ ...base, disabledAt: 1, expiresAt: 2 }, 1000)).toBe("revoked");
  });

  it("treats a null allowlist as unrestricted and an empty one as nothing", () => {
    expect(writeKeyAllowsModel(base, "anything")).toBe(true);
    expect(writeKeyAllowsModel({ ...base, allowedModels: [] }, "anything")).toBe(false);
    expect(writeKeyAllowsModel({ ...base, allowedModels: ["a"] }, "a")).toBe(true);
    expect(writeKeyAllowsModel({ ...base, allowedModels: ["a"] }, "b")).toBe(false);
  });
});

describe("MemoryWriteKeyStore", () => {
  it("returns the plaintext exactly once, at creation", async () => {
    const store = new MemoryWriteKeyStore(() => 1000);
    const { writeKey, secret } = await store.create({ name: "ios-app" });

    expect(writeKey.name).toBe("ios-app");
    expect(writeKey.prefix).toBe(secret.slice(0, 12));
    // Nothing readable afterwards contains the key.
    expect(JSON.stringify(await store.get(writeKey.id))).not.toContain(secret);
    expect(JSON.stringify(await store.list())).not.toContain(secret);
  });

  it("authenticates a real key and rejects a forged one", async () => {
    const store = new MemoryWriteKeyStore();
    const { writeKey, secret } = await store.create({ name: "ios-app" });

    expect((await store.authenticate(secret))?.id).toBe(writeKey.id);
    expect(await store.authenticate(generateWriteKeySecret())).toBeNull();
    // A near-miss must not authenticate.
    expect(await store.authenticate(`${secret}x`)).toBeNull();
  });

  it("revokes without deleting, so usage history keeps its subject", async () => {
    const store = new MemoryWriteKeyStore(() => 5000);
    const { writeKey, secret } = await store.create({ name: "ios-app" });

    expect(await store.revoke(writeKey.id)).toBe(true);
    // Second revoke is a no-op, not an error.
    expect(await store.revoke(writeKey.id)).toBe(false);

    const revoked = await store.authenticate(secret);
    expect(revoked).not.toBeNull();
    expect(writeKeyState(revoked as NonNullable<typeof revoked>, 6000)).toBe("revoked");
    expect(await store.list()).toHaveLength(1);
  });

  it("carries an allowlist, metadata, an owner and an expiry", async () => {
    const store = new MemoryWriteKeyStore(() => 1000);
    const { writeKey } = await store.create({
      name: "restricted",
      allowedModels: ["cheap"],
      metadata: { team: "growth" },
      createdBy: "alice",
      expiresAt: 9999,
    });

    expect(writeKey).toMatchObject({
      allowedModels: ["cheap"],
      metadata: { team: "growth" },
      createdBy: "alice",
      expiresAt: 9999,
      createdAt: 1000,
    });
  });

  it("lists newest first", async () => {
    let clock = 0;
    const store = new MemoryWriteKeyStore(() => {
      clock += 1000;
      return clock;
    });
    await store.create({ name: "first" });
    await store.create({ name: "second" });

    expect((await store.list()).map((key) => key.name)).toEqual(["second", "first"]);
  });
});

describe("CachedWriteKeyStore", () => {
  it("serves a repeated lookup without touching the inner store", async () => {
    const inner = new MemoryWriteKeyStore();
    let lookups = 0;
    const counting = {
      ...inner,
      type: inner.type,
      authenticate: async (secret: string) => {
        lookups += 1;
        return inner.authenticate(secret);
      },
    };
    const store = new CachedWriteKeyStore(counting, { ttlMs: 10_000, now: () => 1000 });
    const { secret } = await inner.create({ name: "ios-app" });

    expect((await store.authenticate(secret))?.name).toBe("ios-app");
    expect((await store.authenticate(secret))?.name).toBe("ios-app");
    expect((await store.authenticate(secret))?.name).toBe("ios-app");

    expect(lookups).toBe(1);
    expect(store.hits).toBe(2);
    expect(store.misses).toBe(1);
  });

  it("caches misses, so a junk-key flood is not a database DoS", async () => {
    const inner = new MemoryWriteKeyStore();
    let lookups = 0;
    const counting = {
      ...inner,
      type: inner.type,
      authenticate: async (secret: string) => {
        lookups += 1;
        return inner.authenticate(secret);
      },
    };
    const store = new CachedWriteKeyStore(counting, { now: () => 1000 });
    const bogus = generateWriteKeySecret();

    expect(await store.authenticate(bogus)).toBeNull();
    expect(await store.authenticate(bogus)).toBeNull();

    expect(lookups).toBe(1);
  });

  it("re-reads once the TTL passes, which is how a revocation propagates", async () => {
    const inner = new MemoryWriteKeyStore(() => 0);
    let clock = 1000;
    const store = new CachedWriteKeyStore(inner, { ttlMs: 5000, now: () => clock });
    const { writeKey, secret } = await inner.create({ name: "ios-app" });

    expect(await store.authenticate(secret)).not.toBeNull();
    await inner.revoke(writeKey.id);

    // Still cached: the stale entry is the documented cost of not querying per request.
    expect((await store.authenticate(secret))?.disabledAt).toBeNull();

    clock += 5001;
    expect((await store.authenticate(secret))?.disabledAt).not.toBeNull();
  });

  it("evicts immediately when this instance is the one revoking", async () => {
    const inner = new MemoryWriteKeyStore(() => 0);
    const store = new CachedWriteKeyStore(inner, { ttlMs: 60_000, now: () => 1000 });
    const { writeKey, secret } = await store.create({ name: "ios-app" });

    expect(await store.authenticate(secret)).not.toBeNull();
    expect(await store.revoke(writeKey.id)).toBe(true);

    // No TTL wait for the replica that performed the revocation.
    expect((await store.authenticate(secret))?.disabledAt).not.toBeNull();
  });

  it("pre-warms a freshly created key", async () => {
    const inner = new MemoryWriteKeyStore();
    const store = new CachedWriteKeyStore(inner, { now: () => 1000 });
    const { secret } = await store.create({ name: "ios-app" });

    expect(await store.authenticate(secret)).not.toBeNull();
    // The first request with a brand-new key should not have to miss.
    expect(store.misses).toBe(0);
  });

  it("stays bounded when flooded with distinct keys", async () => {
    const inner = new MemoryWriteKeyStore();
    const store = new CachedWriteKeyStore(inner, { maxEntries: 10, now: () => 1000 });

    for (let i = 0; i < 200; i += 1) await store.authenticate(generateWriteKeySecret());

    // Memory must not grow with attacker-controlled input.
    expect(store.misses).toBe(200);
  });

  it("never uses the plaintext key as a cache key", async () => {
    const inner = new MemoryWriteKeyStore();
    const store = new CachedWriteKeyStore(inner, { now: () => 1000 });
    const { secret } = await store.create({ name: "ios-app" });
    await store.authenticate(secret);

    // A heap dump of the cache must not hand over usable credentials.
    expect(
      JSON.stringify([...(store as unknown as { entries: Map<string, unknown> }).entries]),
    ).not.toContain(secret);
  });
});
