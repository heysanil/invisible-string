/**
 * Pure schema-shape unit tests — no database required.
 * Verifies the contract points of the agents-first data model
 * (docs/superpowers/specs/2026-07-10-agents-first-redesign.md) and the
 * Better Auth column expectations (CLI-generated names).
 */
import { describe, expect, test } from "bun:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema";

function config(table: PgTable) {
  return getTableConfig(table);
}

function columnNames(table: PgTable): string[] {
  return config(table).columns.map((c) => c.name);
}

describe("Better Auth tables", () => {
  test("core + organization plugin tables exist with expected names", () => {
    expect(config(schema.user).name).toBe("user");
    expect(config(schema.session).name).toBe("session");
    expect(config(schema.account).name).toBe("account");
    expect(config(schema.verification).name).toBe("verification");
    expect(config(schema.organization).name).toBe("organization");
    expect(config(schema.member).name).toBe("member");
    expect(config(schema.invitation).name).toBe("invitation");
    expect(config(schema.ssoProvider).name).toBe("sso_provider");
  });

  test("user has the better-auth core columns", () => {
    expect(columnNames(schema.user)).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "email",
        "email_verified",
        "image",
        "created_at",
        "updated_at",
      ]),
    );
  });

  test("session carries the org plugin's activeOrganizationId", () => {
    expect(columnNames(schema.session)).toContain("active_organization_id");
    expect(schema.session.activeOrganizationId.name).toBe(
      "active_organization_id",
    );
  });

  test("account has credential + oauth columns", () => {
    expect(columnNames(schema.account)).toEqual(
      expect.arrayContaining([
        "account_id",
        "provider_id",
        "user_id",
        "access_token",
        "refresh_token",
        "id_token",
        "password",
      ]),
    );
  });

  test("member roles default to member", () => {
    expect(schema.member.role.default).toBe("member");
  });
});

describe("product enums", () => {
  test("model presets are exactly powerful/balanced/quick", () => {
    expect(schema.modelPresetSlug.enumValues).toEqual([
      "powerful",
      "balanced",
      "quick",
    ]);
  });

  test("providers are anthropic + openrouter", () => {
    expect(schema.modelProvider.enumValues).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });

  test("reasoning efforts are the 8-value vocabulary (shared lockstep)", () => {
    expect(schema.reasoningEffort.enumValues).toEqual([
      "provider-default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("worker status is live/draining/dead", () => {
    expect(schema.workerStatus.enumValues).toEqual([
      "live",
      "draining",
      "dead",
    ]);
  });

  test("session origin covers all trigger surfaces", () => {
    expect(schema.sessionOrigin.enumValues).toEqual([
      "chat",
      "slack",
      "webhook",
      "form",
      "schedule",
    ]);
  });

  test("resource scope is workspace/user", () => {
    expect(schema.resourceScope.enumValues).toEqual(["workspace", "user"]);
  });

  test("delivery status is pending/delivered/failed", () => {
    expect(schema.deliveryStatus.enumValues).toEqual([
      "pending",
      "delivered",
      "failed",
    ]);
  });

  test("oauth client identity modes are cimd/dcr/preregistered", () => {
    expect(schema.connectionOauthClientMode.enumValues).toEqual([
      "cimd",
      "dcr",
      "preregistered",
    ]);
  });

  test("run mode is agent/pipeline", () => {
    expect(schema.runMode.enumValues).toEqual(["agent", "pipeline"]);
  });

  test("run step status covers the full instance lifecycle", () => {
    expect(schema.runStepStatus.enumValues).toEqual([
      "pending",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "skipped",
      "canceled",
    ]);
  });

  test("run step kinds include the reserved 'script' slot", () => {
    // `script` ships in the enum day one (inserting mid-enum later is
    // awkward) but the shared step union does not accept it yet.
    expect(schema.runStepKind.enumValues).toEqual([
      "tool",
      "infer",
      "agent",
      "for_each",
      "branch",
      "filter",
      "state",
      "script",
    ]);
  });
});

describe("run_events", () => {
  test("has a composite (run_id, seq) primary key", () => {
    const { primaryKeys, columns } = config(schema.runEvents);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
      "run_id",
      "seq",
    ]);
    // No standalone serial id column: the composite PK is the identity.
    expect(columns.map((c) => c.name).sort()).toEqual([
      "created_at",
      "event",
      "run_id",
      "seq",
    ]);
  });

  test("run_id cascades from runs", () => {
    const fks = config(schema.runEvents).foreignKeys;
    expect(fks).toHaveLength(1);
    const ref = fks[0]!.reference();
    expect(getTableConfig(ref.foreignTable as PgTable).name).toBe("runs");
    expect(fks[0]!.onDelete).toBe("cascade");
  });
});

describe("triggers", () => {
  test("token_hash is unique (webhook token hashes, rotatable)", () => {
    expect(schema.triggers.tokenHash.isUnique).toBe(true);
    expect(schema.triggers.tokenHash.notNull).toBe(false);
  });

  test("belongs to a workflow with an index", () => {
    const { indexes } = config(schema.triggers);
    const names = indexes.map((i) => i.config.name);
    expect(names).toContain("triggers_workflow_id_idx");
  });

  test("schedule ticker columns: nullable cron + indexed next_fire_at", () => {
    expect(schema.triggers.cron.notNull).toBe(false);
    expect(schema.triggers.nextFireAt.notNull).toBe(false);
    const { indexes } = config(schema.triggers);
    const nextFire = indexes.find(
      (i) => i.config.name === "triggers_next_fire_at_idx",
    );
    expect(nextFire).toBeDefined();
    // Partial: the ticker only scans enabled schedule triggers.
    expect(nextFire!.config.where).toBeDefined();
  });
});

describe("indexes and uniques", () => {
  test("agent_sessions has the agent_id index", () => {
    const names = config(schema.agentSessions).indexes.map(
      (i) => i.config.name,
    );
    expect(names).toContain("agent_sessions_agent_id_idx");
  });

  test("model_presets carry a NOT NULL reasoning effort (part of the preset)", () => {
    expect(columnNames(schema.modelPresets)).toContain("reasoning");
    expect(schema.modelPresets.reasoning.notNull).toBe(true);
    // Backfill value for rows that predate the column.
    expect(schema.modelPresets.reasoning.default).toBe("high");
  });

  test("model_presets unique per (organization_id, slug)", () => {
    const unique = config(schema.modelPresets).indexes.find(
      (i) => i.config.unique,
    );
    expect(unique).toBeDefined();
    expect(
      unique!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["organization_id", "slug"]);
  });

  test("model_allowlist unique per (organization_id, provider, model_id)", () => {
    const unique = config(schema.modelAllowlist).indexes.find(
      (i) => i.config.unique,
    );
    expect(unique).toBeDefined();
    expect(
      unique!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["organization_id", "provider", "model_id"]);
  });

  test("integrations unique per (type, external_id) for inbound routing", () => {
    const unique = config(schema.integrations).indexes.find(
      (i) => i.config.unique,
    );
    expect(unique).toBeDefined();
    expect(
      unique!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["type", "external_id"]);
  });

  test("agent_versions unique per (agent_id, content_hash) — publish idempotency is DB-enforced", () => {
    const unique = config(schema.agentVersions).indexes.find(
      (i) => i.config.unique,
    );
    expect(unique).toBeDefined();
    expect(unique!.config.name).toBe("agent_versions_agent_id_content_hash_uidx");
    expect(
      unique!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["agent_id", "content_hash"]);
  });
});

describe("connection_oauth", () => {
  test("a pending flow is bound to the user who armed it (SET NULL on delete)", () => {
    expect(schema.connectionOauth.pendingStartedBy.getSQLType()).toBe("text");
    expect(schema.connectionOauth.pendingStartedBy.notNull).toBe(false);
    const fk = config(schema.connectionOauth).foreignKeys.find((f) =>
      f
        .reference()
        .columns.some(
          (c) => (c as { name: string }).name === "pending_started_by",
        ),
    );
    expect(fk).toBeDefined();
    expect(
      getTableConfig(fk!.reference().foreignTable as PgTable).name,
    ).toBe("user");
    expect(fk!.onDelete).toBe("set null");
  });

  test("the armed flow records the issuer it expects and the AS's iss capability", () => {
    expect(schema.connectionOauth.expectedIssuer.getSQLType()).toBe("text");
    expect(schema.connectionOauth.expectedIssuer.notNull).toBe(false);
    expect(schema.connectionOauth.issParameterSupported.getSQLType()).toBe(
      "boolean",
    );
    expect(schema.connectionOauth.issParameterSupported.notNull).toBe(false);
  });

  test("an armed flow stages its discovery apart from the live grant", () => {
    // The endpoint columns are where oauth/tokens.ts replays a live refresh
    // token; a start that never completes must not be able to choose them, so
    // discovery lands here first and is promoted only by a successful
    // exchange (2026-08-31 fix plan, adversarial review).
    expect(schema.connectionOauth.pendingFlow.getSQLType()).toBe("jsonb");
    expect(schema.connectionOauth.pendingFlow.notNull).toBe(false);
    expect(columnNames(schema.connectionOauth)).toEqual(
      expect.arrayContaining([
        "pending_flow",
        "token_endpoint",
        "revocation_endpoint",
      ]),
    );
  });

  test("stored client credentials are keyed by the issuer that minted them", () => {
    expect(schema.connectionOauth.clientRegistrationIssuer.getSQLType()).toBe(
      "text",
    );
    expect(schema.connectionOauth.clientRegistrationIssuer.notNull).toBe(false);
  });

  test("client identity mode is the enum, nullable (pre-broker rows are unknown)", () => {
    expect(schema.connectionOauth.clientIdentityMode.notNull).toBe(false);
    expect(schema.connectionOauth.clientIdentityMode.enumValues).toEqual([
      "cimd",
      "dcr",
      "preregistered",
    ]);
  });

  test("a pre-registered client reuses client_id/client_secret_encrypted", () => {
    expect(columnNames(schema.connectionOauth)).toEqual(
      expect.arrayContaining(["client_id", "client_secret_encrypted"]),
    );
    // No parallel operator-credential columns: one home per credential.
    expect(columnNames(schema.connectionOauth)).not.toContain(
      "preregistered_client_id",
    );
  });

  test("last_error_code is a sanitized typed code, distinct from any message", () => {
    expect(schema.connectionOauth.lastErrorCode.getSQLType()).toBe("text");
    expect(schema.connectionOauth.lastErrorCode.notNull).toBe(false);
  });
});

describe("encrypted-at-rest columns are opaque text", () => {
  test("connections.auth_config_encrypted", () => {
    expect(schema.connections.authConfigEncrypted.getSQLType()).toBe("text");
  });

  test("integrations.credentials_encrypted", () => {
    expect(schema.integrations.credentialsEncrypted.getSQLType()).toBe("text");
    expect(schema.integrations.credentialsEncrypted.notNull).toBe(true);
  });
});

describe("agent lineage", () => {
  test("agents reference org, run_as user, and published version", () => {
    const fkTables = config(schema.agents).foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable as PgTable).name,
    );
    expect(fkTables.sort()).toEqual(["agent_versions", "organization", "user"]);
    expect(schema.agents.runAsUserId.notNull).toBe(true);
    expect(schema.agents.publishedVersionId.notNull).toBe(false);
  });

  test("agent_versions carry hash inputs (compiler + eve versions)", () => {
    expect(columnNames(schema.agentVersions)).toEqual(
      expect.arrayContaining([
        "content_hash",
        "compiler_version",
        "eve_version",
        "build_status",
      ]),
    );
  });

  test("agent_versions pin the resolved model (dispatch key injection)", () => {
    expect(schema.agentVersions.modelProvider.notNull).toBe(true);
    expect(schema.agentVersions.modelId.notNull).toBe(true);
  });

  test("builds cache is keyed by hash", () => {
    expect(schema.builds.hash.primary).toBe(true);
  });

  test("agent_sessions pin agent version and track worker affinity", () => {
    expect(columnNames(schema.agentSessions)).toEqual(
      expect.arrayContaining([
        "agent_id",
        "agent_version_id",
        "workflow_id",
        "eve_session_id",
        "continuation_token",
        "affinity_worker_id",
        "origin",
        "principal",
        "status",
      ]),
    );
    expect(schema.agentSessions.agentId.notNull).toBe(true);
    expect(schema.agentSessions.agentVersionId.notNull).toBe(true);
  });

  test("agent_sessions keep workflow provenance as nullable SET NULL", () => {
    expect(schema.agentSessions.workflowId.notNull).toBe(false);
    const workflowFk = config(schema.agentSessions).foreignKeys.find(
      (fk) =>
        getTableConfig(fk.reference().foreignTable as PgTable).name ===
        "workflows",
    );
    expect(workflowFk?.onDelete).toBe("set null");
  });
});

describe("workflow delegation", () => {
  test("workflows reference org and the published agent only", () => {
    const fkTables = config(schema.workflows).foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable as PgTable).name,
    );
    expect(fkTables.sort()).toEqual(["agents", "organization"]);
  });

  test("published snapshot columns exist; drafts default to {}", () => {
    expect(columnNames(schema.workflows)).toEqual(
      expect.arrayContaining([
        "draft",
        "published",
        "published_at",
        "enabled",
        "published_agent_id",
      ]),
    );
    expect(schema.workflows.published.notNull).toBe(false);
    expect(schema.workflows.enabled.notNull).toBe(true);
  });

  test("published_agent_id survives as a dead residual (additive rule)", () => {
    // Nothing writes the column since the pipelines redesign (agents bind per
    // step; delete protection moved to the agent DELETE path) — the RESTRICT
    // FK stays in the schema, inert on always-null rows.
    const agentFk = config(schema.workflows).foreignKeys.find(
      (fk) =>
        getTableConfig(fk.reference().foreignTable as PgTable).name ===
        "agents",
    );
    expect(agentFk?.onDelete).toBe("restrict");
    const names = config(schema.workflows).indexes.map((i) => i.config.name);
    expect(names).toContain("workflows_published_agent_id_idx");
  });

  test("runs carry dispatch provenance + delivery bookkeeping", () => {
    expect(columnNames(schema.runs)).toEqual(
      expect.arrayContaining([
        "task_message",
        "delivery_status",
        "delivery_error",
      ]),
    );
    expect(schema.runs.taskMessage.notNull).toBe(false);
    expect(schema.runs.deliveryStatus.notNull).toBe(false);
  });
});

describe("pipeline runs (workflow-pipelines redesign)", () => {
  test("runs.agent_session_id is NULLABLE — the one NOT NULL relaxation", () => {
    // Pipeline runs have no eve session; every runs ⋈ agent_sessions join
    // must be LEFT or it silently drops them (cap bypass).
    expect(schema.runs.agentSessionId.notNull).toBe(false);
    const sessionFk = config(schema.runs).foreignKeys.find(
      (fk) =>
        getTableConfig(fk.reference().foreignTable as PgTable).name ===
        "agent_sessions",
    );
    expect(sessionFk?.onDelete).toBe("cascade");
  });

  test("runs.mode defaults to agent so pre-column rows read correctly", () => {
    expect(schema.runs.mode.notNull).toBe(true);
    expect(schema.runs.mode.default).toBe("agent");
  });

  test("runs carry denormalized org (nullable, additive) + workflow provenance", () => {
    expect(schema.runs.organizationId.notNull).toBe(false);
    expect(schema.runs.workflowId.notNull).toBe(false);
    const workflowFk = config(schema.runs).foreignKeys.find(
      (fk) =>
        getTableConfig(fk.reference().foreignTable as PgTable).name ===
        "workflows",
    );
    // The run record outlives the workflow that spawned it.
    expect(workflowFk?.onDelete).toBe("set null");
    const names = config(schema.runs).indexes.map((i) => i.config.name);
    expect(names).toContain("runs_organization_id_idx");
    expect(names).toContain("runs_workflow_id_idx");
  });

  test("run_steps: app-side rs_ text id, cascade from runs, denormalized org", () => {
    // Prefixed-nanoid PK generated app-side, like connections — not a uuid.
    expect(schema.runSteps.id.getSQLType()).toBe("text");
    expect(schema.runSteps.id.primary).toBe(true);
    const fks = config(schema.runSteps).foreignKeys;
    const byTable = (name: string) =>
      fks.filter(
        (fk) =>
          getTableConfig(fk.reference().foreignTable as PgTable).name === name,
      );
    const runFks = byTable("runs");
    // Two links into runs: the owning run (cascade) and the child run an
    // `agent` step spawned (SET NULL — the ledger row outlives the child).
    expect(runFks).toHaveLength(2);
    const onDeletes = runFks.map((fk) => fk.onDelete).sort();
    expect(onDeletes).toEqual(["cascade", "set null"]);
    expect(byTable("organization")[0]?.onDelete).toBe("cascade");
    expect(schema.runSteps.organizationId.notNull).toBe(true);
  });

  test("run_steps: unique (run_id, path) is the recovery claim key", () => {
    const unique = config(schema.runSteps).indexes.find(
      (i) => i.config.unique,
    );
    expect(unique).toBeDefined();
    expect(unique!.config.name).toBe("run_steps_run_id_path_uidx");
    // Leading run_id doubles as the ledger read index — no separate index.
    expect(
      unique!.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(["run_id", "path"]);
  });

  test("run_steps lifecycle columns: status/attempt defaults + nullable timings", () => {
    expect(schema.runSteps.status.default).toBe("pending");
    expect(schema.runSteps.attempt.default).toBe(1);
    expect(schema.runSteps.iteration.notNull).toBe(false);
    expect(schema.runSteps.parentPath.notNull).toBe(false);
    expect(schema.runSteps.startedAt.notNull).toBe(false);
    expect(schema.runSteps.completedAt.notNull).toBe(false);
    // Open error vocabulary: text, not an enum.
    expect(schema.runSteps.errorClass.getSQLType()).toBe("text");
  });

  test("workflow_state: composite (workflow_id, key) PK, cascade, run provenance", () => {
    const { primaryKeys } = config(schema.workflowState);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]!.columns.map((c) => c.name)).toEqual([
      "workflow_id",
      "key",
    ]);
    const fks = config(schema.workflowState).foreignKeys;
    const find = (name: string) =>
      fks.find(
        (fk) =>
          getTableConfig(fk.reference().foreignTable as PgTable).name === name,
      );
    // State dies with the workflow; the provenance run link merely detaches.
    expect(find("workflows")?.onDelete).toBe("cascade");
    expect(find("runs")?.onDelete).toBe("set null");
    expect(find("organization")?.onDelete).toBe("cascade");
    expect(schema.workflowState.value.notNull).toBe(true);
    expect(schema.workflowState.updatedByRunId.notNull).toBe(false);
  });
});
