/**
 * The schema, as an ordered, forward-only list of migrations.
 *
 * Version 1 is generated from `src/schema.ts` — the Drizzle definitions are the
 * source of truth, and this is their SQL. Regenerate with:
 *
 *   pnpm --filter @omni-model/postgres run schema:generate
 *
 * then copy the reviewed statements in here. Two reasons the SQL is embedded
 * rather than read from `.sql` files at runtime: the container image needs no
 * migration files, and our own runner applies the whole set inside one
 * `pg_advisory_xact_lock` transaction so N containers booting at once migrate
 * exactly once. drizzle-kit's migrator does not take that lock, which is why it
 * generates SQL here but never applies it.
 *
 * Rules for adding one:
 * - Edit `schema.ts`, regenerate, and append the diff with the next `version`.
 *   Never renumber, edit, or delete a shipped migration: applied versions are
 *   recorded in `omni_migrations`, so an edited migration silently never runs on
 *   a database that already has it.
 * - A statement Drizzle cannot express (the NOTIFY trigger below) is appended by
 *   hand after the generated block, and stays in `schema.ts`'s doc comment so it
 *   is not lost on the next regeneration.
 * - **Strip drizzle-kit's `"public".` qualifiers.** It emits foreign keys as
 *   `REFERENCES "public"."omni_…"`, which pins the schema and breaks a deployment
 *   pointed at any other one — including the per-run schemas the integration
 *   tests use. Unqualified names resolve through `search_path`, which is what we
 *   want. A test asserts no migration names a schema.
 *
 * Every relation is prefixed `omni_`: omni-model owns those names in whatever
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

/** Tables and indexes, generated from `schema.ts` by drizzle-kit. */
const BASELINE_TABLES = `
CREATE TABLE "omni_config_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"note" text,
	"is_active" boolean DEFAULT false NOT NULL
);

CREATE TABLE "omni_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone
);

CREATE TABLE "omni_request_contents" (
	"request_log_id" uuid PRIMARY KEY NOT NULL,
	"messages" jsonb,
	"completion" text,
	"truncated" boolean DEFAULT false NOT NULL
);

CREATE TABLE "omni_request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	"write_key_id" uuid,
	"user_id" text,
	"device_id" text,
	"auth_provider" text,
	"model_requested" text NOT NULL,
	"model_routed" text,
	"provider_id" text,
	"route_name" text,
	"stream" boolean DEFAULT false NOT NULL,
	"status" integer NOT NULL,
	"error_code" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"latency_ms" integer,
	"ttfb_ms" integer,
	"ip" text,
	"user_agent" text,
	"rate_limit_rule" text
);

CREATE TABLE "omni_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"jwe" text NOT NULL,
	"hint" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "omni_write_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last4" text NOT NULL,
	"allowed_models" text[],
	"capture_content" boolean,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"disabled_at" timestamp with time zone
);

ALTER TABLE "omni_request_contents" ADD CONSTRAINT "omni_request_contents_request_log_id_omni_request_logs_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "omni_request_logs"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "omni_request_logs" ADD CONSTRAINT "omni_request_logs_write_key_id_omni_write_keys_id_fk" FOREIGN KEY ("write_key_id") REFERENCES "omni_write_keys"("id") ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "omni_config_revisions_active_idx" ON "omni_config_revisions" USING btree ("is_active") WHERE "omni_config_revisions"."is_active";

CREATE INDEX "omni_config_revisions_created_idx" ON "omni_config_revisions" USING btree ("created_at" DESC NULLS LAST);

CREATE INDEX "omni_kv_expires_idx" ON "omni_kv" USING btree ("expires_at");

CREATE INDEX "omni_request_logs_ts_idx" ON "omni_request_logs" USING btree ("ts" DESC NULLS LAST);

CREATE INDEX "omni_request_logs_write_key_idx" ON "omni_request_logs" USING btree ("write_key_id","ts" DESC NULLS LAST);

CREATE INDEX "omni_request_logs_user_idx" ON "omni_request_logs" USING btree ("user_id","ts" DESC NULLS LAST);

CREATE UNIQUE INDEX "omni_secrets_name_idx" ON "omni_secrets" USING btree ("name");

CREATE UNIQUE INDEX "omni_write_keys_hash_idx" ON "omni_write_keys" USING btree ("key_hash");

CREATE INDEX "omni_write_keys_created_idx" ON "omni_write_keys" USING btree ("created_at" DESC NULLS LAST);
`;

/**
 * The configuration change feed, which Drizzle has no vocabulary for.
 *
 * The trigger NOTIFYs `omni_config_changed` so other instances reload without
 * polling. Listeners must still poll as a fallback: a NOTIFY reaches only
 * sessions connected at commit time, so a listener that was reconnecting misses
 * it entirely.
 */
const CONFIG_CHANGE_FEED = `
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
 * The response cache, and the log column that explains a zero-token row.
 *
 * Generated by `schema:generate` as the diff against version 1.
 */
const PROMPT_CACHE = `
CREATE TABLE "omni_prompt_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"completion" jsonb,
	"sse" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
ALTER TABLE "omni_request_logs" ADD COLUMN "cached" boolean DEFAULT false NOT NULL;
CREATE INDEX "omni_prompt_cache_expires_idx" ON "omni_prompt_cache" USING btree ("expires_at");
CREATE INDEX "omni_prompt_cache_created_idx" ON "omni_prompt_cache" USING btree ("created_at");
`;

/** Every migration, in application order. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "baseline", sql: `${BASELINE_TABLES}\n${CONFIG_CHANGE_FEED}` },
  { version: 2, name: "prompt_cache", sql: PROMPT_CACHE },
];

/** Highest version this build knows how to apply. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, migration) => (migration.version > max ? migration.version : max),
  0,
);
