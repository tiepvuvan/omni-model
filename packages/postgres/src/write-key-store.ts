import {
  type CreatedWriteKey,
  type CreateWriteKeyInput,
  generateWriteKeySecret,
  hashWriteKeySecret,
  type WriteKey,
  type WriteKeyStore,
  writeKeyLabel,
} from "@omni-model/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createDb, type Db } from "./db.js";
import type { PgPoolLike } from "./pool.js";
import { writeKeys } from "./schema.js";

/** Columns a client may see. `key_hash` is deliberately not among them. */
const PUBLIC_COLUMNS = {
  id: writeKeys.id,
  name: writeKeys.name,
  prefix: writeKeys.prefix,
  last4: writeKeys.last4,
  allowedModels: writeKeys.allowedModels,
  captureContent: writeKeys.captureContent,
  metadata: writeKeys.metadata,
  createdBy: writeKeys.createdBy,
  createdAt: writeKeys.createdAt,
  expiresAt: writeKeys.expiresAt,
  disabledAt: writeKeys.disabledAt,
} as const;

type PublicRow = {
  [K in keyof typeof PUBLIC_COLUMNS]: (typeof writeKeys.$inferSelect)[K];
};

function toWriteKey(row: PublicRow): WriteKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    last4: row.last4,
    // A null array means "no restriction"; an empty array means "no models".
    allowedModels: row.allowedModels ?? null,
    // Null is meaningful here: it means "inherit the global setting".
    captureContent: row.captureContent,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt?.getTime() ?? null,
    disabledAt: row.disabledAt?.getTime() ?? null,
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
  private readonly db: Db;
  private readonly now: () => number;

  constructor(pool: PgPoolLike, options: { now?: () => number } = {}) {
    this.db = createDb(pool);
    this.now = options.now ?? Date.now;
  }

  async create(input: CreateWriteKeyInput): Promise<CreatedWriteKey> {
    const secret = generateWriteKeySecret();
    const label = writeKeyLabel(secret);
    const [row] = await this.db
      .insert(writeKeys)
      .values({
        name: input.name,
        keyHash: await hashWriteKeySecret(secret),
        prefix: label.prefix,
        last4: label.last4,
        // Absent *and* null mean unrestricted; only an explicit empty array means
        // "no models". Collapsing undefined to `[]` would park every new key.
        // Copied because the contract accepts a readonly array and the column
        // wants a mutable one.
        allowedModels:
          input.allowedModels === undefined || input.allowedModels === null
            ? null
            : [...input.allowedModels],
        captureContent: input.captureContent ?? null,
        metadata: input.metadata ?? {},
        createdBy: input.createdBy ?? null,
        expiresAt:
          input.expiresAt === undefined || input.expiresAt === null
            ? null
            : new Date(input.expiresAt),
      })
      .returning(PUBLIC_COLUMNS);
    if (row === undefined) throw new Error("creating a write key returned no row");
    return { writeKey: toWriteKey(row), secret };
  }

  async authenticate(secret: string): Promise<WriteKey | null> {
    const [row] = await this.db
      .select(PUBLIC_COLUMNS)
      .from(writeKeys)
      .where(eq(writeKeys.keyHash, await hashWriteKeySecret(secret)))
      .limit(1);
    return row === undefined ? null : toWriteKey(row);
  }

  async get(id: string): Promise<WriteKey | null> {
    const [row] = await this.db
      .select(PUBLIC_COLUMNS)
      .from(writeKeys)
      .where(eq(writeKeys.id, id))
      .limit(1);
    return row === undefined ? null : toWriteKey(row);
  }

  async list(): Promise<WriteKey[]> {
    const rows = await this.db
      .select(PUBLIC_COLUMNS)
      .from(writeKeys)
      .orderBy(desc(writeKeys.createdAt));
    return rows.map(toWriteKey);
  }

  async revoke(id: string): Promise<boolean> {
    // `disabledAt IS NULL` makes this idempotent and lets the caller tell a
    // first revocation from a repeat, without a separate read.
    const updated = await this.db
      .update(writeKeys)
      .set({ disabledAt: new Date(this.now()) })
      .where(and(eq(writeKeys.id, id), isNull(writeKeys.disabledAt)))
      .returning({ id: writeKeys.id });
    return updated.length > 0;
  }
}
