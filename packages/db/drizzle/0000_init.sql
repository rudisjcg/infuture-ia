CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"action" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"kind" text NOT NULL,
	"uri" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"meta" jsonb,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"kind" text NOT NULL,
	"author_worker_id" uuid,
	"content" text NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"alias" text NOT NULL,
	"auth_type" text NOT NULL,
	"base_url" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"budget_usd_month" numeric(10, 2),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"hint" text,
	"oauth_expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dashboard_layouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"layout" jsonb NOT NULL,
	"widgets" jsonb NOT NULL,
	"theme" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_id" text,
	"span_id" text,
	"parent_span_id" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_ts_id_pk" PRIMARY KEY("ts","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"model_key" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"context_window" integer,
	"price_in_per_mtok" numeric(10, 4),
	"price_out_per_mtok" numeric(10, 4),
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"auth_types" text[] NOT NULL,
	"manifest" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"reviewer_worker_id" uuid,
	"reviewer_model_id" uuid,
	"round" integer NOT NULL,
	"verdict" text,
	"critique" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"workspace_id" uuid NOT NULL,
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"name" jsonb NOT NULL,
	"system_prompt" jsonb NOT NULL,
	"requires" text[] NOT NULL,
	"prefers" jsonb,
	"tools" text[] NOT NULL,
	"limits" jsonb,
	"approval" jsonb,
	"sprite" text,
	CONSTRAINT "roles_workspace_id_id_version_pk" PRIMARY KEY("workspace_id","id","version")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "runs_locale_check" CHECK ("runs"."locale" in ('en', 'es'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"worker_id" uuid,
	"title" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" text NOT NULL,
	"depends_on" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"model_id" uuid,
	"run_id" uuid,
	"worker_id" uuid,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"latency_ms" integer,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_locale_check" CHECK ("users"."locale" in ('en', 'es'))
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role_id" text NOT NULL,
	"role_version" integer NOT NULL,
	"name" text NOT NULL,
	"model_id" uuid,
	"fallback_model_ids" uuid[],
	"pinned" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_locale_check" CHECK ("workspaces"."default_locale" in ('en', 'es'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_author_worker_id_workers_id_fk" FOREIGN KEY ("author_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_worker_id_workers_id_fk" FOREIGN KEY ("reviewer_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_model_id_models_id_fk" FOREIGN KEY ("reviewer_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_posts_run_topic_idx" ON "board_posts" USING btree ("run_id","topic","seq");--> statement-breakpoint
CREATE INDEX "connections_workspace_idx" ON "connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "events_run_seq_idx" ON "events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "events_worker_ts_idx" ON "events" USING btree ("worker_id","ts");--> statement-breakpoint
CREATE INDEX "events_type_ts_idx" ON "events" USING btree ("type","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "models_connection_key_idx" ON "models" USING btree ("connection_id","model_key");--> statement-breakpoint
CREATE INDEX "runs_workspace_idx" ON "runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tasks_run_idx" ON "tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_workspace_ts_idx" ON "usage_ledger" USING btree ("workspace_id","ts");