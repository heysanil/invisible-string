/**
 * Product tables — agents-first data model
 * (docs/superpowers/specs/2026-07-10-agents-first-redesign.md).
 *
 * Conventions:
 * - Workspace = Better Auth organization; workspace scoping is
 *   `organization_id` FK → organization.id (text, Better Auth ids).
 * - Product rows use uuid PKs (gen_random_uuid()).
 * - Encrypted-at-rest values (AES-256-GCM envelope, packages/… crypto module)
 *   are stored as opaque `text` columns suffixed `_encrypted`; plaintext must
 *   never be logged or put in model context.
 * - Agents are the compile unit: publishing an Agent snapshots its
 *   AgentDefinition into `agent_versions` and builds one artifact per content
 *   hash (`builds`). Workflows are standing delegations (trigger → agent →
 *   instructions) with no builds of their own.
 * - `agent_sessions` are chat/eve sessions — distinct from Better Auth's
 *   `session` (login) table.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { organization, user } from "./auth";

// ── Enums ───────────────────────────────────────────────────────────────────

/** Scope of user-configurable context resources (MCP connections, skills). */
export const resourceScope = pgEnum("resource_scope", ["workspace", "user"]);

/** Where an MCP connection came from. */
export const mcpSource = pgEnum("mcp_source", ["registry", "custom"]);

/** Model providers supported from day one (spec §2/§7). */
export const modelProvider = pgEnum("model_provider", [
  "anthropic",
  "openrouter",
]);

/** The three workspace model presets (spec §7). */
export const modelPresetSlug = pgEnum("model_preset_slug", [
  "powerful",
  "balanced",
  "quick",
]);

/**
 * eve reasoning effort for an agent's model config. The value itself lives in
 * the AgentDefinition jsonb (agents.draft / agent_versions.definition); the
 * enum stays defined for the db↔shared lockstep (`reasoningEffortSchema`).
 */
export const reasoningEffort = pgEnum("reasoning_effort", [
  "low",
  "medium",
  "high",
]);

/** Build lifecycle for agent versions and the build cache. */
export const buildStatus = pgEnum("build_status", [
  "pending",
  "building",
  "succeeded",
  "failed",
]);

/** Trigger types (TriggerEvent.triggerType; spec §8). */
export const triggerType = pgEnum("trigger_type", [
  "manual",
  "form",
  "webhook",
  "slack",
  "schedule",
]);

/** How an agent session was started (spec §9 agent_sessions.origin). */
export const sessionOrigin = pgEnum("session_origin", [
  "chat",
  "slack",
  "webhook",
  "form",
  "schedule",
]);

/** Agent (chat/eve) session lifecycle. `waiting` = parked on HITL input. */
export const agentSessionStatus = pgEnum("agent_session_status", [
  "active",
  "waiting",
  "closed",
  "error",
]);

/** Run lifecycle. `waiting` = parked on approval/input (input.requested). */
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
]);

/**
 * Outbound delivery of a run's final reply to its trigger surface (Slack
 * today). Null on runs = no delivery owed.
 */
export const deliveryStatus = pgEnum("delivery_status", [
  "pending",
  "delivered",
  "failed",
]);

/** Worker registry status (spec §9 workers). */
export const workerStatus = pgEnum("worker_status", [
  "live",
  "draining",
  "dead",
]);

// ── Timestamp helpers ────────────────────────────────────────────────────────

const createdAt = timestamp("created_at", { withTimezone: true })
  .defaultNow()
  .notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .defaultNow()
  .$onUpdate(() => new Date())
  .notNull();

// ── Context resources: MCP connections + skills ────────────────────────────

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: resourceScope("scope").notNull(),
    /** Set when scope = workspace. */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    /** Set when scope = user. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Model-facing summary of what the server offers. Compiled into the
     * generated connection + instructions appendix — eve's connection_search
     * routes on it, so registry installs / custom forms (Phase 2) should
     * populate it. The compiler falls back to a name-derived placeholder
     * when absent.
     */
    description: text("description"),
    source: mcpSource("source").notNull(),
    /** registry.modelcontextprotocol.io server id (source = registry). */
    registryId: text("registry_id"),
    /** Resolved MCP server URL (registry remotes[].url, or custom URL). */
    url: text("url"),
    /** AES-256-GCM envelope-encrypted auth config JSON (headers/tokens). */
    authConfigEncrypted: text("auth_config_encrypted"),
    /** Tool allowlist (string[]); null = all tools. */
    toolAllow: jsonb("tool_allow").$type<string[] | null>(),
    /** Tool blocklist (string[]). */
    toolBlock: jsonb("tool_block").$type<string[] | null>(),
    /**
     * Approval policy compiled into eve's tool-approval/HITL config, e.g.
     * `{ "default": "never", "tools": { "delete_page": "always" } }`.
     */
    approvalPolicy: jsonb("approval_policy").$type<Record<
      string,
      unknown
    > | null>(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("mcp_connections_organization_id_idx").on(table.organizationId),
    index("mcp_connections_user_id_idx").on(table.userId),
    // Scope/owner consistency: exactly the owner column matching `scope` is
    // set — no orphaned or cross-scope-ambiguous rows are representable.
    check(
      "mcp_connections_scope_owner_check",
      sql`(${table.scope} = 'workspace' AND ${table.organizationId} IS NOT NULL AND ${table.userId} IS NULL) OR (${table.scope} = 'user' AND ${table.userId} IS NOT NULL AND ${table.organizationId} IS NULL)`,
    ),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: resourceScope("scope").notNull(),
    /** Set when scope = workspace. */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    /** Set when scope = user. */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Markdown skill body (SKILL.md content). */
    content: text("content").notNull(),
    /** Optional attached files: [{ name, key, mediaType }] (object-store keys). */
    files: jsonb("files").$type<
      { name: string; key: string; mediaType: string }[] | null
    >(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("skills_organization_id_idx").on(table.organizationId),
    index("skills_user_id_idx").on(table.userId),
    // Same scope/owner consistency guarantee as mcp_connections.
    check(
      "skills_scope_owner_check",
      sql`(${table.scope} = 'workspace' AND ${table.organizationId} IS NOT NULL AND ${table.userId} IS NULL) OR (${table.scope} = 'user' AND ${table.userId} IS NOT NULL AND ${table.organizationId} IS NULL)`,
    ),
  ],
);

// ── Model layer: presets + allowlist ────────────────────────────────────────

export const modelPresets = pgTable(
  "model_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    slug: modelPresetSlug("slug").notNull(),
    provider: modelProvider("provider").notNull(),
    modelId: text("model_id").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("model_presets_organization_id_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
  ],
);

export const modelAllowlist = pgTable(
  "model_allowlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: modelProvider("provider").notNull(),
    modelId: text("model_id").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("model_allowlist_org_provider_model_uidx").on(
      table.organizationId,
      table.provider,
      table.modelId,
    ),
  ],
);

// ── Agents: the entity, its compiled versions, and the build cache ─────────

/**
 * An Agent — persona + model + equipped context (MCP connections, skills).
 * Chat targets agents directly; workflows delegate to them. `draft` is the
 * mutable AgentDefinition; publishing snapshots it into `agent_versions`.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Unique per workspace. The slugified name feeds the content hash —
     * renaming an agent re-keys its world DB + JWT audience on next publish.
     */
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Credentials owner (moved from workflows): user-scoped MCP connections
     * resolve against this user on every dispatch path. Must remain a
     * workspace member — the compiler rejects otherwise. Default: creator.
     */
    runAsUserId: text("run_as_user_id")
      .notNull()
      .references(() => user.id),
    /**
     * Mutable draft AgentDefinition JSON (persona markdown, model config,
     * context refs). Schema is defined in packages/shared.
     */
    draft: jsonb("draft")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    publishedVersionId: uuid("published_version_id").references(
      (): AnyPgColumn => agentVersions.id,
    ),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("agents_organization_id_name_uidx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

/** Immutable AgentDefinition snapshots — one per publish; the compile unit. */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Immutable AgentDefinition snapshot. */
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    /** Hash of definition + resolved deps + compiler/eve versions + build env. */
    contentHash: text("content_hash").notNull(),
    compilerVersion: text("compiler_version").notNull(),
    eveVersion: text("eve_version").notNull(),
    /**
     * Provider+model RESOLVED at publish (preset→model + allowlist check) and
     * compiled into the version's agent.ts. Dispatch reads these to inject
     * exactly ONE provider key matching what was compiled — re-resolving at
     * session time could disagree with the baked model if workspace presets
     * changed after publish.
     */
    modelProvider: modelProvider("model_provider").notNull(),
    modelId: text("model_id").notNull(),
    buildStatus: buildStatus("build_status").default("pending").notNull(),
    createdAt,
  },
  (table) => [
    index("agent_versions_agent_id_idx").on(table.agentId),
    index("agent_versions_content_hash_idx").on(table.contentHash),
  ],
);

/** Build cache: one row per content hash (identical definitions reuse the build). */
export const builds = pgTable("builds", {
  /** = agent_versions.content_hash. */
  hash: text("hash").primaryKey(),
  status: buildStatus("status").default("pending").notNull(),
  /** Object-store key of the built .output tarball. */
  artifactKey: text("artifact_key"),
  errorLog: text("error_log"),
  createdAt,
  updatedAt,
});

// ── Workflows: standing delegations (trigger → agent → instructions) ───────

/**
 * A workflow delegates trigger events to an agent with rendered instructions.
 * Publishing validates and snapshots `draft` → `published` — no compile/build
 * of its own (the agent's artifact does the work); dispatch reads only the
 * snapshot.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Mutable draft WorkflowConfig JSON (trigger config, agent ref,
     * instructions markdown with @refs). Schema is defined in packages/shared.
     */
    draft: jsonb("draft")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    /**
     * Immutable WorkflowConfig snapshot taken at publish; dispatch reads THIS,
     * never the draft. Null until first publish.
     */
    published: jsonb("published").$type<Record<string, unknown> | null>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Kill switch: disabled workflows accept no trigger events. */
    enabled: boolean("enabled").default(true).notNull(),
    /**
     * Denormalized from published.agentId so agent deletion is blocked
     * (RESTRICT) while a published workflow still delegates to it. The binding
     * floats: dispatch resolves the agent's CURRENT published version;
     * sessions/runs pin the exact agent_version used.
     */
    publishedAgentId: uuid("published_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("workflows_organization_id_idx").on(table.organizationId),
    index("workflows_published_agent_id_idx").on(table.publishedAgentId),
  ],
);

// ── Runtime: workers, agent sessions, runs, run events ─────────────────────

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Base URL the control plane dispatches to (e.g. http://worker-1:8080). */
    address: text("address").notNull(),
    status: workerStatus("status").default("live").notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** { maxAgents, runningAgents, activeSessions, … } from heartbeats. */
    capacity: jsonb("capacity")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    // Scheduler liveness query: live workers with a fresh heartbeat.
    index("workers_status_last_heartbeat_idx").on(
      table.status,
      table.lastHeartbeatAt,
    ),
  ],
);

/**
 * Chat/eve sessions — one row per chat thread, mapping 1:1 to a durable eve
 * session. NOT Better Auth login sessions (those are in `session`).
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Ownership: sessions are workspace-scoped (checked on every access). */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Pinned at creation; republishing the agent affects new sessions only. */
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id),
    /**
     * Workflow provenance: set when a workflow dispatch created the session,
     * null for direct chat. SET NULL on workflow deletion — the conversation
     * outlives the delegation that spawned it.
     */
    workflowId: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "set null",
    }),
    eveSessionId: text("eve_session_id"),
    continuationToken: text("continuation_token"),
    origin: sessionOrigin("origin").notNull(),
    /** TriggerEvent.principal: { workspaceId, userId?, source }. */
    principal: jsonb("principal").$type<Record<string, unknown>>().notNull(),
    /**
     * Slack thread ↔ session mapping key (`<integrationId>:<channel>:<threadTs>`,
     * see runtime/dispatch.ts slackThreadKey). A REAL column (not jsonb) so the
     * partial unique index below makes "one session per Slack thread" a DB
     * invariant — two racing first-messages cannot mint two sessions — and
     * thread-reply routing is an indexed lookup instead of a scan.
     */
    slackThreadKey: text("slack_thread_key"),
    /** Sticky while the session's sandbox is live on a worker. */
    affinityWorkerId: uuid("affinity_worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    status: agentSessionStatus("status").default("active").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("agent_sessions_agent_id_idx").on(table.agentId),
    index("agent_sessions_organization_id_idx").on(table.organizationId),
    index("agent_sessions_affinity_worker_id_idx").on(table.affinityWorkerId),
    // Dispatch hot path (spec §8 step 3): conversational triggers resolve
    // continuationToken -> agent_session; partial to skip token-less rows.
    index("agent_sessions_continuation_token_idx")
      .on(table.continuationToken)
      .where(sql`${table.continuationToken} IS NOT NULL`),
    index("agent_sessions_eve_session_id_idx")
      .on(table.eveSessionId)
      .where(sql`${table.eveSessionId} IS NOT NULL`),
    // One agent_session per Slack thread per workflow — enforced by the DB so
    // two concurrent first-messages in a new thread cannot mint two sessions.
    uniqueIndex("agent_sessions_workflow_slack_thread_key_uidx")
      .on(table.workflowId, table.slackThreadKey)
      .where(sql`${table.slackThreadKey} IS NOT NULL`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentSessionId: uuid("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    /**
     * Storage-only provenance: the normalized TriggerEvent envelope that
     * started this run (spec §8). Never sent to agents — dispatch renders it
     * into `task_message` instead.
     */
    triggerEvent: jsonb("trigger_event")
      .$type<Record<string, unknown>>()
      .notNull(),
    /**
     * Rendered instructions sent as the eve session message (resolved
     * @trigger values baked in) for workflow-dispatched runs; null for chat.
     */
    taskMessage: text("task_message"),
    eveRunId: text("eve_run_id"),
    status: runStatus("status").default("queued").notNull(),
    /**
     * Outbound reply delivery for trigger surfaces that expect one (Slack
     * today): `pending` at dispatch, then delivered/failed by the control
     * plane's DeliveryService. Null = no delivery owed.
     */
    deliveryStatus: deliveryStatus("delivery_status"),
    deliveryError: text("delivery_error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    createdAt,
    updatedAt,
  },
  (table) => [index("runs_agent_session_id_idx").on(table.agentSessionId)],
);

/**
 * Append-only event log normalized from the eve NDJSON stream. Powers live
 * SSE (Last-Event-ID resume via seq) and replay.
 */
export const runEvents = pgTable(
  "run_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.runId, table.seq] })],
);

// ── Trigger ingress: integrations + trigger bindings ────────────────────────

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Integration type, e.g. "slack". */
    type: text("type").notNull(),
    /** Inbound routing key, e.g. Slack team_id. */
    externalId: text("external_id").notNull(),
    /** AES-256-GCM envelope-encrypted credentials JSON (OAuth tokens…). */
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("integrations_type_external_id_uidx").on(
      table.type,
      table.externalId,
    ),
    index("integrations_organization_id_idx").on(table.organizationId),
  ],
);

export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    type: triggerType("type").notNull(),
    /**
     * SHA-256 hash of the webhook/form ingress token (`POST /t/:token`).
     * Plaintext tokens are shown once and never stored; rotation = new hash.
     */
    tokenHash: text("token_hash").unique(),
    /** Form trigger field schema (rendered UI + TriggerEvent.data shape). */
    formSchema: jsonb("form_schema").$type<Record<string, unknown> | null>(),
    /** App integration this trigger routes through (e.g. Slack workspace). */
    integrationId: uuid("integration_id").references(() => integrations.id, {
      onDelete: "cascade",
    }),
    /** Integration-specific binding (e.g. { channelId, mentionOnly: true }). */
    binding: jsonb("binding").$type<Record<string, unknown> | null>(),
    /** 5-field UTC cron expression (type = schedule); synced at workflow publish. */
    cron: text("cron"),
    /**
     * Next due fire time — the schedule ticker's cursor. Advanced BEFORE
     * dispatch (no backfill); cleared when the workflow unpublishes/disables.
     */
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("triggers_workflow_id_idx").on(table.workflowId),
    index("triggers_integration_id_idx").on(table.integrationId),
    // Schedule-ticker hot path: due, enabled schedule triggers only.
    index("triggers_next_fire_at_idx")
      .on(table.nextFireAt)
      .where(sql`${table.type} = 'schedule' AND ${table.enabled} = true`),
  ],
);
