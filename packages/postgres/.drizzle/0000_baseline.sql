CREATE TABLE "omni_config_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"note" text,
	"is_active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "omni_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "omni_request_contents" (
	"request_log_id" uuid PRIMARY KEY NOT NULL,
	"messages" jsonb,
	"completion" text,
	"truncated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "omni_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"jwe" text NOT NULL,
	"hint" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "omni_request_contents" ADD CONSTRAINT "omni_request_contents_request_log_id_omni_request_logs_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."omni_request_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "omni_request_logs" ADD CONSTRAINT "omni_request_logs_write_key_id_omni_write_keys_id_fk" FOREIGN KEY ("write_key_id") REFERENCES "public"."omni_write_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "omni_config_revisions_active_idx" ON "omni_config_revisions" USING btree ("is_active") WHERE "omni_config_revisions"."is_active";--> statement-breakpoint
CREATE INDEX "omni_config_revisions_created_idx" ON "omni_config_revisions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "omni_kv_expires_idx" ON "omni_kv" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "omni_request_logs_ts_idx" ON "omni_request_logs" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "omni_request_logs_write_key_idx" ON "omni_request_logs" USING btree ("write_key_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "omni_request_logs_user_idx" ON "omni_request_logs" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "omni_secrets_name_idx" ON "omni_secrets" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "omni_write_keys_hash_idx" ON "omni_write_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "omni_write_keys_created_idx" ON "omni_write_keys" USING btree ("created_at" DESC NULLS LAST);