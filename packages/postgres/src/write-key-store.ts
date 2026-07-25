import {
  type CreatedWriteKey,
  type CreateWriteKeyInput,
  generateWriteKeySecret,
  hashWriteKeySecret,
  type WriteKey,
  type WriteKeyStore,
  writeKeyLabel,
} from "@omni-model/core";
import type { PgPoolLike } from "./pool.js";

const COLUMNS =
  "id, name, prefix, last4, allowed_models, metadata, created_by, created_at, expires_at, disabled_at";

interface Row {
  id?: unknown;
  name?: unknown;
  prefix?: unknown;
  last4?: unknown;
  allowed_models?: unknown;
  metadata?: unknown;
  created_by?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  disabled_at?: unknown;
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toMillisOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toMillis(value);
}

function toWriteKey(row: Row): WriteKey {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: typeof row.prefix === "string" ? row.prefix : "",
    last4: typeof row.last4 === "string" ? row.last4 : "",
    // A NULL array means "no restriction"; an empty array means "no models".
    allowedModels: Array.isArray(row.allowed_models) ? row.allowed_models.map(String) : null,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    createdAt: toMillis(row.created_at),
    expiresAt: toMillisOrNull(row.expires_at),
    disabledAt: toMillisOrNull(row.disabled_at),
  };
}

/**
 * {@link WriteKeyStore} over `omni_write_keys`.
 *
 * Only the SHA-256 of a key is ever stored, so a database dump cannot be
 * replayed against the proxy. Wrap this in `CachedWriteKeyStore` before serving
 * traffic — otherwise every `/v1` request costs a query.
 */
export class PostgresWriteKeyStore implements WriteKeyStore {
  readonly type = "postgres";
  private readonly pool: PgPoolLike;
  private readonly now: () => number;

  constructor(pool: PgPoolLike, options: { now?: () => number } = {}) {
    this.pool = pool;
    this.now = options.now ?? Date.now;
  }

  async create(input: CreateWriteKeyInput): Promise<CreatedWriteKey> {
    const secret = generateWriteKeySecret();
    const label = writeKeyLabel(secret);
    const result = await this.pool.query(
      "INSERT INTO omni_write_keys " +
        "(name, key_hash, prefix, last4, allowed_models, metadata, created_by, expires_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, " +
        "CASE WHEN $8::float8 IS NULL THEN NULL ELSE to_timestamp($8 / 1000.0) END) " +
        `RETURNING ${COLUMNS}`,
      [
        input.name,
        await hashWriteKeySecret(secret),
        label.prefix,
        label.last4,
        input.allowedModels ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.createdBy ?? null,
        input.expiresAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("creating a write key returned no row");
    return { writeKey: toWriteKey(row), secret };
  }

  async authenticate(secret: string): Promise<WriteKey | null> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM omni_write_keys WHERE key_hash = $1`,
      [await hashWriteKeySecret(secret)],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWriteKey(row);
  }

  async get(id: string): Promise<WriteKey | null> {
    const result = await this.pool.query(`SELECT ${COLUMNS} FROM omni_write_keys WHERE id = $1`, [
      id,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toWriteKey(row);
  }

  async list(): Promise<WriteKey[]> {
    const result = await this.pool.query(
      `SELECT ${COLUMNS} FROM omni_write_keys ORDER BY created_at DESC`,
    );
    return result.rows.map(toWriteKey);
  }

  async revoke(id: string): Promise<boolean> {
    // `disabled_at IS NULL` makes this idempotent and lets the caller tell a
    // first revocation from a repeat, without a separate read.
    const result = await this.pool.query(
      "UPDATE omni_write_keys SET disabled_at = to_timestamp($2 / 1000.0) " +
        "WHERE id = $1 AND disabled_at IS NULL RETURNING id",
      [id, this.now()],
    );
    return result.rows.length > 0;
  }
}
