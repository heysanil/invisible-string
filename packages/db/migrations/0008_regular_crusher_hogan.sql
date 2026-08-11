CREATE TYPE "public"."connection_auth_type" AS ENUM('none', 'bearer', 'headers', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."connection_health" AS ENUM('unknown', 'ok', 'unreachable', 'auth_required', 'auth_error');--> statement-breakpoint
CREATE TYPE "public"."connection_oauth_status" AS ENUM('pending', 'connected', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."connection_source" AS ENUM('catalog', 'registry', 'custom');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('streamable-http', 'sse');--> statement-breakpoint
CREATE TABLE "connection_oauth" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"authorization_server" text,
	"authorization_endpoint" text,
	"token_endpoint" text,
	"scopes" jsonb,
	"client_id" text,
	"client_secret_encrypted" text,
	"access_token_encrypted" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_encrypted" text,
	"status" "connection_oauth_status" DEFAULT 'pending' NOT NULL,
	"pending_state" text,
	"pending_code_verifier_encrypted" text,
	"pending_expires_at" timestamp with time zone,
	"connected_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_oauth_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "resource_scope" NOT NULL,
	"organization_id" text,
	"user_id" text,
	"name" text NOT NULL,
	"description" text,
	"source" "connection_source" NOT NULL,
	"catalog_slug" text,
	"registry_name" text,
	"url" text NOT NULL,
	"transport" "mcp_transport" DEFAULT 'streamable-http' NOT NULL,
	"auth_type" "connection_auth_type" DEFAULT 'none' NOT NULL,
	"auth_config_encrypted" text,
	"tool_allow" jsonb,
	"tool_block" jsonb,
	"approval_policy" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"health" "connection_health" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"tools_cache" jsonb,
	"tools_cached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_scope_owner_check" CHECK (("connections"."scope" = 'workspace' AND "connections"."organization_id" IS NOT NULL AND "connections"."user_id" IS NULL)
       OR ("connections"."scope" = 'user' AND "connections"."user_id" IS NOT NULL AND "connections"."organization_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "registry_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"last_updated_since" timestamp with time zone,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_organization_id_idx" ON "connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "connections_user_id_idx" ON "connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_org_name_uq" ON "connections" USING btree ("organization_id","name") WHERE "connections"."organization_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_user_name_uq" ON "connections" USING btree ("user_id","name") WHERE "connections"."user_id" IS NOT NULL;