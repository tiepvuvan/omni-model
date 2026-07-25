import { createConsoleLogger, type Logger } from "@omni-model/core";
import { createPgPool, type MigrationRunResult, runMigrations } from "@omni-model/postgres";
import { postgresUrl } from "./bootstrap.js";

export interface MigrateArgs {
  env: Record<string, string | undefined>;
  logger?: Logger;
}

/**
 * Apply pending migrations and stop.
 *
 * The server already migrates on boot, so this exists for the deployments that
 * want the schema change to be its own reviewable step — a Kubernetes init
 * container or a CI job with a privileged database role, so the serving
 * containers can run with a role that cannot execute DDL
 * (`OMNI_STORAGE_POSTGRES_MIGRATE=false`).
 *
 * Safe to run concurrently with a booting server: both take the same advisory
 * lock inside one transaction, so exactly one applies each version.
 */
export async function applyMigrations(args: MigrateArgs): Promise<MigrationRunResult> {
  const logger = args.logger ?? createConsoleLogger("info");
  const pool = await createPgPool(postgresUrl(args.env, "migrate"));
  try {
    return await runMigrations(pool, { logger });
  } finally {
    await pool.end?.();
  }
}
