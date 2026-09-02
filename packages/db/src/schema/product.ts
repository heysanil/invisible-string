/**
 * Product tables — agents-first data model
 * (docs/superpowers/specs/2026-07-10-agents-first-redesign.md).
 *
 * Conventions:
 * - Workspace = Better Auth organization; workspace scoping is
 *   `organization_id` FK → organization.id (text, Better Auth ids).
 * - Product rows use uuid PKs (gen_random_uuid()); connectors-redesign tables
 *   (connections, connection_oauth) use prefixed nanoids (cn_/co_,
 *   packages/shared newId).
 * - Encrypted-at-rest values (AES-256-GCM envelope, packages/… crypto module)
 *   are stored as opaque `text` columns suffixed `_encrypted`; plaintext must
 *   never be logged or put in model context.
 * - Agents are the compile unit: publishing an Agent snapshots its
 *   AgentDefinition into `agent_versions` and builds one artifact per content
 *   hash (`builds`). Workflows are standing pipelines (trigger → steps; agents
 *   participate as steps) with no builds of their own — the control plane
 *   interprets them.
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
 * Reasoning effort. Two homes, both real:
 * - `model_presets.reasoning` — the workspace default a preset carries (an
 *   effort is part of a preset's identity: `balanced` and `quick` may be the
 *   same model at different efforts).
 * - the AgentDefinition jsonb (agents.draft / agent_versions.definition), where
 *   it is the OPTIONAL per-agent override (absent = inherit the preset's).
 *
 * The vocabulary is OpenRouter's per-model `reasoning.supported_efforts` set —
 * no model supports all of it, the UI filters against the live catalog — plus
 * `provider-default`, which means "omit the reasoning field from the request
 * entirely" (distinct from `none` = explicitly disabled). `medium` is retained
 * despite no seeded model supporting it: immutable published definitions carry
 * it and must keep parsing. Keep in lockstep with packages/shared's
 * `reasoningEffortSchema`.
 */
export const reasoningEffort = pgEnum("reasoning_effort", [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
 * How a run executes (workflow-pipelines redesign): `agent` = one eve session
 * turn (chat dispatch), `pipeline` = a control-plane-interpreted step pipeline
 * with a `run_steps` ledger and no session of its own. Defaulted to `agent` so
 * rows that predate the column read correctly.
 */
export const runMode = pgEnum("run_mode", ["agent", "pipeline"]);

/**
 * Step-instance lifecycle in the `run_steps` ledger. `waiting` = parked on a
 * child run that is itself waiting (HITL input); `skipped` = a filter/branch
 * decided against executing it — a terminal non-failure the run can still
 * succeed through.
 */
export const runStepStatus = pgEnum("run_step_status", [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
]);

/**
 * Pipeline step kinds. `script` is RESERVED: the enum ships the value day one
 * because inserting mid-enum later is awkward, but the shared zod step union
 * does not accept it yet — nothing writes it until the sandboxed script step
 * lands (plan Phase 4/5).
 */
export const runStepKind = pgEnum("run_step_kind", [
  "tool",
  "infer",
  "agent",
  "for_each",
  "branch",
  "filter",
  "state",
  "script",
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

/** Where a connection came from (connectors redesign spec §2). */
export const connectionSource = pgEnum("connection_source", [
  "catalog",
  "registry",
  "custom",
]);

/** MCP remote transport, persisted at install (spec §3). */
export const mcpTransport = pgEnum("mcp_transport", ["streamable-http", "sse"]);

/** Connection auth mode. `oauth` rows pair with `connection_oauth`. */
export const connectionAuthType = pgEnum("connection_auth_type", [
  "none",
  "bearer",
  "headers",
  "oauth",
]);

/** Probe-derived health (spec §7). `unknown` until first probe. */
export const connectionHealth = pgEnum("connection_health", [
  "unknown",
  "ok",
  "unreachable",
  "auth_required",
  "auth_error",
]);

/** OAuth grant lifecycle (spec §3). */
export const connectionOauthStatus = pgEnum("connection_oauth_status", [
  "pending",
  "connected",
  "expired",
  "revoked",
  "error",
]);

/**
 * How the broker obtained the OAuth client identity it authorizes with.
 * - `cimd` — the AS advertises `client_id_metadata_document_supported`, so our
 *   hosted client-metadata URL IS the client_id; nothing is registered.
 * - `dcr` — RFC 7591 dynamic registration; the issued credentials live in
 *   `client_id` / `client_secret_encrypted` and are keyed by
 *   `client_registration_issuer` (re-register when the AS's issuer changes).
 * - `preregistered` — an OPERATOR-supplied client, deployed via config for
 *   providers that gate registration behind a redirect-URI allowlist (Vercel
 *   rejects our DCR body with `invalid_redirect_uri`; see the 2026-08-31 OAuth
 *   fix plan §3). Same two columns, no registration hop.
 */
export const connectionOauthClientMode = pgEnum(
  "connection_oauth_client_mode",
  ["cimd", "dcr", "preregistered"],
);

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
    /**
     * The preset's default reasoning effort — part of the preset's identity,
     * not decoration: `balanced` and `quick` seed to the same model and differ
     * only here. Agents inherit it unless their definition sets an override.
     * NOT NULL DEFAULT 'high' so pre-existing rows land on a value every
     * catalog model with reasoning support accepts.
     */
    reasoning: reasoningEffort("reasoning").notNull().default("high"),
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
     * Display name. NOT unique per workspace — the unique index that used to
     * enforce that was dropped (2026-08-11 lifecycle spec D1) once the
     * content hash stopped keying identity on the slugified name: two agents
     * sharing a name and a definition previously hashed identically and so
     * shared one `ag_v_<hash12>` world database, which made a cosmetic UX
     * rule silently load-bearing for single-writer isolation. `agents.id` is
     * the identity input now; new agents are still auto-numbered
     * ("Untitled agent 2") purely so lists stay readable.
     *
     * The slugified name DOES still reach the hash — it is emitted into the
     * generated package name and the model-visible identity line — so
     * renaming an agent still re-keys its world DB + JWT audience on the
     * next publish. That churn is known and out of scope (spec §7).
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
    // Plain, NOT unique (see `name` above). Kept rather than deleted because
    // it is still the only index for the two org-scoped reads this table
    // takes: listing a workspace's agents, and the (organization_id, name)
    // lookup `publishAgentByName` does for the seeded-workspace kick.
    index("agents_organization_id_name_idx").on(table.organizationId, table.name),
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
    /**
     * Slug → connection id for THIS version's context connections, written at
     * publish from the same unique-slug pass the compiler bakes into the
     * generated files — runtime consumers resolve an emitted connection slug
     * back to its `cn_` row through it. Nullable: rows published before the
     * column existed carry null (read as `?? {}`; republish backfills).
     */
    connectionSlugs: jsonb("connection_slugs").$type<Record<string, string>>(),
    buildStatus: buildStatus("build_status").default("pending").notNull(),
    createdAt,
  },
  (table) => [
    index("agent_versions_agent_id_idx").on(table.agentId),
    index("agent_versions_content_hash_idx").on(table.contentHash),
    // Publish is "idempotent by content hash" — the DB enforces it, so two
    // concurrent publishes of the same draft (e.g. the seeded-workspace kick
    // racing a user's Publish click) resolve to ONE version row instead of
    // duplicates in the version history.
    uniqueIndex("agent_versions_agent_id_content_hash_uidx").on(
      table.agentId,
      table.contentHash,
    ),
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

// ── Workflows: standing pipelines (trigger → steps) ────────────────────────

/**
 * A workflow is a pipeline the control plane interprets on each trigger event
 * (workflow-pipelines redesign; supersedes the trigger → agent → instructions
 * delegation model). Publishing validates and snapshots `draft` → `published`
 * — no compile/build of its own (agent steps use the bound agent's artifact);
 * dispatch reads only the snapshot.
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
     * Mutable draft WorkflowConfig JSON (`{version: 2, trigger, steps[], …}`;
     * step markdown carries @refs). Schema is defined in packages/shared.
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
     * DEAD (pipelines redesign): agents bind per `agent` STEP now, so a single
     * denormalized binding no longer models the workflow. Nothing writes it;
     * kept (with its RESTRICT FK, inert on always-null rows) because
     * migrations are additive. Its delete-protection role moved to the agent
     * DELETE path, which scans published configs for step references and 409s.
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
    /**
     * Generated thread title (2026-08-11 spec D9). NULL is the NORMAL state of
     * a brand-new session and the permanent state whenever titling fails: the
     * titler (resources/session-title.ts) runs fire-and-forget on the platform
     * key after the first user message and is silent on every failure. Clients
     * therefore fall back to truncating that first message, never to
     * "Untitled". Bounded by shared `SESSION_TITLE_MAX_CHARS` in the titler —
     * raw model output never reaches this column unclamped.
     */
    title: text("title"),
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
    /**
     * The eve session this run rode (mode = 'agent'). NULL for pipeline runs:
     * the control plane interprets those itself — no session exists, and any
     * eve work happens in CHILD runs spawned by `agent` steps (linked back via
     * run_steps.child_run_id). The pipelines redesign's ONE NOT NULL
     * relaxation. ⚠️ Every `runs ⋈ agent_sessions` join must therefore be
     * LEFT — an inner join silently drops pipeline runs (= cap bypass).
     */
    agentSessionId: uuid("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "cascade" },
    ),
    /**
     * Workspace scoping, denormalized at dispatch. Historically derived by
     * joining through agent_sessions; pipeline runs have no session, so the
     * row carries its own org. Nullable only because the column is additive —
     * every NEW run (both modes) sets it, and readers COALESCE through the
     * session for pre-column rows.
     */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    /**
     * Workflow provenance for pipeline runs (agent runs keep theirs on
     * agent_sessions.workflow_id). SET NULL on workflow deletion — the run
     * record outlives the workflow that spawned it.
     */
    workflowId: uuid("workflow_id").references(() => workflows.id, {
      onDelete: "set null",
    }),
    /** See runMode. Defaulted so pre-column rows read as agent runs. */
    mode: runMode("mode").default("agent").notNull(),
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
    /**
     * DURABLE remote-cancel obligation (agent runs). Set — in the SAME CAS
     * statement that settles the row `canceled` — by every Stop (the live
     * tail's own finalize, `POST /runs/:id/cancel` on a queued/waiting run,
     * the pipeline cancel sweep over child runs, the post-eve recheck), and
     * cleared ONLY on a CONFIRMED outcome: eve's OWN stream showed the run's
     * turn boundary after its own `turn.started` (`turn.cancelled` /
     * `turn.completed` / the following `session.waiting`/`session.completed`
     * — observed by the tail that stays on the stream after a Stop, or by
     * the sweeper-reopened observation tail), eve answered session-terminal
     * (`session_not_active` / `no_active_turn` / `session.failed`), a NEWER
     * run on the session carries `turn_id` (superseded — eve serializes
     * turns), or the run provably never reached eve. Eve's 202 on an
     * unqualified cancel is NOT confirmation (it is consumed as a no-op
     * before `turn.started`). NULL = nothing owed.
     */
    remoteCancelPendingAt: timestamp("remote_cancel_pending_at", {
      withTimezone: true,
    }),
    /**
     * eve's OWN acceptance proof for this run's latest send: the `turnId` of
     * the run's own `turn.started`, written by the tail the moment it
     * observes that event on eve's stream (turn attribution runs in send
     * order, so a `turn.started` drained before the run's own is a pending
     * predecessor's). NULL until then — and reset to NULL by every
     * dispatch-attempt CAS (`armDispatchAttempt`), so "marker set + turn_id
     * NULL" reads "sent, not yet started (or never)". This column is the ONLY
     * evidence that eve accepted a turn: a `running` status can be
     * synthesized by reconciliation tailing an unsent continuation, and
     * persisted `run_events` can be a predecessor's leftovers, so neither
     * proves anything — a settled run's remote-cancel obligation is
     * "superseded" only by a NEWER run whose `turn_id` is set.
     */
    turnId: text("turn_id"),
    /**
     * The remote-cancel obligation's HONEST residual: set (with the pending
     * marker left in place) when `REMOTE_CANCEL_OBSERVE_MS` elapsed after
     * `remote_cancel_pending_at` without eve's own stream confirming the
     * settled turn ended — no `turn.cancelled`/`turn.completed`/session
     * boundary observed for it, no session-terminal answer, no proven
     * successor. The sweeper stops re-opening observation for such a run
     * (logged at warn); a late confirmation still clears BOTH columns.
     * Never a silent clear. NULL = not (yet) unresolved.
     */
    remoteCancelUnresolvedAt: timestamp("remote_cancel_unresolved_at", {
      withTimezone: true,
    }),
    error: text("error"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("runs_agent_session_id_idx").on(table.agentSessionId),
    // Boot sweep over runs still owing a remote cancel — partial, so it
    // stays the size of the (normally empty) pending set.
    index("runs_remote_cancel_pending_idx")
      .on(table.remoteCancelPendingAt)
      .where(sql`${table.remoteCancelPendingAt} IS NOT NULL`),
    // Successor proof + turn attribution scan a session's runs by turn_id.
    index("runs_agent_session_turn_idx").on(table.agentSessionId, table.turnId),
    // Workspace cap + list scans for pipeline runs, which have no session row
    // to reach organization scope through.
    index("runs_organization_id_idx").on(table.organizationId),
    // Workflow runs listing (GET …/workflows/:id/runs) and the SET NULL sweep
    // on workflow deletion.
    index("runs_workflow_id_idx").on(table.workflowId),
  ],
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

// ── Pipelines: step ledger + durable workflow state ─────────────────────────

/**
 * Pipeline execution ledger — one row per step INSTANCE of a pipeline run (a
 * step inside `for_each` yields one row per item). The unique (run_id, path)
 * pair is the idempotent claim key crash recovery replays against: the driver
 * claims an instance before executing, so a rebooted run resumes at the
 * frontier instead of re-running finished steps. Terminal `output` snapshots
 * are what scope rebuilding reads after a crash — which is why output is
 * persisted (capped app-side) rather than recomputed. `agent` steps link the
 * child run they spawned via child_run_id; the child rides the ordinary run
 * machinery (tailer/SSE/reconcile) unchanged.
 */
export const runSteps = pgTable(
  "run_steps",
  {
    /** `rs_<nanoid>`, generated app-side (packages/shared newId). */
    id: text("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Denormalized workspace scope, copied from the parent run at claim. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The config step's stable `st_` id — survives slug renames. */
    stepId: text("step_id").notNull(),
    /** The step's slug as executed (renameable in config; snapshotted here). */
    stepSlug: text("step_slug").notNull(),
    /** Instance path, e.g. `st_loop/3/st_b` — one config step, many instances. */
    path: text("path").notNull(),
    /** Enclosing instance path (loop/branch bodies); null at top level. */
    parentPath: text("parent_path"),
    /** `for_each` item index for this instance; null outside loops. */
    iteration: integer("iteration"),
    kind: runStepKind("kind").notNull(),
    status: runStepStatus("status").default("pending").notNull(),
    /** 1-based; bumped per retry (visible in the run timeline). */
    attempt: integer("attempt").default(1).notNull(),
    /**
     * Rendered input snapshot (refs resolved). The template resolver's scope
     * is only {trigger, steps, state, item, now} — credentials are
     * structurally unreachable, so this snapshot cannot contain secrets.
     */
    input: jsonb("input").$type<unknown>(),
    /** Terminal output (capped app-side) — recovery's scope source of truth. */
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    /**
     * Stable machine classification (`tool_error`, `unreachable`,
     * `validation_failed`, …). Open vocabulary — text, not an enum: executors
     * mint classes and retry policy keys on them.
     */
    errorClass: text("error_class"),
    childRunId: uuid("child_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    // The recovery claim key. Its leading column doubles as the run_id read
    // index for ledger scans — no separate runs index needed.
    uniqueIndex("run_steps_run_id_path_uidx").on(table.runId, table.path),
  ],
);

/**
 * Durable per-workflow key-value state — the substrate for cursors and dedupe
 * ("everything since @state.cursor"). `state` steps write it at run
 * completion boundaries (last write wins via the PK); reads are `@state.*`
 * refs resolved into the run's scope snapshot. Caps are app-enforced (≤200
 * keys/workflow, ≤64KB/value) — the DB stores whatever fits in jsonb.
 * Operator cursor surgery rides GET/DELETE …/workflows/:id/state[/key].
 */
export const workflowState = pgTable(
  "workflow_state",
  {
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    /** Provenance: the run whose state write last touched this key. */
    updatedByRunId: uuid("updated_by_run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    /** Denormalized workspace scope. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt,
    updatedAt,
  },
  (table) => [primaryKey({ columns: [table.workflowId, table.key] })],
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

// ── Connections: the rebuilt MCP connection domain (connectors redesign) ────

/**
 * Connections — the rebuilt MCP connection domain (spec §3). Replaces
 * `mcp_connections`, which is DEAD (kept only because migrations are
 * additive; see AGENTS.md known residuals). Ids are `cn_<nanoid16>`,
 * generated app-side (the auth envelope AAD binds the id pre-insert).
 */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    scope: resourceScope("scope").notNull(),
    organizationId: text("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    source: connectionSource("source").notNull(),
    catalogSlug: text("catalog_slug"),
    registryName: text("registry_name"),
    url: text("url").notNull(),
    transport: mcpTransport("transport").notNull().default("streamable-http"),
    authType: connectionAuthType("auth_type").notNull().default("none"),
    authConfigEncrypted: text("auth_config_encrypted"),
    toolAllow: jsonb("tool_allow").$type<string[]>(),
    toolBlock: jsonb("tool_block").$type<string[]>(),
    approvalPolicy: jsonb("approval_policy"),
    enabled: boolean("enabled").notNull().default(true),
    health: connectionHealth("health").notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    toolsCache: jsonb("tools_cache").$type<
      Array<{ name: string; description: string; params: string[] }>
    >(),
    toolsCachedAt: timestamp("tools_cached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("connections_organization_id_idx").on(t.organizationId),
    index("connections_user_id_idx").on(t.userId),
    uniqueIndex("connections_org_name_uq")
      .on(t.organizationId, t.name)
      .where(sql`${t.organizationId} IS NOT NULL`),
    uniqueIndex("connections_user_name_uq")
      .on(t.userId, t.name)
      .where(sql`${t.userId} IS NOT NULL`),
    check(
      "connections_scope_owner_check",
      sql`(${t.scope} = 'workspace' AND ${t.organizationId} IS NOT NULL AND ${t.userId} IS NULL)
       OR (${t.scope} = 'user' AND ${t.userId} IS NOT NULL AND ${t.organizationId} IS NULL)`,
    ),
  ],
);

/**
 * An armed consent flow's STAGED server-derived state: everything one
 * `startOauth` learned from the MCP server's discovery chain, held apart from
 * the live grant until a token exchange SUCCEEDS (2026-08-31 OAuth fix plan,
 * adversarial review). Discovery is chosen by the MCP server — it names its
 * own authorization server — so writing it straight onto the row let a
 * re-consent that NEVER COMPLETED leave a still-`connected` grant pointing at
 * endpoints the server had just nominated, and the next central refresh then
 * POSTed the previous AS's refresh token (and client secret) there. The grant
 * columns are promoted from here, once, beside the tokens they minted.
 *
 * `clientSecretEncrypted` is the same AES-256-GCM envelope the live column
 * holds — AAD-bound to this row (`connection_oauth:client_secret:<id>`), so
 * promotion is a verbatim copy and no plaintext ever exists here.
 */
export interface PendingOauthFlow {
  authorizationServer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  revocationEndpoint: string | null;
  /** Scopes to REQUEST (discovery rule 2), not the AS-wide advertisement. */
  scopes: string[] | null;
  clientIdentityMode: "cimd" | "dcr" | "preregistered";
  /** NULL under CIMD, where the client id IS our hosted metadata URL. */
  clientId: string | null;
  clientSecretEncrypted: string | null;
  clientRegistrationIssuer: string | null;
}

/** 1:1 OAuth grant state for `auth_type = 'oauth'` connections (spec §3/§6). */
export const connectionOauth = pgTable("connection_oauth", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .unique()
    .references(() => connections.id, { onDelete: "cascade" }),
  /**
   * The discovered OAuth surface of the grant that is actually LIVE. Written
   * only by a successful token exchange (promoted out of `pending_flow`), for
   * the reason that column documents: `token_endpoint` and
   * `revocation_endpoint` are where the central refresh and RFC 7009
   * revocation replay a still-valid refresh token months later, and an
   * abandoned re-consent must not be able to choose their destination.
   */
  authorizationServer: text("authorization_server"),
  authorizationEndpoint: text("authorization_endpoint"),
  tokenEndpoint: text("token_endpoint"),
  /** Canonical RFC 8707 resource id from PRM discovery — sent on EVERY token
   * request (exchange + refresh), not assumed equal to the connection URL. */
  resource: text("resource"),
  /** RFC 7009 endpoint when the AS advertises one (best-effort revocation). */
  revocationEndpoint: text("revocation_endpoint"),
  scopes: jsonb("scopes").$type<string[]>(),
  /**
   * The armed flow's staged discovery + client identity ({@link
   * PendingOauthFlow}), cleared when the single-use `pending_state` is
   * claimed. NULL on a row with no flow in flight, and on rows armed before
   * this column existed — those exchange against the live columns, which is
   * why every read of it falls back rather than requiring it.
   */
  pendingFlow: jsonb("pending_flow").$type<PendingOauthFlow | null>(),
  /**
   * Which identity mode minted the credentials below. `preregistered` clients
   * reuse `client_id`/`client_secret_encrypted` — there is exactly one home
   * per credential — and skip registration entirely. NULL on rows armed before
   * this column existed; the broker re-derives the mode on the next start.
   *
   * These three client columns are promoted out of `pending_flow` by a
   * successful exchange, exactly like the endpoints above: a registration
   * minted at an authorization server a connection never actually authorized
   * against must not replace the one the live tokens were issued to.
   */
  clientIdentityMode: connectionOauthClientMode("client_identity_mode"),
  clientId: text("client_id"),
  clientSecretEncrypted: text("client_secret_encrypted"),
  /**
   * The AS `issuer` that issued the DCR credentials above. A stored client is
   * only valid at the AS that minted it, so a migrated/changed issuer must
   * force re-registration rather than replaying a foreign client_id.
   */
  clientRegistrationIssuer: text("client_registration_issuer"),
  accessTokenEncrypted: text("access_token_encrypted"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  status: connectionOauthStatus("status").notNull().default("pending"),
  pendingState: text("pending_state"),
  pendingCodeVerifierEncrypted: text("pending_code_verifier_encrypted"),
  pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
  /**
   * The user who ARMED the pending flow. State alone binds a callback to the
   * connection, not to a person — without this any workspace admin could
   * complete somebody else's consent. SET NULL on user delete: an orphaned
   * pending flow simply cannot be completed, which is the safe outcome.
   */
  pendingStartedBy: text("pending_started_by").references(() => user.id, {
    onDelete: "set null",
  }),
  /**
   * The `issuer` discovery resolved for the armed flow, checked against the
   * callback's `iss` before the code is exchanged (AS mix-up defence).
   */
  expectedIssuer: text("expected_issuer"),
  /**
   * Whether that AS advertises `authorization_response_iss_parameter_supported`
   * — captured with the pending flow, because a MISSING `iss` is only an error
   * when the AS promised to send one. NULL = unknown (pre-column rows).
   */
  issParameterSupported: boolean("iss_parameter_supported"),
  /**
   * Sanitized typed OAuth failure code (e.g. `oauth_registration_failed`), for
   * the connection detail surface. A CODE, never a provider message: no
   * OAuth value may reach a DTO.
   */
  lastErrorCode: text("last_error_code"),
  connectedBy: text("connected_by").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Registry→Meilisearch ETL cursor (spec §5). Single row, id = 'official'. */
export const registrySyncState = pgTable("registry_sync_state", {
  id: text("id").primaryKey(),
  lastUpdatedSince: timestamp("last_updated_since", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});
