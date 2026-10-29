CREATE TABLE IF NOT EXISTS "offices" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"theme" text DEFAULT '#6366f1' NOT NULL,
	"zones" text[] NOT NULL,
	"characters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offices" ADD CONSTRAINT "offices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offices_workspace_idx" ON "offices" USING btree ("workspace_id");
