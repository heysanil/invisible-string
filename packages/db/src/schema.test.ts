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
});

describe("encrypted-at-rest columns are opaque text", () => {
  test("mcp_connections.auth_config_encrypted", () => {
    expect(schema.mcpConnections.authConfigEncrypted.getSQLType()).toBe(
      "text",
    );
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

  test("agent deletion is RESTRICTed while a published workflow delegates to it", () => {
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
