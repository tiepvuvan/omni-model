import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is a **development-time SQL generator** here, not the migrator.
 *
 * `pnpm --filter @omni-model/postgres run schema:generate` writes to `.drizzle/`;
 * the reviewed statements are then copied into `src/migrations/sql.ts` as string
 * constants and applied by our own runner. That runner wraps the whole set in one
 * `pg_advisory_xact_lock` transaction, so N containers booting at once migrate
 * exactly once — a property drizzle-kit's migrator does not provide, and the
 * reason we keep ours. Embedding the SQL also means the container image needs no
 * migration files.
 *
 * `.drizzle/` is **committed**, and `.drizzle/meta/` is the part that matters:
 * the snapshot is what lets the next `generate` emit a *diff* of the schema. Drop
 * it and the next contributor gets another full baseline to paste in as if it
 * were migration 2, which would try to re-create every table.
 */
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./.drizzle",
  dialect: "postgresql",
});
