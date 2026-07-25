/** One result set. Only `rows` is used, so any `pg`-compatible driver fits. */
export interface PgQueryResult {
  rows: Record<string, unknown>[];
}

/**
 * A single connection checked out of a pool. Migrations need one because a
 * transaction — and the advisory lock inside it — is session state: `pool.query`
 * may hand each statement to a different backend.
 */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  /** `true` destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
  /**
   * Event subscription, present on real `pg` clients. Used only for
   * LISTEN/NOTIFY, and always feature-detected: a pool that omits it still
   * works, it just falls back to polling.
   */
  on?(event: "notification" | "error" | "end", handler: (arg: unknown) => void): void;
}

/**
 * Minimal structural subset of a `pg` Pool. Tests stub it in memory, and
 * embedders can inject their own pool (PgBouncer, RDS Proxy, custom TLS)
 * instead of going through {@link createPgPool}.
 *
 * `connect` is optional so a stateless pool still satisfies the storage
 * adapter, which only ever issues single self-contained statements. Migrations
 * require it and say so.
 */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
  connect?(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

/**
 * Build a real `pg` pool from a connection string. `pg` is imported lazily so
 * the driver only loads when Postgres is actually configured, and because
 * `pg.Pool` connects lazily this does no I/O.
 */
export async function createPgPool(url: string): Promise<PgPoolLike> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: url }) as unknown as PgPoolLike;
}
