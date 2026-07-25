/**
 * The database schema, as Drizzle table definitions.
 *
 * This is the single source of truth. `drizzle-kit generate` turns it into the
 * SQL in `migrations/sql.ts`, and every query in this package is built from these
 * objects — so a column rename is a type error at every call site rather than a
 * runtime failure on a query nobody ran in development.
 *
 * Every relation is prefixed `omni_`: omni-model owns those names in whatever
 * database or schema you point it at, and a test enforces the prefix.
 *
 * What Drizzle cannot express — the `NOTIFY` trigger behind configuration
 * reloads — is appended to the generated baseline by hand. See `migrations/`.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * `timestamptz` mapped to `Date`.
 *
 * The engine works in epoch milliseconds, so every row mapper converts — but the
 * column stays a real timestamp, because the retention sweep and the usage
 * summary aggregate with SQL date arithmetic that a bigint of milliseconds would
 * make unreadable.
 */
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Key/value rows behind rate-limit counters, token budgets and Apple attestation
 * state. Deliberately generic: the limiter owns the key format, not the schema.
 */
export const kv = pgTable(
  "omni_kv",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    expiresAt: instant("expires_at"),
  },
  (table) => [index("omni_kv_expires_idx").on(table.expiresAt)],
);

/**
 * Append-only configuration history.
 *
 * Exactly one row is active at a time, enforced by a partial unique index rather
 * than by application code — two replicas racing to activate a revision is a
 * constraint violation, not a database with two live configurations. A rollback
 * inserts a new row copying an old document, so history is never rewritten.
 */
export const configRevisions = pgTable(
  "omni_config_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    document: jsonb("document").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    createdBy: text("created_by"),
    note: text("note"),
    isActive: boolean("is_active").notNull().default(false),
  },
  (table) => [
    // Partial: only the active row participates, so many inactive revisions
    // coexist while a second active one is a constraint violation.
    uniqueIndex("omni_config_revisions_active_idx")
      .on(table.isActive)
      .where(sql`${table.isActive}`),
    index("omni_config_revisions_created_idx").on(table.createdAt.desc()),
  ],
);

/**
 * Encrypted credentials.
 *
 * `jwe` is a complete JWE in compact serialization — ciphertext, iv, tag, the
 * key id and the secret's own id, all in one authenticated string. Which master
 * key sealed a value is read from that header rather than stored beside it, so
 * the two can never disagree.
 *
 * `hint` and `fingerprint` exist so an admin UI can show *which* credential is
 * set without ever reading it back.
 */
export const secrets = pgTable(
  "omni_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    jwe: text("jwe").notNull(),
    hint: text("hint").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("omni_secrets_name_idx").on(table.name)],
);

/**
 * Per-client API keys.
 *
 * Only the SHA-256 hash is stored, so a database dump cannot be replayed against
 * the proxy; `prefix` and `last4` are for display. Revocation sets `disabledAt`
 * rather than deleting, so request logs keep pointing at a real row and past
 * usage stays attributable.
 */
export const writeKeys = pgTable(
  "omni_write_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    last4: text("last4").notNull(),
    allowedModels: text("allowed_models").array(),
    /** Three-state: null inherits the global `logging.content`. */
    captureContent: boolean("capture_content"),
    metadata: jsonb("metadata").notNull().default({}),
    createdBy: text("created_by"),
    createdAt: instant("created_at").notNull().defaultNow(),
    expiresAt: instant("expires_at"),
    disabledAt: instant("disabled_at"),
  },
  (table) => [
    uniqueIndex("omni_write_keys_hash_idx").on(table.keyHash),
    index("omni_write_keys_created_idx").on(table.createdAt.desc()),
  ],
);

/** One row per `/v1` request. Metadata only; content is a separate table. */
export const requestLogs = pgTable(
  "omni_request_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: instant("ts").notNull().defaultNow(),
    /** The id the client was handed in `x-omni-request-id`. */
    requestId: text("request_id"),
    writeKeyId: uuid("write_key_id").references(() => writeKeys.id, { onDelete: "set null" }),
    userId: text("user_id"),
    deviceId: text("device_id"),
    authProvider: text("auth_provider"),
    modelRequested: text("model_requested").notNull(),
    modelRouted: text("model_routed"),
    providerId: text("provider_id"),
    routeName: text("route_name"),
    stream: boolean("stream").notNull().default(false),
    status: integer("status").notNull(),
    errorCode: text("error_code"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    rateLimitRule: text("rate_limit_rule"),
  },
  (table) => [
    index("omni_request_logs_ts_idx").on(table.ts.desc()),
    index("omni_request_logs_write_key_idx").on(table.writeKeyId, table.ts.desc()),
    index("omni_request_logs_user_idx").on(table.userId, table.ts.desc()),
  ],
);

/**
 * Captured prompt and completion text.
 *
 * A separate table so it can be retained on a shorter clock — or never written
 * at all — without touching the metrics rows, and so the hot table stays narrow.
 * `ON DELETE CASCADE` means a retention sweep of the parent cannot orphan text.
 */
export const requestContents = pgTable("omni_request_contents", {
  requestLogId: uuid("request_log_id")
    .primaryKey()
    .references(() => requestLogs.id, { onDelete: "cascade" }),
  messages: jsonb("messages"),
  completion: text("completion"),
  truncated: boolean("truncated").notNull().default(false),
});

// `omni_migrations` is deliberately absent. It is the runner's own bookkeeping,
// created before any migration runs (`migrations/run.ts`), so a schema that
// declared it would make every `drizzle-kit generate` try to create it again.
