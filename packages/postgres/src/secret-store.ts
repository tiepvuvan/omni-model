import type { SecretRow, SecretRowStore } from "@omni-model/core";
import type { PgPoolLike } from "./pool.js";

const COLUMNS = "id, name, ciphertext, iv, key_id, hint, fingerprint, created_at, updated_at";

interface Row {
  id?: unknown;
  name?: unknown;
  ciphertext?: unknown;
  iv?: unknown;
  key_id?: unknown;
  hint?: unknown;
  fingerprint?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function toBytes(value: unknown): Uint8Array {
  // `pg` returns BYTEA as a Buffer, which is already a Uint8Array.
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toSecretRow(row: Row): SecretRow {
  return {
    id: String(row.id),
    name: String(row.name),
    ciphertext: toBytes(row.ciphertext),
    iv: toBytes(row.iv),
    keyId: typeof row.key_id === "string" ? row.key_id : "",
    hint: typeof row.hint === "string" ? row.hint : "",
    fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : "",
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

/**
 * {@link SecretRowStore} over `omni_secrets`.
 *
 * Deliberately dumb: it moves opaque bytes and never touches a key or a
 * plaintext. All cryptography lives in `EnvelopeSecretStore`, so this class
 * cannot get the envelope wrong.
 */
export class PostgresSecretRowStore implements SecretRowStore {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async upsert(row: SecretRow): Promise<void> {
    await this.pool.query(
      "INSERT INTO omni_secrets " +
        "(id, name, ciphertext, iv, key_id, hint, fingerprint, created_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0)) " +
        "ON CONFLICT (id) DO UPDATE SET " +
        "name = EXCLUDED.name, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, " +
        "key_id = EXCLUDED.key_id, hint = EXCLUDED.hint, fingerprint = EXCLUDED.fingerprint, " +
        "updated_at = EXCLUDED.updated_at",
      [
        row.id,
        row.name,
        Buffer.from(row.ciphertext),
        Buffer.from(row.iv),
        row.keyId,
        row.hint,
        row.fingerprint,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async findById(id: string): Promise<SecretRow | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM omni_secrets WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row === undefined ? null : toSecretRow(row);
  }

  async findByName(name: string): Promise<SecretRow | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM omni_secrets WHERE name = $1`, [
      name,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toSecretRow(row);
  }

  async list(): Promise<SecretRow[]> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM omni_secrets ORDER BY name`);
    return result.rows.map(toSecretRow);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM omni_secrets WHERE id = $1 RETURNING id", [
      id,
    ]);
    return result.rows.length > 0;
  }
}
