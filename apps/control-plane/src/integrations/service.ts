/**
 * Integrations + trigger-binding persistence (Phase 3 task 3). DB queries and
 * row→DTO mappers behind the ingress + CRUD routes:
 *
 * - trigger rows (`triggers`): one per workflow, created/updated lazily when a
 *   webhook/form token is minted or a Slack binding is set. Stores the token
 *   HASH only (never plaintext); the non-secret token suffix + Slack routing
 *   binding live on `triggers.binding` (jsonb).
 * - integration rows (`integrations`): one platform Slack app install per team,
 *   keyed by (type, external_id) with the bot token envelope-encrypted.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  formFieldSchema,
  slackTriggerBindingSchema,
  type FormField,
  type IntegrationDto,
  type SlackIntegrationMetadata,
  type SlackTriggerBinding,
  type TriggerBindingDto,
  type TriggerTypeEnum,
} from "@invisible-string/shared";

import type { Db } from "../db";

type TriggerRow = typeof schema.triggers.$inferSelect;
type IntegrationRow = typeof schema.integrations.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;

// ── DTO mappers ──────────────────────────────────────────────────────────────

function slackMetadataOf(row: IntegrationRow): SlackIntegrationMetadata {
  const meta = (row.metadata as Partial<SlackIntegrationMetadata> | null) ?? {};
  return {
    teamName: meta.teamName,
    botUserId: meta.botUserId,
    scopes: Array.isArray(meta.scopes) ? meta.scopes : [],
  };
}

export function integrationDto(row: IntegrationRow): IntegrationDto {
  const meta = slackMetadataOf(row);
  return {
    id: row.id,
    type: row.type,
    externalId: row.externalId,
    teamName: meta.teamName ?? null,
    botUserId: meta.botUserId ?? null,
    scopes: meta.scopes,
    hasCredentials: row.credentialsEncrypted.length > 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Parse the stored form-field schema (`{ fields: FormField[] }`) for a DTO. */
export function parseStoredFormSchema(
  formSchema: Record<string, unknown> | null,
): FormField[] | null {
  if (!formSchema) return null;
  const fields = (formSchema as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  const parsed: FormField[] = [];
  for (const field of fields) {
    const result = formFieldSchema.safeParse(field);
    if (result.success) parsed.push(result.data);
  }
  return parsed.length > 0 ? parsed : null;
}

function parseSlackBinding(
  type: TriggerTypeEnum,
  binding: Record<string, unknown> | null,
): SlackTriggerBinding | null {
  if (type !== "slack" || !binding) return null;
  const result = slackTriggerBindingSchema.safeParse(binding);
  return result.success ? result.data : null;
}

function tokenSuffixOf(binding: Record<string, unknown> | null): string | null {
  const suffix = (binding as { tokenSuffix?: unknown } | null)?.tokenSuffix;
  return typeof suffix === "string" && suffix.length === 4 ? suffix : null;
}

export function triggerBindingDto(row: TriggerRow): TriggerBindingDto {
  const isWebhookOrForm = row.type === "webhook" || row.type === "form";
  return {
    id: row.id,
    workflowId: row.workflowId,
    type: row.type,
    enabled: row.enabled,
    hasToken: row.tokenHash != null,
    tokenSuffix: isWebhookOrForm ? tokenSuffixOf(row.binding) : null,
    formSchema: row.type === "form" ? parseStoredFormSchema(row.formSchema) : null,
    slackBinding: parseSlackBinding(row.type, row.binding),
    integrationId: row.integrationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Trigger rows ─────────────────────────────────────────────────────────────

export async function listTriggers(
  db: Db,
  workflowId: string,
): Promise<TriggerRow[]> {
  return db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.workflowId, workflowId));
}

export async function findTrigger(
  db: Db,
  workflowId: string,
  triggerId: string,
): Promise<TriggerRow | null> {
  const rows = await db
    .select()
    .from(schema.triggers)
    .where(
      and(eq(schema.triggers.id, triggerId), eq(schema.triggers.workflowId, workflowId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a workflow + its trigger row by the presented ingress token's HASH
 * (constant-time indexed lookup — plaintext is never stored). Returns null when
 * no enabled trigger matches, hiding token existence from probes.
 */
export async function resolveTriggerByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<{ trigger: TriggerRow; workflow: WorkflowRow } | null> {
  const rows = await db
    .select({ trigger: schema.triggers, workflow: schema.workflows })
    .from(schema.triggers)
    .innerJoin(schema.workflows, eq(schema.triggers.workflowId, schema.workflows.id))
    .where(eq(schema.triggers.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

/** Get-or-create the workflow's trigger row of the given type. */
export async function upsertTriggerType(
  db: Db,
  workflowId: string,
  type: TriggerTypeEnum,
): Promise<TriggerRow> {
  const existing = await db
    .select()
    .from(schema.triggers)
    .where(eq(schema.triggers.workflowId, workflowId))
    .limit(1);
  if (existing[0]) {
    if (existing[0].type === type) return existing[0];
    const updated = await db
      .update(schema.triggers)
      .set({ type })
      .where(eq(schema.triggers.id, existing[0].id))
      .returning();
    return updated[0]!;
  }
  const inserted = await db
    .insert(schema.triggers)
    .values({ workflowId, type })
    .returning();
  return inserted[0]!;
}

/** Mint/rotate a webhook/form ingress token: store its HASH + suffix. */
export async function setTriggerToken(
  db: Db,
  triggerId: string,
  input: {
    type: TriggerTypeEnum;
    tokenHash: string;
    tokenSuffix: string;
    formSchema: FormField[] | null;
  },
): Promise<TriggerRow> {
  const updated = await db
    .update(schema.triggers)
    .set({
      type: input.type,
      tokenHash: input.tokenHash,
      enabled: true,
      binding: { tokenSuffix: input.tokenSuffix },
      formSchema: input.formSchema ? { fields: input.formSchema } : null,
      // A webhook/form trigger routes through the token, not an integration.
      integrationId: null,
    })
    .where(eq(schema.triggers.id, triggerId))
    .returning();
  return updated[0]!;
}

/** Point a Slack trigger at an installed integration + routing rules. */
export async function setSlackBinding(
  db: Db,
  triggerId: string,
  integrationId: string,
  binding: SlackTriggerBinding,
): Promise<TriggerRow> {
  const updated = await db
    .update(schema.triggers)
    .set({
      type: "slack",
      integrationId,
      binding: binding as unknown as Record<string, unknown>,
      // Slack routes through the integration, not an ingress token.
      tokenHash: null,
      enabled: true,
    })
    .where(eq(schema.triggers.id, triggerId))
    .returning();
  return updated[0]!;
}

// ── Slack event routing ──────────────────────────────────────────────────────

/** All enabled Slack triggers (+ workflows) bound to one team's integration. */
export async function listSlackTriggersForIntegration(
  db: Db,
  integrationId: string,
): Promise<{ trigger: TriggerRow; workflow: WorkflowRow }[]> {
  return db
    .select({ trigger: schema.triggers, workflow: schema.workflows })
    .from(schema.triggers)
    .innerJoin(schema.workflows, eq(schema.triggers.workflowId, schema.workflows.id))
    .where(
      and(
        eq(schema.triggers.integrationId, integrationId),
        eq(schema.triggers.type, "slack"),
        eq(schema.triggers.enabled, true),
      ),
    );
}

// ── Integration rows ─────────────────────────────────────────────────────────

export async function listIntegrations(
  db: Db,
  organizationId: string,
): Promise<IntegrationRow[]> {
  return db
    .select()
    .from(schema.integrations)
    .where(eq(schema.integrations.organizationId, organizationId));
}

export async function findIntegration(
  db: Db,
  organizationId: string,
  integrationId: string,
): Promise<IntegrationRow | null> {
  const rows = await db
    .select()
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.id, integrationId),
        eq(schema.integrations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve a Slack integration by inbound team_id (routing key). */
export async function findSlackIntegrationByTeam(
  db: Db,
  teamId: string,
): Promise<IntegrationRow | null> {
  const rows = await db
    .select()
    .from(schema.integrations)
    .where(and(eq(schema.integrations.type, "slack"), eq(schema.integrations.externalId, teamId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Upsert a Slack integration for a team (install / re-install refreshes creds). */
export async function upsertSlackIntegration(
  db: Db,
  input: {
    organizationId: string;
    teamId: string;
    credentialsEncrypted: string;
    metadata: SlackIntegrationMetadata;
  },
): Promise<IntegrationRow> {
  const rows = await db
    .insert(schema.integrations)
    .values({
      organizationId: input.organizationId,
      type: "slack",
      externalId: input.teamId,
      credentialsEncrypted: input.credentialsEncrypted,
      metadata: input.metadata as unknown as Record<string, unknown>,
    })
    .onConflictDoUpdate({
      target: [schema.integrations.type, schema.integrations.externalId],
      set: {
        organizationId: input.organizationId,
        credentialsEncrypted: input.credentialsEncrypted,
        metadata: input.metadata as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0]!;
}

export async function deleteIntegration(
  db: Db,
  integrationId: string,
): Promise<void> {
  await db.delete(schema.integrations).where(eq(schema.integrations.id, integrationId));
}
