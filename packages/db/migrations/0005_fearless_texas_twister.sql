CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"compiler_version" text NOT NULL,
	"eve_version" text NOT NULL,
	"model_provider" "model_provider" NOT NULL,
	"model_id" text NOT NULL,
	"build_status" "build_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"hash" text PRIMARY KEY NOT NULL,
	"status" "build_status" DEFAULT 'pending' NOT NULL,
	"artifact_key" text,
	"error_log" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_builds" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "workflow_builds" CASCADE;--> statement-breakpoint
DROP TABLE "workflow_versions" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_workflow_version_id_workflow_versions_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT "agent_sessions_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT "workflows_run_as_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "workflows" DROP CONSTRAINT IF EXISTS "workflows_published_version_id_workflow_versions_id_fk";
--> statement-breakpoint
DROP INDEX "agent_sessions_workflow_id_idx";--> statement-breakpoint
ALTER TABLE "agent_sessions" ALTER COLUMN "workflow_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "agent_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "agent_version_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "run_as_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "draft" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "task_message" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "delivery_status" "delivery_status";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "delivery_error" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "cron" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "next_fire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_versions_agent_id_idx" ON "agent_versions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_versions_content_hash_idx" ON "agent_versions" USING btree ("content_hash");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_run_as_user_id_user_id_fk" FOREIGN KEY ("run_as_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_published_version_id_agent_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_published_agent_id_agents_id_fk" FOREIGN KEY ("published_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_sessions_agent_id_idx" ON "agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "triggers_next_fire_at_idx" ON "triggers" USING btree ("next_fire_at") WHERE "triggers"."type" = 'schedule' AND "triggers"."enabled" = true;--> statement-breakpoint
CREATE INDEX "workflows_published_agent_id_idx" ON "workflows" USING btree ("published_agent_id");--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "workflow_version_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "base_prompt";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "reasoning_effort";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_preset";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "model_id";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "run_as_user_id";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "published_version_id";