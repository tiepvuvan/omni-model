/**
 * A stored configuration revision. `document` is the raw, unvalidated JSON as
 * it was saved: validation happens when a bundle is built from it, so a
 * revision written by a newer build (with fields this one does not know) can
 * still be read, reported, and rolled back rather than crashing the reader.
 */
export interface StoredConfig {
  /** Monotonic revision number. Larger is newer. */
  revision: number;
  document: unknown;
  /** Epoch milliseconds. */
  createdAt: number;
  createdBy: string | null;
  note: string | null;
}

/** A revision's metadata, for listing history without loading every document. */
export interface StoredConfigMeta {
  revision: number;
  createdAt: number;
  createdBy: string | null;
  note: string | null;
  /** Whether this is the revision currently being served. */
  active: boolean;
}

export interface SaveConfigOptions {
  /** Who made the change, for the audit trail. */
  createdBy?: string;
  /** Free-text reason, shown in history. */
  note?: string;
}

/**
 * Persistent home for the proxy's configuration.
 *
 * History is **append-only**: `save` adds a revision and makes it active, and a
 * rollback is a new revision copying an old document. Nothing rewrites history,
 * so "what was serving at 14:05" always has an answer.
 *
 * Implementations must never store secret *values*. Configuration documents
 * carry secret references; the values live in their own encrypted table.
 */
export interface ConfigStore {
  readonly type: string;

  /** The revision currently being served, or null when nothing is configured. */
  loadActive(): Promise<StoredConfig | null>;

  /** Append `document` as a new revision and make it the active one. */
  save(document: unknown, options?: SaveConfigOptions): Promise<StoredConfig>;

  /** Fetch one revision by number, or null when it does not exist. */
  get(revision: number): Promise<StoredConfig | null>;

  /** Newest first. */
  history(limit?: number): Promise<StoredConfigMeta[]>;

  /**
   * Observe activations made by *other* instances, so a change through one
   * replica's admin API reaches all of them.
   *
   * The callback receives the newly active revision number. Implementations
   * must converge even when their change feed drops: treat push notification as
   * a latency optimization and poll as the guarantee. Delivery may be
   * coalesced, duplicated, or late — the callback must therefore be idempotent.
   *
   * Returns an unsubscribe function.
   */
  watch(onChange: (revision: number) => void): () => void;

  close?(): Promise<void>;
}
