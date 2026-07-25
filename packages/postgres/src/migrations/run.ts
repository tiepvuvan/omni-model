import { ConfigError, type Logger } from "@omni-model/core";
import type { PgClientLike, PgPoolLike } from "../pool.js";
import { LATEST_VERSION, MIGRATIONS, type Migration } from "./sql.js";

/**
 * Advisory-lock key, arbitrary but permanent: changing it would let an old and
 * a new build migrate concurrently. (`0x6F6D6E69`, i.e. "omni".)
 */
const MIGRATION_LOCK_ID = 1_869_768_809;

const CREATE_LEDGER = `
CREATE TABLE IF NOT EXISTS omni_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/** What a {@link runMigrations} call actually did. */
export interface MigrationRunResult {
  /** Versions applied by this call, in order. Empty when already up to date. */
  applied: number[];
  /** Schema version after the run. */
  version: number;
  /**
   * Set when the database is *ahead* of this build — a newer instance already
   * migrated it. Not an error: migrations are forward-only and additive, so an
   * older instance keeps working against a newer schema. Failing here would
   * take down every old replica during a rolling deploy.
   */
  ahead?: number;
}

export interface RunMigrationsOptions {
  logger?: Logger;
}

/**
 * Bring the database up to {@link LATEST_VERSION}.
 *
 * Safe to call from every instance on every boot, concurrently:
 *
 * - The whole run happens in **one transaction** on **one connection**, guarded
 *   by `pg_advisory_xact_lock`. A second instance blocks on the lock, then sees
 *   the committed ledger and applies nothing.
 * - The lock is *transaction*-scoped, so it is released by COMMIT, ROLLBACK, or
 *   the connection dropping. A process killed mid-migration cannot wedge the
 *   database.
 * - All-or-nothing: Postgres has transactional DDL, so a failure at migration N
 *   rolls back 1..N too, and the next boot retries from a clean state. There is
 *   never a half-applied schema.
 */
export async function runMigrations(
  pool: PgPoolLike,
  options: RunMigrationsOptions = {},
): Promise<MigrationRunResult> {
  assertMigrationsWellFormed(MIGRATIONS);

  if (pool.connect === undefined) {
    throw new ConfigError(
      "postgres migrations need a pool that supports connect(): the advisory lock and the " +
        "transaction are session state, and pool.query() may use a different backend per " +
        "statement. Inject a real pg.Pool, or run migrations yourself and set migrate: false.",
    );
  }

  const client = await pool.connect();
  try {
    return await migrateOnClient(client, options.logger);
  } finally {
    client.release();
  }
}

async function migrateOnClient(
  client: PgClientLike,
  logger: Logger | undefined,
): Promise<MigrationRunResult> {
  await client.query("BEGIN");
  try {
    // Take the lock before reading the ledger, so the check and the writes that
    // depend on it cannot interleave with another instance.
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(CREATE_LEDGER);

    const applied = await appliedVersions(client);
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));

    for (const migration of pending) {
      logger?.info("applying migration", { version: migration.version, name: migration.name });
      await client.query(migration.sql);
      await client.query("INSERT INTO omni_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
    }

    await client.query("COMMIT");

    const highestApplied = Math.max(LATEST_VERSION, ...applied, 0);
    const result: MigrationRunResult = {
      applied: pending.map((migration) => migration.version),
      version: highestApplied,
    };
    if (highestApplied > LATEST_VERSION) {
      result.ahead = highestApplied;
      logger?.warn("database schema is newer than this build", {
        databaseVersion: highestApplied,
        buildVersion: LATEST_VERSION,
      });
    } else if (pending.length > 0) {
      logger?.info("migrations applied", { count: pending.length, version: LATEST_VERSION });
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original failure is the one worth surfacing.
    }
    throw error;
  }
}

async function appliedVersions(client: PgClientLike): Promise<Set<number>> {
  const result = await client.query("SELECT version FROM omni_migrations");
  const versions = new Set<number>();
  for (const row of result.rows) {
    const version = Number(row.version);
    if (Number.isInteger(version)) versions.add(version);
  }
  return versions;
}

/**
 * Guard against a bad edit to {@link MIGRATIONS}: versions must start at 1 and
 * increase by exactly one. Duplicates or gaps mean two branches added the same
 * number, which would apply in an order that depends on the merge.
 */
function assertMigrationsWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new ConfigError(
        `migration list is malformed: expected version ${index + 1} at position ${index}, ` +
          `found ${migration.version} ("${migration.name}"). Versions must start at 1, be ` +
          "gapless, and never be renumbered.",
      );
    }
  });
}
