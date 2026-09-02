ALTER TABLE "runs" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "remote_cancel_unresolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runs_agent_session_turn_idx" ON "runs" USING btree ("agent_session_id","turn_id");