CREATE TYPE "public"."connection_oauth_client_mode" AS ENUM('cimd', 'dcr', 'preregistered');--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "client_identity_mode" "connection_oauth_client_mode";--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "client_registration_issuer" text;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "pending_started_by" text;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "expected_issuer" text;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "iss_parameter_supported" boolean;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_pending_started_by_user_id_fk" FOREIGN KEY ("pending_started_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;