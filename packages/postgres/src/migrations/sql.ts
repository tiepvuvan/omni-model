/**
 * The schema, as an ordered, forward-only list of migrations.
 *
 * Rules for adding one:
 * - Append with the next `version`; never renumber, edit, or delete a shipped
 *   migration. Applied versions are recorded in `omni_migrations`, so an edited
 *   migration silently never runs on databases that already have it.
 * - Express changes so re-running is harmless (`IF NOT EXISTS`, `DROP ... IF
 *   EXISTS` before `CREATE`). The runner already skips applied versions; this is
 *   the second line of defence.
 * - The SQL is embedded here rather than read from `.sql` files so the container
 *   image needs no extra copy step and `packages/core`'s no-filesystem rule
 *   stays easy to hold.
 *
 * Every table is prefixed `omni_`: omni-model owns those names in whatever
 * database or schema you point it at.
 */
export interface Migration {
  /** Monotonic, gapless, and permanent once shipped. */
  readonly version: number;
  /** Short slug for logs and the `omni_migrations` table. */
  readonly name: string;
  /** One or more statements. Runs inside the migration transaction. */
  readonly sql: string;
}

/** Key/value rows behind rate-limit counters, token budgets and Apple attestation state. */
const KV = `
CREATE TABLE IF NOT EXISTS omni_kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS omni_kv_expires_idx ON omni_kv (expires_at);
`;

/**
 * Append-only configuration history. Exactly one row is active at a time
 * (enforced by a partial unique index), and a rollback is a new row copying an
 * old document rather than a mutation — so history is never rewritten.
 *
 * The trigger NOTIFYs `omni_config_changed` so other instances reload without
 * polling. Listeners must still poll as a fallback: a NOTIFY is delivered only
 * to sessions connected at commit time, so a listener that was reconnecting
 * misses it.
 */
const CONFIG_REVISIONS = `
CREATE TABLE IF NOT EXISTS omni_config_revisions (
  id         BIGSERIAL PRIMARY KEY,
  document   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  note       TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS omni_config_revisions_active_idx
  ON omni_config_revisions (is_active) WHERE is_active;

CREATE INDEX IF NOT EXISTS omni_config_revisions_created_idx
  ON omni_config_revisions (created_at DESC);

CREATE OR REPLACE FUNCTION omni_config_changed() RETURNS trigger AS $fn$
BEGIN
  PERFORM pg_notify('omni_config_changed', NEW.id::text);
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS omni_config_revisions_notify ON omni_config_revisions;
CREATE TRIGGER omni_config_revisions_notify
  AFTER INSERT OR UPDATE OF is_active ON omni_config_revisions
  FOR EACH ROW WHEN (NEW.is_active)
  EXECUTE FUNCTION omni_config_changed();
`;

/**
 * Encrypted secret values. Configuration documents store only a reference
 * (`{"$secret": "<id>"}`), so a revision dump, an audit log or a rollback diff
 * can never carry a credential. `hint` and `fingerprint` exist so an admin UI
 * can show *which* secret is set without ever reading it back.
 */
const SECRETS = `
CREATE TABLE IF NOT EXISTS omni_secrets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  ciphertext  BYTEA NOT NULL,
  iv          BYTEA NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  hint        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS omni_secrets_name_idx ON omni_secrets (name);
`;

/**
 * Per-client API keys. Only the SHA-256 hash is stored; `prefix` and `last4`
 * are for display. Revocation is `disabled_at`, not deletion, so request logs
 * keep pointing at a real row.
 */
const WRITE_KEYS = `
CREATE TABLE IF NOT EXISTS omni_write_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  key_hash       TEXT NOT NULL,
  prefix         TEXT NOT NULL,
  last4          TEXT NOT NULL,
  allowed_models TEXT[],
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  disabled_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS omni_write_keys_hash_idx ON omni_write_keys (key_hash);
CREATE INDEX IF NOT EXISTS omni_write_keys_created_idx ON omni_write_keys (created_at DESC);
`;

/**
 * One row per /v1 request. Content lives in a separate table so it can be
 * retained on a shorter clock — or never written at all — without touching the
 * metrics rows, and so the hot table stays narrow.
 */
const REQUEST_LOGS = `
CREATE TABLE IF NOT EXISTS omni_request_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id        TEXT,
  write_key_id      UUID REFERENCES omni_write_keys (id) ON DELETE SET NULL,
  user_id           TEXT,
  device_id         TEXT,
  auth_provider     TEXT,
  model_requested   TEXT NOT NULL,
  model_routed      TEXT,
  provider_id       TEXT,
  route_name        TEXT,
  stream            BOOLEAN NOT NULL DEFAULT FALSE,
  status            INTEGER NOT NULL,
  error_code        TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  latency_ms        INTEGER,
  ttfb_ms           INTEGER,
  ip                TEXT,
  user_agent        TEXT,
  rate_limit_rule   TEXT
);
CREATE INDEX IF NOT EXISTS omni_request_logs_ts_idx ON omni_request_logs (ts DESC);
CREATE INDEX IF NOT EXISTS omni_request_logs_write_key_idx
  ON omni_request_logs (write_key_id, ts DESC);
CREATE INDEX IF NOT EXISTS omni_request_logs_user_idx ON omni_request_logs (user_id, ts DESC);

CREATE TABLE IF NOT EXISTS omni_request_contents (
  request_log_id UUID PRIMARY KEY REFERENCES omni_request_logs (id) ON DELETE CASCADE,
  messages       JSONB,
  completion     TEXT,
  truncated      BOOLEAN NOT NULL DEFAULT FALSE
);
`;

/**
 * Master keys are identified by a short digest derived from the key itself, not
 * by a counter — so rotation needs no bookkeeping and a ciphertext says which
 * key sealed it. That is a text id, so `key_version INTEGER` from migration 3
 * cannot hold it.
 *
 * Expressed as an additive change rather than an edit to migration 3: an edited
 * migration silently never runs where it already applied.
 */
const SECRET_KEY_IDS = `
ALTER TABLE omni_secrets DROP COLUMN IF EXISTS key_version;
ALTER TABLE omni_secrets ADD COLUMN IF NOT EXISTS key_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS omni_secrets_key_idx ON omni_secrets (key_id);
`;

/**
 * Per-client content capture, as a three-state column: NULL inherits the global
 * `logging.content`, TRUE and FALSE force it. Nullable rather than
 * `NOT NULL DEFAULT FALSE` precisely so "inherit" is representable.
 */
const WRITE_KEY_CONTENT_CAPTURE = `
ALTER TABLE omni_write_keys ADD COLUMN IF NOT EXISTS capture_content BOOLEAN;
`;

/** Every migration, in application order. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "kv", sql: KV },
  { version: 2, name: "config_revisions", sql: CONFIG_REVISIONS },
  { version: 3, name: "secrets", sql: SECRETS },
  { version: 4, name: "write_keys", sql: WRITE_KEYS },
  { version: 5, name: "request_logs", sql: REQUEST_LOGS },
  { version: 6, name: "secret_key_ids", sql: SECRET_KEY_IDS },
  { version: 7, name: "write_key_content_capture", sql: WRITE_KEY_CONTENT_CAPTURE },
];

/** Highest version this build knows how to apply. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.version > max ? migration.version : max),
  0,
);
