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
--> statement-breakpoint
ALTER TABLE "omni_request_logs" ADD COLUMN "cached" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "omni_prompt_cache_expires_idx" ON "omni_prompt_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "omni_prompt_cache_created_idx" ON "omni_prompt_cache" USING btree ("created_at");