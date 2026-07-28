CREATE TABLE "omni_admin_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "omni_admin_invites_token_idx" ON "omni_admin_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "omni_admin_invites_email_idx" ON "omni_admin_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "omni_admin_invites_expires_idx" ON "omni_admin_invites" USING btree ("expires_at");