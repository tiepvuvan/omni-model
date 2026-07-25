import type { SecretRow, SecretRowStore } from "@omni-model/core";
import { asc, eq } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import type { PgPoolLike } from "./pool.js";
import { secrets } from "./schema.js";

function toSecretRow(row: typeof secrets.$inferSelect): SecretRow {
  return {
    id: row.id,
    name: row.name,
    jwe: row.jwe,
    hint: row.hint,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * {@link SecretRowStore} over `omni_secrets`.
 *
 * Deliberately dumb: it moves one opaque string and never touches a key or a
 * plaintext. All cryptography lives in `EnvelopeSecretStore`, so this class
 * cannot get the envelope wrong.
 */
export class PostgresSecretRowStore implements SecretRowStore {
  private readonly db: Db;

  constructor(pool: PgPoolLike) {
    this.db = createDb(pool);
  }

  async upsert(row: SecretRow): Promise<void> {
    const values = {
      id: row.id,
      name: row.name,
      jwe: row.jwe,
      hint: row.hint,
      fingerprint: row.fingerprint,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
    await this.db
      .insert(secrets)
      .values(values)
      .onConflictDoUpdate({
        target: secrets.id,
        // Everything but `created_at`: replacing a value keeps the row's age, so
        // "when was this credential first added" survives a rotation.
        set: {
          name: values.name,
          jwe: values.jwe,
          hint: values.hint,
          fingerprint: values.fingerprint,
          updatedAt: values.updatedAt,
        },
      });
  }

  async findById(id: string): Promise<SecretRow | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.id, id)).limit(1);
    return row === undefined ? null : toSecretRow(row);
  }

  async findByName(name: string): Promise<SecretRow | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.name, name)).limit(1);
    return row === undefined ? null : toSecretRow(row);
  }

  async list(): Promise<SecretRow[]> {
    const rows = await this.db.select().from(secrets).orderBy(asc(secrets.name));
    return rows.map(toSecretRow);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(secrets)
      .where(eq(secrets.id, id))
      .returning({ id: secrets.id });
    return deleted.length > 0;
  }
}
