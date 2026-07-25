import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgPoolLike } from "./pool.js";
import * as schema from "./schema.js";

/** A Drizzle handle bound to the schema in `schema.ts`. */
export type Db = NodePgDatabase<typeof schema>;

/**
 * Wrap a pool in a Drizzle handle.
 *
 * The pool stays the unit of connection sharing: everything in this package —
 * the typed queries, the raw advisory locks, the LISTEN/NOTIFY client and Better
 * Auth over in `packages/admin` — runs on the one pool the backend built.
 *
 * The cast is because {@link PgPoolLike} is the narrow structural contract we ask
 * embedders for (`query(text, values)`), while Drizzle calls
 * `query(queryConfig, values)` to get array row mode. A real `pg.Pool` satisfies
 * both; a stub used with Drizzle has to accept the object form.
 */
export function createDb(pool: PgPoolLike): Db {
  return drizzle(pool as never, { schema });
}
