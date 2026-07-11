/**
 * Workflows CRUD + publish + trigger-row sync — service-level tests (gated on
 * TEST_DATABASE_URL; skip cleanly when unset). Proves:
 *
 * - CRUD returns validator diagnostics next to the row (create/GET/PATCH),
 *   and workspace scoping 404s foreign rows.
 * - publish gates on error diagnostics (422 workflow_validation_failed),
 *   then snapshots draft → published (+ publishedAgentId/publishedAt) and
 *   syncs the trigger row per type: schedule (cron + nextFireAt strictly
 *   after now), slack (binding RULES refreshed, integration pointer
 *   preserved), form (formSchema snapshot), webhook (minted token survives
 *   republish; a type switch clears it).
 * - the enabled toggle mirrors onto the trigger row and sets/clears the
 *   schedule cursor.
 * - agent-staleness warnings on GET after the agent republishes without a
 *   referenced context resource.
 * - loadPublishedWorkflow (the dispatch loader) guards published state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import type { GetWorkflowResponse, SlackTriggerBinding } from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { setSlackBinding, setTriggerToken, upsertTriggerType } from "../integrations/service";
import { runMigrations } from "../migrate";
import { isRuntimeApiError } from "../runtime/errors";
import type { ResourceDeps } from "./common";
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  loadPublishedWorkflow,
  publishWorkflow,
  updateWorkflow,
} from "./workflows";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[workflows] TEST_DATABASE_URL not set — skipping workflows CRUD/publish tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("workflows — CRUD, publish, trigger sync", () => {
  let handle: DbHandle;
  let deps: ResourceDeps;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let actor: { organizationId: string; userId: string };

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 4 });
    // The workflow service consumes only `db` from ResourceDeps.
    deps = { db: handle.db } as unknown as ResourceDeps;

    userId = `usr_${randomUUID()}`;
    await handle.db.insert(schema.user).values({
      id: userId,
      name: "Workflows Tester",
      email: `wf-${randomUUID()}@example.test`,
    });
    orgId = `org_${randomUUID()}`;
    otherOrgId = `org_${randomUUID()}`;
    await handle.db.insert(schema.organization).values([
      { id: orgId, name: "WF Org", slug: `wf-org-${randomUUID()}`, createdAt: new Date() },
      { id: otherOrgId, name: "Other Org", slug: `wf-other-${randomUUID()}`, createdAt: new Date() },
    ]);
    actor = { organizationId: orgId, userId };
  });

  afterAll(async () => {
    if (handle) {
      // workflows first: published_agent_id → agents is ON DELETE RESTRICT.
      for (const org of [orgId, otherOrgId]) {
        await handle.db.delete(schema.workflows).where(eq(schema.workflows.organizationId, org));
        await handle.db.delete(schema.organization).where(eq(schema.organization.id, org));
      }
      await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
      await handle.close();
    }
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function createAgent(options: {
    name: string;
    published?: boolean;
    connectionNames?: string[];
    skillNames?: string[];
  }): Promise<{ agentId: string; versionId: string | null }> {
    const mcpConnectionIds: string[] = [];
    for (const name of options.connectionNames ?? []) {
      const rows = await handle.db
        .insert(schema.mcpConnections)
        .values({
          scope: "workspace",
          organizationId: orgId,
          name,
          source: "custom",
          url: "https://mcp.example.test/mcp",
        })
        .returning({ id: schema.mcpConnections.id });
      mcpConnectionIds.push(rows[0]!.id);
    }
    const skillIds: string[] = [];
    for (const name of options.skillNames ?? []) {
      const rows = await handle.db
        .insert(schema.skills)
        .values({
          scope: "workspace",
          organizationId: orgId,
          name,
          content: `# ${name}`,
        })
        .returning({ id: schema.skills.id });
      skillIds.push(rows[0]!.id);
    }

    const definition = {
      persona: "You are a test agent.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds, skillIds },
    };
    const agentRows = await handle.db
      .insert(schema.agents)
      .values({
        organizationId: orgId,
        name: options.name,
        runAsUserId: userId,
        draft: definition,
      })
      .returning({ id: schema.agents.id });
    const agentId = agentRows[0]!.id;

    let versionId: string | null = null;
    if (options.published !== false) {
      versionId = await publishAgentVersion(agentId, definition);
    }
    return { agentId, versionId };
  }

  /** Snapshot a definition into agent_versions and point the agent at it. */
  async function publishAgentVersion(
    agentId: string,
    definition: Record<string, unknown>,
  ): Promise<string> {
    const versionRows = await handle.db
      .insert(schema.agentVersions)
      .values({
        agentId,
        definition,
        contentHash: `hash-${randomUUID()}`,
        compilerVersion: "test-3.0.0",
        eveVersion: "0.0.0-test",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        buildStatus: "succeeded",
      })
      .returning({ id: schema.agentVersions.id });
    const versionId = versionRows[0]!.id;
    await handle.db
      .update(schema.agents)
      .set({ publishedVersionId: versionId })
      .where(eq(schema.agents.id, agentId));
    return versionId;
  }

  async function triggerRowOf(workflowId: string) {
    const rows = await handle.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.workflowId, workflowId));
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows[0] ?? null;
  }

  function draftFor(
    agentId: string | null,
    trigger: Record<string, unknown>,
    markdown = "Do the delegated thing.",
  ) {
    return { trigger, agentId, instructions: { markdown } };
  }

  // ── CRUD + diagnostics ─────────────────────────────────────────────────────

  test("create without a draft returns shape diagnostics; draft normalizes", async () => {
    const created = await createWorkflow(deps, actor, { name: "Empty Draft" });
    expect(created.workflow.draft).toEqual({});
    expect(created.workflow.published).toBeNull();
    expect(created.workflow.enabled).toBeTrue();
    expect(created.diagnostics).toBeDefined();
    expect(created.diagnostics!.length).toBeGreaterThan(0);
    expect(created.diagnostics!.every((d) => d.severity === "error")).toBeTrue();
  });

  test("a valid draft against a published agent has zero diagnostics; list resolves agentName", async () => {
    const { agentId } = await createAgent({ name: "List Agent" });
    const created = await createWorkflow(deps, actor, {
      name: "Valid Draft",
      draft: draftFor(agentId, { type: "webhook" }),
    });
    expect(created.diagnostics).toEqual([]);

    const list = await listWorkflows(deps, orgId);
    const summary = list.workflows.find((w) => w.id === created.workflow.id);
    expect(summary?.agentName).toBe("List Agent");
    expect(summary?.triggerType).toBe("webhook");
    expect(summary?.publishedAt).toBeNull();
  });

  test("PATCH returns diagnostics for an unpublished agent; foreign org 404s", async () => {
    const { agentId } = await createAgent({ name: "Unpublished Agent", published: false });
    const created = await createWorkflow(deps, actor, { name: "Patch Target" });
    const updated = await updateWorkflow(deps, actor, created.workflow.id, {
      draft: draftFor(agentId, { type: "manual" }),
    });
    expect(
      updated.diagnostics!.some(
        (d) => d.path === "agentId" && d.message.includes("no published version"),
      ),
    ).toBeTrue();

    // Workspace scoping: the row is invisible from another workspace.
    await expect(
      getWorkflow(deps, otherOrgId, created.workflow.id),
    ).rejects.toMatchObject({ code: "workflow_not_found", status: 404 });
  });

  // ── publish gate ───────────────────────────────────────────────────────────

  test("publish blocks with 422 workflow_validation_failed while error diagnostics remain", async () => {
    const { agentId } = await createAgent({ name: "Gate Agent", published: false });
    const created = await createWorkflow(deps, actor, {
      name: "Blocked Publish",
      draft: draftFor(agentId, { type: "manual" }),
    });
    try {
      await publishWorkflow(deps, orgId, created.workflow.id);
      throw new Error("publish should have thrown");
    } catch (error) {
      if (!isRuntimeApiError(error)) throw error;
      expect(error.status).toBe(422);
      expect(error.code).toBe("workflow_validation_failed");
      const details = error.toBody().error.details as {
        diagnostics: { path: string; severity: string }[];
      };
      expect(details.diagnostics.some((d) => d.path === "agentId")).toBeTrue();
    }
    const after = await getWorkflow(deps, orgId, created.workflow.id);
    expect(after.workflow.published).toBeNull();
  });

  test("publish snapshots draft → published and the dispatch loader reads it", async () => {
    const { agentId } = await createAgent({ name: "Webhook Agent" });
    const draft = draftFor(agentId, { type: "webhook" }, "Handle @trigger.email fast.");
    const created = await createWorkflow(deps, actor, { name: "Webhook WF", draft });

    await expect(
      loadPublishedWorkflow(handle.db, orgId, created.workflow.id),
    ).rejects.toMatchObject({ code: "workflow_not_published" });

    const published = await publishWorkflow(deps, orgId, created.workflow.id);
    expect(published.workflow.published).toMatchObject({ agentId });
    expect(published.workflow.publishedAt).not.toBeNull();

    const row = (
      await handle.db
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.id, created.workflow.id))
    )[0]!;
    expect(row.publishedAgentId).toBe(agentId);

    const loaded = await loadPublishedWorkflow(handle.db, orgId, created.workflow.id);
    expect(loaded.agentId).toBe(agentId);
    expect(loaded.config.trigger.type).toBe("webhook");
    expect(loaded.config.instructions.markdown).toContain("@trigger.email");

    const trigger = await triggerRowOf(created.workflow.id);
    expect(trigger).toMatchObject({ type: "webhook", enabled: true, cron: null });
    expect(trigger!.nextFireAt).toBeNull();
  });

  // ── trigger-row sync per type ──────────────────────────────────────────────

  test("schedule publish sets cron + nextFireAt strictly after now; toggle clears and restores it", async () => {
    const { agentId } = await createAgent({ name: "Schedule Agent" });
    const created = await createWorkflow(deps, actor, {
      name: "Schedule WF",
      draft: draftFor(agentId, { type: "schedule", cron: "*/5 * * * *" }),
    });
    const before = Date.now();
    await publishWorkflow(deps, orgId, created.workflow.id);

    let trigger = await triggerRowOf(created.workflow.id);
    expect(trigger).toMatchObject({ type: "schedule", cron: "*/5 * * * *", enabled: true });
    expect(trigger!.nextFireAt).not.toBeNull();
    expect(trigger!.nextFireAt!.getTime()).toBeGreaterThan(before);
    // */5 fires within 5 minutes (+ scheduling slack for the minute floor).
    expect(trigger!.nextFireAt!.getTime()).toBeLessThanOrEqual(before + 6 * 60_000);

    // Master-switch off: trigger disabled, schedule cursor cleared, cron kept.
    await updateWorkflow(deps, actor, created.workflow.id, { enabled: false });
    trigger = await triggerRowOf(created.workflow.id);
    expect(trigger).toMatchObject({ enabled: false, cron: "*/5 * * * *" });
    expect(trigger!.nextFireAt).toBeNull();

    // Back on: the cursor is recomputed strictly after now (no backfill).
    const reEnabledAt = Date.now();
    await updateWorkflow(deps, actor, created.workflow.id, { enabled: true });
    trigger = await triggerRowOf(created.workflow.id);
    expect(trigger!.enabled).toBeTrue();
    expect(trigger!.nextFireAt!.getTime()).toBeGreaterThan(reEnabledAt);
  });

  test("slack publish refreshes binding RULES but preserves the bound integration", async () => {
    const { agentId } = await createAgent({ name: "Slack Agent" });
    const created = await createWorkflow(deps, actor, {
      name: "Slack WF",
      draft: draftFor(agentId, {
        type: "slack",
        binding: { mentionOnly: true, includeDirectMessages: false },
      }),
    });

    // User binds a team (PUT …/triggers/slack equivalent) with older rules.
    const integrationRows = await handle.db
      .insert(schema.integrations)
      .values({
        organizationId: orgId,
        type: "slack",
        externalId: `T${randomUUID().slice(0, 8)}`,
        credentialsEncrypted: "enc:test",
        metadata: { scopes: [] },
      })
      .returning({ id: schema.integrations.id });
    const integrationId = integrationRows[0]!.id;
    const preBound = await upsertTriggerType(handle.db, created.workflow.id, "slack");
    await setSlackBinding(handle.db, preBound.id, integrationId, {
      mentionOnly: true,
      includeDirectMessages: false,
    } as SlackTriggerBinding);

    // Republish with changed rules → row rules follow the snapshot.
    await updateWorkflow(deps, actor, created.workflow.id, {
      draft: draftFor(agentId, {
        type: "slack",
        binding: { mentionOnly: false, includeDirectMessages: true, channelId: "C123" },
      }),
    });
    await publishWorkflow(deps, orgId, created.workflow.id);

    const trigger = await triggerRowOf(created.workflow.id);
    expect(trigger).toMatchObject({ type: "slack", integrationId, tokenHash: null });
    expect(trigger!.binding).toMatchObject({
      mentionOnly: false,
      includeDirectMessages: true,
      channelId: "C123",
    });
  });

  test("form publish snapshots the field schema onto the trigger row", async () => {
    const { agentId } = await createAgent({ name: "Form Agent" });
    const fields = [
      { key: "email", label: "Email", type: "text", required: true },
      { key: "notes", label: "Notes", type: "textarea" },
    ];
    const created = await createWorkflow(deps, actor, {
      name: "Form WF",
      draft: draftFor(agentId, { type: "form", fields }, "Reach out to @trigger.email."),
    });
    await publishWorkflow(deps, orgId, created.workflow.id);

    const trigger = await triggerRowOf(created.workflow.id);
    expect(trigger!.type).toBe("form");
    const stored = trigger!.formSchema as { fields: { key: string }[] };
    expect(stored.fields.map((f) => f.key)).toEqual(["email", "notes"]);
  });

  test("republish keeps a minted webhook token; switching type away clears it", async () => {
    const { agentId } = await createAgent({ name: "Token Agent" });
    const created = await createWorkflow(deps, actor, {
      name: "Token WF",
      draft: draftFor(agentId, { type: "webhook" }),
    });
    await publishWorkflow(deps, orgId, created.workflow.id);

    const row = await triggerRowOf(created.workflow.id);
    await setTriggerToken(handle.db, row!.id, {
      type: "webhook",
      tokenHash: `sha256-${randomUUID()}`,
      tokenSuffix: "abcd",
      formSchema: null,
    });

    await publishWorkflow(deps, orgId, created.workflow.id);
    let trigger = await triggerRowOf(created.workflow.id);
    expect(trigger!.tokenHash).not.toBeNull();
    expect(trigger!.binding).toMatchObject({ tokenSuffix: "abcd" });

    await updateWorkflow(deps, actor, created.workflow.id, {
      draft: draftFor(agentId, { type: "manual" }),
    });
    await publishWorkflow(deps, orgId, created.workflow.id);
    trigger = await triggerRowOf(created.workflow.id);
    expect(trigger).toMatchObject({ type: "manual", tokenHash: null, binding: null });
  });

  // ── staleness warnings ─────────────────────────────────────────────────────

  test("agent republish stranding a @ref surfaces a warning on GET, never unpublishes", async () => {
    const { agentId } = await createAgent({
      name: "Context Agent",
      connectionNames: ["Linear"],
    });
    const created = await createWorkflow(deps, actor, {
      name: "Staleness WF",
      draft: draftFor(agentId, { type: "webhook" }, "File it via @linear."),
    });
    await publishWorkflow(deps, orgId, created.workflow.id);

    const clean: GetWorkflowResponse = await getWorkflow(deps, orgId, created.workflow.id);
    expect(clean.diagnostics).toEqual([]);

    // The agent republishes WITHOUT the connection in its context.
    await publishAgentVersion(agentId, {
      persona: "You are a test agent.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
    });

    const stale = await getWorkflow(deps, orgId, created.workflow.id);
    const warnings = stale.diagnostics!.filter((d) => d.severity === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!).toMatchObject({ path: "published.instructions.markdown" });
    expect(warnings[0]!.message).toContain('"@linear"');
    // The draft (still referencing @linear) now fails validation as an error…
    expect(
      stale.diagnostics!.some(
        (d) => d.severity === "error" && d.path === "instructions.markdown",
      ),
    ).toBeTrue();
    // …but the published snapshot stays dispatchable.
    const loaded = await loadPublishedWorkflow(handle.db, orgId, created.workflow.id);
    expect(loaded.agentId).toBe(agentId);
  });
});
