import { ConfigError, type StorageAdapter, type StorageFactory } from "@omni-model/core";
import { z } from "zod";

/**
 * Structural view of a Firestore document snapshot. The firebase-admin
 * `DocumentSnapshot` structurally satisfies this (its `data()` returns the
 * richer `DocumentData`, assignable to `Record<string, unknown> | undefined`).
 */
export interface FirestoreDocumentSnapshotLike {
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/** Structural view of a Firestore document reference. */
export interface FirestoreDocumentRefLike {
  get(): Promise<FirestoreDocumentSnapshotLike>;
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}

/** Structural view of a Firestore collection reference. */
export interface FirestoreCollectionLike {
  doc(id: string): FirestoreDocumentRefLike;
}

/**
 * Structural view of a Firestore transaction. All reads (`get`) must precede
 * writes (`set`/`delete`); the SDK enforces this at runtime.
 */
export interface FirestoreTransactionLike {
  get(ref: FirestoreDocumentRefLike): Promise<FirestoreDocumentSnapshotLike>;
  set(ref: FirestoreDocumentRefLike, data: Record<string, unknown>): unknown;
  delete(ref: FirestoreDocumentRefLike): unknown;
}

/**
 * Structural view of a Firestore instance.
 *
 * The firebase-admin Firestore instance structurally satisfies FirestoreLike.
 */
export interface FirestoreLike {
  collection(path: string): FirestoreCollectionLike;
  runTransaction<T>(updateFn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T>;
}

/** Persisted document shape. `expiresAt` is epoch milliseconds, or null when the key never expires. */
type StoredDoc = {
  value: string;
  expiresAt: number | null;
};

const DEFAULT_COLLECTION = "omni_ratelimits";

/**
 * Firestore-backed {@link StorageAdapter}: a serverless rate-limit and
 * token-budget store for Firebase / Google Cloud deployments.
 *
 * **Atomic counters.** {@link FirestoreStorageAdapter.increment} runs inside
 * `runTransaction` so the read-modify-write is serialized against concurrent
 * writers. Firestore may run the transaction callback multiple times on
 * contention, so the callback is pure: it reads the doc, computes the next
 * value, writes it, and returns it, never mutating anything outside the
 * transaction. `now()` is sampled once at the top of the callback so retries
 * evaluate window expiry consistently.
 *
 * **TTL is cleanup-only.** Firestore's TTL policy is best-effort (deletion can
 * lag by ~24h) and expired documents still surface in reads, so it must never
 * be relied on for the rate-limit window. Correctness comes from comparing the
 * stored `expiresAt` to `now()` on every read.
 *
 * **Per-document write rate.** Firestore sustains ~1 write/sec per document.
 * Per-user counter keys stay well under that; a single global hot key (e.g. an
 * account-wide limit) would contend and should be sharded by the caller.
 */
export class FirestoreStorageAdapter implements StorageAdapter {
  readonly type = "firestore";
  private readonly collection: FirestoreCollectionLike;
  private readonly runTransaction: FirestoreLike["runTransaction"];
  private readonly now: () => number;

  constructor(firestore: FirestoreLike, options?: { collection?: string; now?: () => number }) {
    this.collection = firestore.collection(options?.collection ?? DEFAULT_COLLECTION);
    this.runTransaction = firestore.runTransaction.bind(firestore);
    this.now = options?.now ?? (() => Date.now());
  }

  private live(snap: FirestoreDocumentSnapshotLike): StoredDoc | null {
    if (!snap.exists) return null;
    const data = snap.data();
    if (data === undefined) return null;
    const expiresAt = data.expiresAt;
    const at = typeof expiresAt === "number" ? expiresAt : null;
    if (at !== null && at <= this.now()) return null;
    return { value: String(data.value), expiresAt: at };
  }

  async get(key: string): Promise<string | null> {
    const snap = await this.collection.doc(key).get();
    return this.live(snap)?.value ?? null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttlSeconds = options?.ttlSeconds;
    const doc: StoredDoc = {
      value,
      expiresAt: ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000,
    };
    await this.collection.doc(key).set(doc);
  }

  async delete(key: string): Promise<void> {
    await this.collection.doc(key).delete();
  }

  async increment(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const ref = this.collection.doc(key);
    // The callback may run multiple times on contention; it must be idempotent
    // and mutate nothing outside the transaction. `now` is sampled per attempt
    // (a fresh read each retry is fine — the window boundary is re-evaluated
    // against current time), and the counter derives only from the re-read
    // document, so a retry never double-counts.
    return this.runTransaction(async (tx) => {
      const now = this.now();
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() : undefined;
      const expiresAt =
        existing && typeof existing.expiresAt === "number" ? existing.expiresAt : null;
      const expired = expiresAt !== null && expiresAt <= now;
      let next: number;
      let nextExpiresAt: number | null;
      if (existing === undefined || expired) {
        next = amount;
        nextExpiresAt = now + ttlSeconds * 1000;
      } else {
        next = Number(existing.value) + amount;
        nextExpiresAt = expiresAt;
      }
      const doc: StoredDoc = { value: String(next), expiresAt: nextExpiresAt };
      tx.set(ref, doc);
      return next;
    });
  }

  async getCounter(key: string): Promise<number> {
    const snap = await this.collection.doc(key).get();
    const entry = this.live(snap);
    return entry === null ? 0 : Number(entry.value);
  }
}

const firestoreOptionsSchema = z.strictObject({
  type: z.literal("firestore").optional(),
  collection: z.string().min(1).optional(),
});

/**
 * Storage factory for `storage: { type: firestore, collection? }`.
 *
 * The Firestore instance is supplied by the embedder (it carries credentials
 * and project config), so the Node runtime passes it here rather than
 * constructing it from declarative configuration. The
 * adapter's counters are atomic via `runTransaction` with an idempotent,
 * retry-safe callback; note that Firestore TTL is cleanup-only (correctness
 * comes from the stored `expiresAt`) and that a document sustains only
 * ~1 write/sec, so global hot keys must be sharded by the caller.
 */
export function createFirestoreStorageFactory(firestore: FirestoreLike): StorageFactory {
  return {
    type: "firestore",
    create(options: Record<string, unknown>, runtime): StorageAdapter {
      const parsed = firestoreOptionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new ConfigError(
          `invalid firestore storage options:\n${z.prettifyError(parsed.error)}`,
        );
      }
      return new FirestoreStorageAdapter(firestore, {
        collection: parsed.data.collection,
        now: runtime.now,
      });
    },
  };
}
