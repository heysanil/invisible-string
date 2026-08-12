DROP INDEX "agents_organization_id_name_uidx";--> statement-breakpoint
CREATE INDEX "agents_organization_id_name_idx" ON "agents" USING btree ("organization_id","name");