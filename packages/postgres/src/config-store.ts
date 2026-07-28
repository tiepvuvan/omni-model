import type {
  ConfigStore,
  Logger,
  SaveConfigOptions,
  StoredConfig,
  StoredConfigMeta,
} from "@omni-model/core";
import { desc, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import type { PgClientLike, PgPoolLike } from "./pool.js";
import { configRevisions } from "./schema.js";

/** Channel the `omni_config_revisions` trigger notifies on activation. */
const CHANNEL = "omni_config_changed";

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface PostgresConfigStoreOptions {
  /**
   * How often to check for a revision activated elsewhere. This is the
   * convergence guarantee, not an optimization: LISTEN can miss a notification
   * (it only reaches sessions connected at commit time), so polling is what
   * makes every replica eventually agree.
   */
  pollIntervalMs?: number;
  logger?: Logger;
}

/** One revision as Drizzle returns it. */
type RevisionRow = typeof configRevisions.$inferSelect;

function toStoredConfig(row: RevisionRow): StoredConfig {
  return {
    revision: row.id,
    document: row.document,
    createdAt: row.createdAt.getTime(),
    createdBy: row.createdBy,
    note: row.note,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrow a `pg` notification without trusting its shape. */
function notificationRevision(arg: unknown): number | null {
  if (typeof arg !== "object" || arg === null) return null;
  const payload = (arg as { payload?: unknown }).payload;
  if (typeof payload !== "string") return null;
  const revision = Number(payload);
  return Number.isInteger(revision) ? revision : null;
}

/**
 * {@link ConfigStore} over `omni_config_revisions`.
 *
 * History is append-only and exactly one row is active, enforced by a partial
 * unique index — so "which configuration is live" cannot become ambiguous even
 * if two admins save at once: one transaction wins and the other retries.
 */
export class PostgresConfigStore implements ConfigStore {
  readonly type = "postgres";
  private readonly pool: PgPoolLike;
  private readonly db: Db;
  private readonly pollIntervalMs: number;
  private readonly log: Logger | undefined;
  private readonly listeners = new Set<(revision: number) => void>();
  /** Highest revision already reported (or applied by us), to avoid re-firing. */
  private lastSeen = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private listener: PgClientLike | undefined;
  /** Idempotent destroy callbacks for a live or not-yet-LISTENing checked-out client. */
  private releaseListener: (() => void) | undefined;
  private releasePendingListener: (() => void) | undefined;
  private listeningTask: Promise<void> | undefined;
  private listening = false;
  private closed = false;

  constructor(pool: PgPoolLike, options: PostgresConfigStoreOptions = {}) {
    this.pool = pool;
    this.db = createDb(pool);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.log = options.logger;
  }

  async loadActive(): Promise<StoredConfig | null> {
    const [row] = await this.db
      .select()
      .from(configRevisions)
      .where(eq(configRevisions.isActive, true))
      .limit(1);
    if (row === undefined) return null;
    const stored = toStoredConfig(row);
    // Reading the active revision counts as having seen it, so a watcher started
    // after boot does not immediately re-announce what we already applied.
    this.lastSeen = Math.max(this.lastSeen, stored.revision);
    return stored;
  }

  async save(document: unknown, options: SaveConfigOptions = {}): Promise<StoredConfig> {
    if (this.pool.connect === undefined) {
      throw new Error(
        "saving a configuration revision needs a pool that supports connect(): deactivating the " +
          "previous revision and inserting the new one must be one transaction",
      );
    }
    const stored = await this.db.transaction(async (tx) => {
      // Both statements in one transaction: the partial unique index would
      // otherwise reject the insert while the old row is still active.
      await tx
        .update(configRevisions)
        .set({ isActive: false })
        .where(eq(configRevisions.isActive, true));
      const [row] = await tx
        .insert(configRevisions)
        .values({
          document: document ?? null,
          createdBy: options.createdBy ?? null,
          note: options.note ?? null,
          isActive: true,
        })
        .returning();
      if (row === undefined) throw new Error("saving a configuration revision returned no row");
      const saved = toStoredConfig(row);
      // Marked as seen *inside* the transaction, before COMMIT. The trigger's
      // NOTIFY is delivered to the listening connection at commit time, so doing
      // this after `transaction()` resolves is a race the listener sometimes
      // wins — and then the instance that just saved a revision redundantly
      // reloads it. Nothing breaks, but it is work we claim not to do.
      //
      // Safe even if the transaction then rolls back: the id came from a
      // sequence, and a rolled-back insert burns that value rather than
      // returning it to a later revision.
      this.lastSeen = Math.max(this.lastSeen, saved.revision);
      return saved;
    });
    return stored;
  }

  async get(revision: number): Promise<StoredConfig | null> {
    const [row] = await this.db
      .select()
      .from(configRevisions)
      .where(eq(configRevisions.id, revision))
      .limit(1);
    return row === undefined ? null : toStoredConfig(row);
  }

  async history(limit = 50): Promise<StoredConfigMeta[]> {
    const rows = await this.db
      .select({
        revision: configRevisions.id,
        createdAt: configRevisions.createdAt,
        createdBy: configRevisions.createdBy,
        note: configRevisions.note,
        active: configRevisions.isActive,
      })
      .from(configRevisions)
      .orderBy(desc(configRevisions.id))
      .limit(limit);
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() }));
  }

  watch(onChange: (revision: number) => void): () => void {
    this.listeners.add(onChange);
    this.start();
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) this.stop();
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.stop();
    await this.listeningTask;
  }

  private start(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    // Never hold the process open just to watch for config changes.
    this.timer.unref?.();
    this.ensureListening();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Destroy rather than return these: one is in LISTEN mode and the other may
    // have a LISTEN query in flight. Clearing the references before releasing
    // makes synchronous `error`/`end` events harmless.
    const releasePending = this.releasePendingListener;
    this.releasePendingListener = undefined;
    releasePending?.();
    const release = this.releaseListener;
    this.releaseListener = undefined;
    this.listener = undefined;
    release?.();
    this.listening = false;
  }

  /** The convergence guarantee. Failures are logged and retried next tick. */
  private async poll(): Promise<void> {
    try {
      const [row] = await this.db
        .select({ id: configRevisions.id })
        .from(configRevisions)
        .where(eq(configRevisions.isActive, true))
        .limit(1);
      if (row !== undefined) this.announce(row.id);
    } catch (error) {
      this.log?.warn("configuration poll failed; will retry", { error: errorMessage(error) });
    }
    // A dropped LISTEN connection is re-established here rather than in its own
    // retry loop, so there is exactly one place that owns reconnection.
    if (!this.listening) this.ensureListening();
  }

  /** Own the one in-flight connection attempt so close can wait for it. */
  private ensureListening(): void {
    if (this.listeningTask !== undefined) return;
    const task = this.startListening();
    this.listeningTask = task;
    void task.finally(() => {
      if (this.listeningTask === task) this.listeningTask = undefined;
    });
  }

  /**
   * LISTEN is a latency optimization only: it turns a ~poll-interval delay into
   * a near-instant one. Every failure path silently degrades to polling.
   */
  private async startListening(): Promise<void> {
    if (this.closed || this.listening || this.pool.connect === undefined) return;
    this.listening = true;
    let release: (() => void) | undefined;
    try {
      const client = await this.pool.connect();
      let released = false;
      const destroy = (): void => {
        if (released) return;
        released = true;
        client.release(true);
      };
      release = destroy;
      this.releasePendingListener = destroy;
      // `close()` can run while `connect()` is in flight. A connection that
      // arrives afterwards must be destroyed instead of entering LISTEN mode
      // with no owner left to release it.
      if (this.closed) {
        this.releasePendingListener = undefined;
        destroy();
        this.listening = false;
        return;
      }
      if (typeof client.on !== "function") {
        // Not a real pg client (a test double, say): polling covers us.
        this.releasePendingListener = undefined;
        released = true;
        client.release();
        this.listening = false;
        return;
      }
      client.on("notification", (arg) => {
        const revision = notificationRevision(arg);
        if (revision !== null) this.announce(revision);
      });
      const drop = (): void => {
        if (this.listener === client) {
          this.listener = undefined;
          this.releaseListener = undefined;
        }
        if (this.releasePendingListener === destroy) {
          this.releasePendingListener = undefined;
        }
        this.listening = false;
        // A checked-out pg client must still be released when the underlying
        // socket errors or ends. Losing our reference without this leaves
        // Pool.end() waiting forever for a borrower that can never return.
        destroy();
      };
      client.on("error", drop);
      client.on("end", drop);
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.releasePendingListener === destroy) {
        this.releasePendingListener = undefined;
      }
      // The LISTEN query itself can race with close for the same reason.
      if (this.closed) {
        destroy();
        this.listening = false;
        return;
      }
      this.listener = client;
      this.releaseListener = destroy;
    } catch (error) {
      release?.();
      if (this.releasePendingListener === release) {
        this.releasePendingListener = undefined;
      }
      this.listening = false;
      this.log?.debug("configuration LISTEN unavailable; relying on polling", {
        error: errorMessage(error),
      });
    }
  }

  /** Fire listeners for a revision newer than anything already reported. */
  private announce(revision: number): void {
    if (revision <= this.lastSeen) return;
    this.lastSeen = revision;
    for (const listener of this.listeners) {
      try {
        listener(revision);
      } catch (error) {
        this.log?.error("configuration change listener threw", { error: errorMessage(error) });
      }
    }
  }
}
