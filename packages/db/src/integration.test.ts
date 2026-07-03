/**
 * DB round-trip tests: migrate → seed → query.
 *
 * Gated: they run only when TEST_DATABASE_URL is set (the integration stage
 * provides it, e.g. postgres://dev:dev@localhost:5432/product) and skip
 * cleanly otherwise. Rows use random ids so reruns against the same database
 * do not clash; migrations are idempotent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, count, eq } from "drizzle-orm";

import { createDb, type Db } from "./client";
import { runMigrations } from "./migrate";
import * as schema from "./schema";
import { DEMO_ORG, DEMO_USER, seedDemo, seedWorkspace } from "./seed";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/** Drizzle wraps driver errors ("Failed query: …") with the pg error as cause. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

if (!testDatabaseUrl) {
  console.info(
    "[db] TEST_DATABASE_URL not set — skipping DB round-trip tests (integration stage provides it)",
  );
}

describe.skipIf(!testDatabaseUrl)("db round trip (migrate → seed → query)", () => {
  let db: Db;
  const suffix = crypto.randomUUID().slice(0, 8);
  const orgId = `org-it-${suffix}`;
  const userId = `user-it-${suffix}`;

  beforeAll(async () => {
    db = createDb(testDatabaseUrl!, { max: 4 });
    await runMigrations(db);
    // Idempotency: applying migrations again is a no-op, not an error.
    await runMigrations(db);

    await db.insert(schema.user).values({
      id: userId,
      name: "Integration Tester",
      email: `it-${suffix}@invisible-string.local`,
    });
    await db.insert(schema.organization).values({
      id: orgId,
      name: `IT Workspace ${suffix}`,
      slug: `it-${suffix}`,
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: `member-it-${suffix}`,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    // FK cascades from organization/user remove the workspace-scoped rows.
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.$client.end();
  });

  test("seedWorkspace is idempotent and preserves admin edits", async () => {
    await seedWorkspace(db, orgId);
    await seedWorkspace(db, orgId);

    const presets = await db
      .select()
      .from(schema.modelPresets)
      .where(eq(schema.modelPresets.organizationId, orgId));
    expect(presets).toHaveLength(3);
    expect(
      presets.map((p) => [p.slug, p.provider, p.modelId]).sort(),
    ).toEqual([
      ["balanced", "openrouter", "deepseek/deepseek-v4-pro"],
      ["powerful", "openrouter", "z-ai/glm-5.2"],
      ["quick", "openrouter", "deepseek/deepseek-v4-flash"],
    ]);

    const [allowRows] = await db
      .select({ n: count() })
      .from(schema.modelAllowlist)
      .where(eq(schema.modelAllowlist.organizationId, orgId));
    expect(allowRows?.n).toBe(3);

    const agentRows = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.organizationId, orgId));
    expect(agentRows.map((a) => a.name).sort()).toEqual([
      "General Purpose",
      "Product Designer",
      "Software Engineer",
    ]);
    expect(agentRows.every((a) => a.modelPreset === "balanced")).toBe(true);

    // Admin edit survives a re-seed (ON CONFLICT DO NOTHING).
    await db
      .update(schema.modelPresets)
      .set({ modelId: "anthropic/claude-custom" })
      .where(
        and(
          eq(schema.modelPresets.organizationId, orgId),
          eq(schema.modelPresets.slug, "quick"),
        ),
      );
    await seedWorkspace(db, orgId);
    const [quick] = await db
      .select()
      .from(schema.modelPresets)
      .where(
        and(
          eq(schema.modelPresets.organizationId, orgId),
          eq(schema.modelPresets.slug, "quick"),
        ),
      );
    expect(quick?.modelId).toBe("anthropic/claude-custom");
  });

  test("seedDemo bootstraps demo user/org idempotently", async () => {
    await seedDemo(db);
    await seedDemo(db);

    const [demoUser] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, DEMO_USER.id));
    expect(demoUser?.email).toBe(DEMO_USER.email);

    const [demoOrg] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, DEMO_ORG.id));
    expect(demoOrg?.slug).toBe(DEMO_ORG.slug);

    const [presetCount] = await db
      .select({ n: count() })
      .from(schema.modelPresets)
      .where(eq(schema.modelPresets.organizationId, DEMO_ORG.id));
    expect(presetCount?.n).toBe(3);
  });

  test("workflow → version → session → run → run_events round trip", async () => {
    const [workflow] = await db
      .insert(schema.workflows)
      .values({
        organizationId: orgId,
        name: "It Works",
        runAsUserId: userId,
        draft: { instructions: "do the thing @trigger.payload" },
      })
      .returning();
    expect(workflow).toBeDefined();

    const [version] = await db
      .insert(schema.workflowVersions)
      .values({
        workflowId: workflow!.id,
        config: { instructions: "do the thing" },
        contentHash: `hash-${suffix}`,
        compilerVersion: "0.0.1",
        eveVersion: "0.0.0-test",
        buildStatus: "succeeded",
      })
      .returning();

    // Publish: circular FK workflows.published_version_id → workflow_versions.
    await db
      .update(schema.workflows)
      .set({ publishedVersionId: version!.id })
      .where(eq(schema.workflows.id, workflow!.id));

    await db.insert(schema.workflowBuilds).values({
      hash: `hash-${suffix}`,
      status: "succeeded",
      artifactKey: `artifacts/hash-${suffix}.tar.gz`,
    });

    const [agentSession] = await db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        workflowId: workflow!.id,
        workflowVersionId: version!.id,
        origin: "chat",
        principal: { workspaceId: orgId, userId, source: "chat" },
      })
      .returning();

    const [run] = await db
      .insert(schema.runs)
      .values({
        agentSessionId: agentSession!.id,
        triggerEvent: {
          workflowId: workflow!.id,
          triggerType: "manual",
          message: "hello",
          data: {},
          principal: { workspaceId: orgId, userId, source: "chat" },
        },
        status: "running",
      })
      .returning();

    await db.insert(schema.runEvents).values([
      { runId: run!.id, seq: 0, event: { type: "session.created" } },
      { runId: run!.id, seq: 1, event: { type: "message.delta", text: "hi" } },
      { runId: run!.id, seq: 2, event: { type: "turn.completed" } },
    ]);

    const events = await db
      .select()
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run!.id))
      .orderBy(asc(schema.runEvents.seq));
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]?.event).toEqual({ type: "session.created" });

    // (run_id, seq) is the primary key — duplicate seq must be rejected.
    let dupError: unknown;
    try {
      await db
        .insert(schema.runEvents)
        .values({ runId: run!.id, seq: 1, event: { type: "dup" } });
    } catch (error) {
      dupError = error;
    }
    expect(errorText(dupError)).toMatch(
      /duplicate key|run_events_run_id_seq_pk/,
    );

    // Cascade check: deleting the workflow removes versions/sessions/runs/events.
    await db
      .update(schema.workflows)
      .set({ publishedVersionId: null })
      .where(eq(schema.workflows.id, workflow!.id));
    await db
      .delete(schema.workflows)
      .where(eq(schema.workflows.id, workflow!.id));
    const [orphans] = await db
      .select({ n: count() })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, run!.id));
    expect(orphans?.n).toBe(0);
  });

  test("triggers.token_hash is unique", async () => {
    const [workflow] = await db
      .insert(schema.workflows)
      .values({ organizationId: orgId, name: "Hooked", runAsUserId: userId })
      .returning();

    const tokenHash = `sha256-${suffix}`;
    await db.insert(schema.triggers).values({
      workflowId: workflow!.id,
      type: "webhook",
      tokenHash,
    });

    let dupError: unknown;
    try {
      await db.insert(schema.triggers).values({
        workflowId: workflow!.id,
        type: "webhook",
        tokenHash,
      });
    } catch (error) {
      dupError = error;
    }
    expect(errorText(dupError)).toMatch(
      /duplicate key|triggers_token_hash_unique/,
    );

    // Multiple NULL token hashes are fine (form/slack triggers have none).
    await db.insert(schema.triggers).values([
      { workflowId: workflow!.id, type: "form", formSchema: { fields: [] } },
      { workflowId: workflow!.id, type: "slack", binding: { channel: "C1" } },
    ]);
  });

  test("scope/owner CHECK constraints reject inconsistent mcp_connections and skills rows", async () => {
    // Valid rows on both sides of the enum pass.
    await db.insert(schema.mcpConnections).values({
      scope: "workspace",
      organizationId: orgId,
      name: `mcp-ws-${suffix}`,
      source: "custom",
      url: "https://mcp.example.com/mcp",
    });
    await db.insert(schema.skills).values({
      scope: "user",
      userId,
      name: `skill-user-${suffix}`,
      content: "# skill",
    });

    const invalid: {
      table: "mcp" | "skill";
      row: Record<string, unknown>;
    }[] = [
      // workspace scope without organization_id (orphan)
      { table: "mcp", row: { scope: "workspace", userId } },
      // user scope without user_id (orphan)
      { table: "mcp", row: { scope: "user", organizationId: orgId } },
      // both owners set (cross-scope ambiguity)
      { table: "mcp", row: { scope: "workspace", organizationId: orgId, userId } },
      // neither owner set
      { table: "skill", row: { scope: "user" } },
      { table: "skill", row: { scope: "workspace", userId } },
    ];
    for (const { table, row } of invalid) {
      let checkError: unknown;
      try {
        if (table === "mcp") {
          await db.insert(schema.mcpConnections).values({
            name: `mcp-bad-${suffix}`,
            source: "custom",
            ...row,
          } as typeof schema.mcpConnections.$inferInsert);
        } else {
          await db.insert(schema.skills).values({
            name: `skill-bad-${suffix}`,
            content: "# bad",
            ...row,
          } as typeof schema.skills.$inferInsert);
        }
      } catch (error) {
        checkError = error;
      }
      expect(errorText(checkError)).toMatch(/scope_owner_check|check constraint/);
    }
  });

  test("better-auth login session accepts activeOrganizationId", async () => {
    await db.insert(schema.session).values({
      id: `login-${suffix}`,
      token: `tok-${suffix}`,
      userId,
      activeOrganizationId: orgId,
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
    });
    const [row] = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.id, `login-${suffix}`));
    expect(row?.activeOrganizationId).toBe(orgId);
  });
});
