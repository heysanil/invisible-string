CREATE TYPE "public"."run_mode" AS ENUM('agent', 'pipeline');--> statement-breakpoint
CREATE TYPE "public"."run_step_kind" AS ENUM('tool', 'infer', 'agent', 'for_each', 'branch', 'filter', 'state', 'script');--> statement-breakpoint
CREATE TYPE "public"."run_step_status" AS ENUM('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'canceled');--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"step_id" text NOT NULL,
	"step_slug" text NOT NULL,
	"path" text NOT NULL,
	"parent_path" text,
	"iteration" integer,
	"kind" "run_step_kind" NOT NULL,
	"status" "run_step_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"error_class" text,
	"child_run_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_state" (
	"workflow_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_run_id" uuid,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_state_workflow_id_key_pk" PRIMARY KEY("workflow_id","key")
);
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "agent_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "mode" "run_mode" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_child_run_id_runs_id_fk" FOREIGN KEY ("child_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_updated_by_run_id_runs_id_fk" FOREIGN KEY ("updated_by_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_id_path_uidx" ON "run_steps" USING btree ("run_id","path");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_organization_id_idx" ON "runs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runs_workflow_id_idx" ON "runs" USING btree ("workflow_id");