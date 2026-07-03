/**
 * Product tables — INITIAL-SPEC.md §9 / docs/PLAN.md "Data model".
 *
 * Conventions:
 * - Workspace = Better Auth organization; workspace scoping is
 *   `organization_id` FK → organization.id (text, Better Auth ids).
 * - Product rows use uuid PKs (gen_random_uuid()).
 * - Encrypted-at-rest values (AES-256-GCM envelope, packages/… crypto module)
 *   are stored as opaque `text` columns suffixed `_encrypted`; plaintext must
 *   never be logged or put in model context.
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

/** eve reasoning effort for agent presets. */
export const reasoningEffort = pgEnum("reasoning_effort", [
  "low",
  "medium",
  "high",
]);

/** Build lifecycle for workflow versions and the build cache. */
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

// ── Context pillar: MCP connections + skills ───────────────────────────────

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

// ── Agent pillar: agent presets ─────────────────────────────────────────────

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Base system-prompt / persona block prepended to instructions.md. */
    basePrompt: text("base_prompt").notNull(),
    reasoningEffort: reasoningEffort("reasoning_effort")
      .default("medium")
      .notNull(),
    /** Workspace model preset this agent resolves through (default balanced). */
    modelPreset: modelPresetSlug("model_preset").default("balanced").notNull(),
    /** Optional specific-model override (must be allowlisted at compile). */
    modelId: text("model_id"),
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

// ── Workflows: drafts, versions, builds ─────────────────────────────────────

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Credentials owner: user-scoped MCP connections resolve against this
     * user for ALL trigger types (spec §2). Must remain a workspace member —
     * the compiler rejects otherwise. Default: creator.
     */
    runAsUserId: text("run_as_user_id")
      .notNull()
      .references(() => user.id),
    /**
     * Mutable draft pillar config (WorkflowDefinition JSON: trigger config,
     * context refs, agent ref, instructions markdown with @refs). Schema is
     * defined in packages/shared.
     */
    draft: jsonb("draft")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    publishedVersionId: uuid("published_version_id").references(
      (): AnyPgColumn => workflowVersions.id,
    ),
    createdAt,
    updatedAt,
  },
  (table) => [index("workflows_organization_id_idx").on(table.organizationId)],
);

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** Immutable pillar-config snapshot. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    /** Hash of config + compiler/template version + pinned eve version. */
    contentHash: text("content_hash").notNull(),
    compilerVersion: text("compiler_version").notNull(),
    eveVersion: text("eve_version").notNull(),
    /**
     * Provider+model RESOLVED at publish (preset→model + allowlist check) and
     * compiled into the version's agent.ts. Dispatch reads these to inject
     * exactly ONE provider key matching what was compiled — re-resolving at
     * session time could disagree with the baked model if workspace presets
     * changed after publish. Nullable only for pre-Phase-1 rows.
     */
    modelProvider: modelProvider("model_provider"),
    modelId: text("model_id"),
    buildStatus: buildStatus("build_status").default("pending").notNull(),
    createdAt,
  },
  (table) => [
    index("workflow_versions_workflow_id_idx").on(table.workflowId),
    index("workflow_versions_content_hash_idx").on(table.contentHash),
  ],
);

/** Build cache: one row per content hash (identical config reuses the build). */
export const workflowBuilds = pgTable("workflow_builds", {
  /** = workflow_versions.content_hash. */
  hash: text("hash").primaryKey(),
  status: buildStatus("status").default("pending").notNull(),
  /** Object-store key of the built .output tarball. */
  artifactKey: text("artifact_key"),
  errorLog: text("error_log"),
  createdAt,
  updatedAt,
});

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
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** Pinned at creation; publishing a new version affects new sessions only. */
    workflowVersionId: uuid("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id),
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
    index("agent_sessions_workflow_id_idx").on(table.workflowId),
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
    /** The normalized TriggerEvent envelope that started this run (spec §8). */
    triggerEvent: jsonb("trigger_event")
      .$type<Record<string, unknown>>()
      .notNull(),
    eveRunId: text("eve_run_id"),
    status: runStatus("status").default("queued").notNull(),
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

// ── Trigger pillar: integrations + trigger bindings ─────────────────────────

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
    enabled: boolean("enabled").default(true).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("triggers_workflow_id_idx").on(table.workflowId),
    index("triggers_integration_id_idx").on(table.integrationId),
  ],
);
