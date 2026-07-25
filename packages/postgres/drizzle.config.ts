import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is a **development-time SQL generator** here, not the migrator.
 *
 * `pnpm --filter @omni-model/postgres run schema:generate` writes SQL to
 * `.drizzle/`, which is git-ignored and never shipped: the reviewed statements
 * are copied into `src/migrations/sql.ts` as string constants and applied by our
 * own runner. That runner wraps the whole set in one `pg_advisory_xact_lock`
 * transaction, so N containers booting at once migrate exactly once — a property
 * drizzle-kit's migrator does not provide, and the reason we keep ours. Embedding
 * the SQL also means the container image needs no migration files.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./.drizzle",
  dialect: "postgresql",
});
