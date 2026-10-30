ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "office_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "zone" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "character_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_office_idx" ON "runs" USING btree ("office_id");--> statement-breakpoint
ALTER TABLE "offices" ADD COLUMN IF NOT EXISTS "zone_capacity" jsonb;
