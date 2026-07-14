import { ConfigError, type RuntimeContext, silentLogger } from "@omni-model/core";
import { beforeEach, describe, expect, test } from "vitest";
import {
  createFirestoreStorageFactory,
  type FirestoreCollectionLike,
  type FirestoreDocumentRefLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  FirestoreStorageAdapter,
  type FirestoreTransactionLike,
} from "../src/firestore.js";

interface Row {
  value: string;
  expiresAt: number | null;
}

/** Fake doc ref that carries its id so the transaction can map it back to the store. */
type TaggedRef = FirestoreDocumentRefLike & { __id: string };

/** A snapshot over a cloned row so callers can't mutate the store through `data()`. */
function snapshot(row: Row | undefined): FirestoreDocumentSnapshotLike {
  return {
    exists: row !== undefined,
    data: () => (row === undefined ? undefined : { ...row }),
  };
}

/**
 * In-memory FirestoreLike backed by a Map. `runTransaction` buffers writes and
 * commits them only when the callback resolves, emulating atomicity. The number
 * of times the callback is invoked before committing is configurable, so tests
 * can simulate Firestore's contention retries.
 */
class FakeFirestore implements FirestoreLike {
  readonly store = new Map<string, Row>();
  constructor(private readonly callbackRuns = 1) {}

  collection(_path: string): FirestoreCollectionLike {
    return {
      doc: (id: string): TaggedRef => ({
        __id: id,
        get: async () => snapshot(this.store.get(id)),
        set: async (data) => {
          this.store.set(id, { value: String(data.value), expiresAt: normExpiry(data.expiresAt) });
        },
        delete: async () => {
          this.store.delete(id);
        },
      }),
    };
  }

  async runTransaction<T>(updateFn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T> {
    let result: T | undefined;
    // Re-run the callback `callbackRuns` times against the live store, buffering
    // writes each attempt; only the final attempt's buffer is committed. Because
    // the adapter's callback mutates nothing outside the transaction, replays
    // must not double-count.
    for (let attempt = 0; attempt < this.callbackRuns; attempt++) {
      const buffered = new Map<string, Row | null>();
      const tx: FirestoreTransactionLike = {
        get: async (ref) => {
          const id = idOf(ref);
          if (buffered.has(id)) return snapshot(buffered.get(id) ?? undefined);
          return snapshot(this.store.get(id));
        },
        set: (ref, data) => {
          buffered.set(idOf(ref), {
            value: String(data.value),
            expiresAt: normExpiry(data.expiresAt),
          });
        },
        delete: (ref) => {
          buffered.set(idOf(ref), null);
        },
      };
      result = await updateFn(tx);
      if (attempt === this.callbackRuns - 1) {
        for (const [id, row] of buffered) {
          if (row === null) this.store.delete(id);
          else this.store.set(id, row);
        }
      }
    }
    return result as T;
  }
}

function normExpiry(raw: unknown): number | null {
  return typeof raw === "number" ? raw : null;
}

function idOf(ref: FirestoreDocumentRefLike): string {
  const tagged = ref as Partial<TaggedRef>;
  if (tagged.__id === undefined) throw new Error("ref missing __id tag");
  return tagged.__id;
}

/** A clock the tests advance manually. */
class Clock {
  ms = 0;
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
  now = (): number => this.ms;
}

function testRuntime(now: () => number): RuntimeContext {
  const fetchStub: typeof fetch = () => Promise.reject(new Error("network disabled in tests"));
  return { env: {}, fetch: fetchStub, now, waitUntil: () => {}, log: silentLogger };
}

describe("FirestoreStorageAdapter", () => {
  let firestore: FakeFirestore;
  let clock: Clock;
  let adapter: FirestoreStorageAdapter;

  beforeEach(() => {
    firestore = new FakeFirestore();
    clock = new Clock();
    adapter = new FirestoreStorageAdapter(firestore, { now: clock.now });
  });

  test("put then get returns the stored value", async () => {
    await adapter.put("k", "hello");
    expect(await adapter.get("k")).toBe("hello");
  });

  test("get returns null for absent keys", async () => {
    expect(await adapter.get("missing")).toBeNull();
  });

  test("get honors ttl expiry via the clock", async () => {
    await adapter.put("k", "v", { ttlSeconds: 10 });
    clock.advance(9);
    expect(await adapter.get("k")).toBe("v");
    clock.advance(1);
    expect(await adapter.get("k")).toBeNull();
  });

  test("delete removes the key", async () => {
    await adapter.put("k", "v");
    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
  });

  test("increment first write returns the amount and sets the window", async () => {
    expect(await adapter.increment("c", 3, 60)).toBe(3);
    // The window is live now and expired past ttl.
    clock.advance(59);
    expect(await adapter.getCounter("c")).toBe(3);
    clock.advance(1);
    expect(await adapter.getCounter("c")).toBe(0);
  });

  test("increment accumulates within the window", async () => {
    await adapter.increment("c", 2, 60);
    expect(await adapter.increment("c", 5, 60)).toBe(7);
    expect(await adapter.getCounter("c")).toBe(7);
  });

  test("increment after expiry resets to the amount with a fresh window", async () => {
    await adapter.increment("c", 4, 10);
    clock.advance(10);
    expect(await adapter.increment("c", 2, 10)).toBe(2);
    clock.advance(9);
    expect(await adapter.getCounter("c")).toBe(2);
  });

  test("getCounter returns 0 for absent keys", async () => {
    expect(await adapter.getCounter("nope")).toBe(0);
  });

  test("increment is idempotent across transaction retries", async () => {
    const retrying = new FakeFirestore(2);
    const retryAdapter = new FirestoreStorageAdapter(retrying, { now: clock.now });
    // Even though the callback runs twice, the counter must land on `amount`
    // once, not `2 * amount` — the callback mutates nothing outside the tx.
    expect(await retryAdapter.increment("c", 5, 60)).toBe(5);
    expect(await retryAdapter.getCounter("c")).toBe(5);
    // A second call replays twice again but still increments by exactly 5.
    expect(await retryAdapter.increment("c", 5, 60)).toBe(10);
    expect(await retryAdapter.getCounter("c")).toBe(10);
  });
});

describe("createFirestoreStorageFactory", () => {
  const clock = new Clock();

  test("creates an adapter with default and custom collection", () => {
    const factory = createFirestoreStorageFactory(new FakeFirestore());
    expect(factory.type).toBe("firestore");
    const adapter = factory.create({ type: "firestore" }, testRuntime(clock.now));
    expect(adapter.type).toBe("firestore");
    expect(
      factory.create({ type: "firestore", collection: "custom" }, testRuntime(clock.now)),
    ).toBeInstanceOf(FirestoreStorageAdapter);
  });

  test("rejects an empty collection", () => {
    const factory = createFirestoreStorageFactory(new FakeFirestore());
    expect(() => factory.create({ collection: "" }, testRuntime(clock.now))).toThrow(ConfigError);
  });

  test("rejects unknown option keys", () => {
    const factory = createFirestoreStorageFactory(new FakeFirestore());
    expect(() =>
      factory.create({ type: "firestore", bogus: true }, testRuntime(clock.now)),
    ).toThrow(ConfigError);
  });
});
