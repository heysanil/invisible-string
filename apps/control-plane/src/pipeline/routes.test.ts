/**
 * Pipeline route tests (gated on TEST_DATABASE_URL; skip cleanly when unset):
 * the runs list (both modes through the LEFT-join + COALESCE org predicate),
 * the run_steps ledger (preview vs `?full=1`), workflow state read/delete,
 * and the per-step test route (rendered input, executor outcome mapping, the
 * step_not_testable / step_not_found / workflow_draft_invalid refusals).
 *
 * Authz matrix per AGENTS.md rule 7 on every route: anonymous 401, outsider
 * 403 on foreign paths / 404 on foreign rows, member reads + tests, state
 * DELETEs owner/admin-only. The workspace macro runs against a FAKE
 * WorkspaceDeps (headers → session/membership) so the suite exercises the
 * real Elysia plugin without the Better Auth stack.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  listRunStepsResponseSchema,
  listWorkflowRunsResponseSchema,
  newId,
  newStepId,
  PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES,
  type Logger,
  type TestWorkflowStepResponse,
  type TriggerEvent,
} from "@invisible-string/shared";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import type { WorkspaceDeps } from "../workspace";
import { pipelinePlugin, type PipelineRouteDeps } from "./routes";
import type {
  PipelineExecutorDeps,
  StepExecuteContext,
  StepExecutor,
} from "./types";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";

if (!TEST_DATABASE_URL) {
  console.warn("[pipeline-routes] TEST_DATABASE_URL not set — skipping route tests");
}

const nullLogger: Logger = {
  emit() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return nullLogger;
  },
};

describe.skipIf(!TEST_DATABASE_URL)("pipeline routes", () => {
  let handle: DbHandle;
  let app: { handle(request: Request): Promise<Response> };

  let orgA: string;
  let orgB: string;
  const ADMIN = "user-admin";
  const MEMBER = "user-member";
  const OUTSIDER = "user-outsider";
  /** `${userId}:${orgId}` → role. */
  const memberships = new Map<string, string>();

  let wfA: string;
  let wfB: string;
  /** Pipeline runs on wfA, newest first. */
  let pipelineRunNew: string;
  let pipelineRunOld: string;
  /** Historical agent-mode run reaching wfA through its session. */
  let agentRun: string;
  /** A pipeline run on wfB (orgB) — must never leak into orgA reads. */
  let foreignRun: string;
  let toolStepId: string;
  let inferStepId: string;
  let filterStepId: string;

  /** Step-test executor capture (the route injects these as `testExecutors`). */
  const executed: StepExecuteContext[] = [];
  let toolOutcome: Awaited<ReturnType<StepExecutor>>;

  const fakeToolExecutor: StepExecutor = async (ctx) => {
    executed.push(ctx);
    return toolOutcome;
  };
  const fakeInferExecutor: StepExecutor = async (ctx) => {
    executed.push(ctx);
    return { status: "succeeded", output: { text: "summarized" } };
  };

  function triggerEvent(workspaceId: string): TriggerEvent {
    return {
      agentId: randomUUID(),
      workflowId: null,
      triggerType: "manual",
      message: "",
      data: {},
      principal: { workspaceId, source: "test" },
    };
  }

  async function api(
    method: string,
    path: string,
    options: { user?: string; org?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.user) headers["x-test-user"] = options.user;
    if (options.org) headers["x-test-org"] = options.org;
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return app.handle(new Request(`${BASE_URL}${path}`, init));
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 4 });
    const db = handle.db;

    const workspaceDeps: WorkspaceDeps = {
      async getSession(headers) {
        const userId = headers.get("x-test-user");
        if (!userId) return null;
        return {
          user: { id: userId, email: `${userId}@example.test`, name: userId },
          session: { activeOrganizationId: headers.get("x-test-org") },
        };
      },
      async getMembership(userId, organizationId) {
        const role = memberships.get(`${userId}:${organizationId}`);
        return role ? { role } : null;
      },
    };
    const deps: PipelineRouteDeps = {
      db,
      workspaceDeps,
      logger: nullLogger,
      // The fake executors never reach for the real graph.
      executorDeps: { db, logger: nullLogger } as unknown as PipelineExecutorDeps,
      testExecutors: { tool: fakeToolExecutor, infer: fakeInferExecutor },
    };
    app = new Elysia().use(pipelinePlugin(deps));

    // ── workspace fixtures ──────────────────────────────────────────────────
    orgA = `org_${randomUUID()}`;
    orgB = `org_${randomUUID()}`;
    await db.insert(schema.organization).values([
      { id: orgA, name: "Org A", slug: `pr-a-${randomUUID()}`, createdAt: new Date() },
      { id: orgB, name: "Org B", slug: `pr-b-${randomUUID()}`, createdAt: new Date() },
    ]);
    memberships.set(`${ADMIN}:${orgA}`, "owner");
    memberships.set(`${MEMBER}:${orgA}`, "member");
    memberships.set(`${OUTSIDER}:${orgB}`, "owner");

    const userId = `usr_${randomUUID()}`;
    await db.insert(schema.user).values({
      id: userId,
      name: "Pipeline Routes Tester",
      email: `pr-${randomUUID()}@example.test`,
    });

    // ── workflows (wfA carries the testable draft) ──────────────────────────
    const connectionId = newId("cn");
    await db.insert(schema.connections).values({
      id: connectionId,
      scope: "workspace",
      organizationId: orgA,
      name: "Linear",
      source: "custom",
      url: "https://mcp.example.test/mcp",
    });
    toolStepId = newStepId();
    inferStepId = newStepId();
    filterStepId = newStepId();
    const wfRows = await db
      .insert(schema.workflows)
      .values([
        {
          organizationId: orgA,
          name: "Pipeline WF",
          draft: {
            version: 2,
            trigger: { type: "webhook" },
            steps: [
              {
                id: toolStepId,
                slug: "create",
                kind: "tool",
                connectionId,
                tool: "create_issue",
                args: {
                  title: { $tpl: "Issue for @trigger.subject" },
                  count: { $ref: "state.count" },
                },
              },
              {
                id: inferStepId,
                slug: "summarize",
                kind: "infer",
                prompt: { markdown: "Summarize @steps.create.text" },
              },
              { id: filterStepId, slug: "gate", kind: "filter", where: { truthy: true } },
            ],
          },
        },
        { organizationId: orgB, name: "Foreign WF", draft: {} },
      ])
      .returning({ id: schema.workflows.id });
    wfA = wfRows[0]!.id;
    wfB = wfRows[1]!.id;

    // ── runs: two pipeline runs + one historical agent-mode run ─────────────
    const now = Date.now();
    const runRows = await db
      .insert(schema.runs)
      .values([
        {
          mode: "pipeline",
          organizationId: orgA,
          workflowId: wfA,
          agentSessionId: null,
          status: "succeeded",
          triggerEvent: triggerEvent(orgA) as unknown as Record<string, unknown>,
          createdAt: new Date(now - 1_000),
        },
        {
          mode: "pipeline",
          organizationId: orgA,
          workflowId: wfA,
          agentSessionId: null,
          status: "failed",
          error: "boom",
          triggerEvent: triggerEvent(orgA) as unknown as Record<string, unknown>,
          createdAt: new Date(now - 2_000),
        },
      ])
      .returning({ id: schema.runs.id });
    pipelineRunNew = runRows[0]!.id;
    pipelineRunOld = runRows[1]!.id;

    // Agent-mode run written BEFORE runs.organization_id existed: org null on
    // the row, reachable only through the session join (the COALESCE arm).
    const agentRows = await db
      .insert(schema.agents)
      .values({ organizationId: orgA, name: "WF Agent", runAsUserId: userId, draft: {} })
      .returning({ id: schema.agents.id });
    const versionRows = await db
      .insert(schema.agentVersions)
      .values({
        agentId: agentRows[0]!.id,
        definition: {},
        contentHash: `pr-${randomUUID()}`,
        compilerVersion: "test",
        eveVersion: "0.0.0-test",
        modelProvider: "openrouter",
        modelId: "vendor/test",
        buildStatus: "succeeded",
      })
      .returning({ id: schema.agentVersions.id });
    const sessionRows = await db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgA,
        agentId: agentRows[0]!.id,
        agentVersionId: versionRows[0]!.id,
        workflowId: wfA,
        origin: "webhook",
        principal: { workspaceId: orgA, source: "test" },
      })
      .returning({ id: schema.agentSessions.id });
    const agentRunRows = await db
      .insert(schema.runs)
      .values({
        mode: "agent",
        organizationId: null,
        workflowId: null,
        agentSessionId: sessionRows[0]!.id,
        status: "succeeded",
        triggerEvent: triggerEvent(orgA) as unknown as Record<string, unknown>,
        createdAt: new Date(now - 3_000),
      })
      .returning({ id: schema.runs.id });
    agentRun = agentRunRows[0]!.id;

    const foreignRows = await db
      .insert(schema.runs)
      .values({
        mode: "pipeline",
        organizationId: orgB,
        workflowId: wfB,
        agentSessionId: null,
        status: "succeeded",
        triggerEvent: triggerEvent(orgB) as unknown as Record<string, unknown>,
        createdAt: new Date(now - 500),
      })
      .returning({ id: schema.runs.id });
    foreignRun = foreignRows[0]!.id;

    // ── run_steps ledger on the newest pipeline run ─────────────────────────
    await db.insert(schema.runSteps).values([
      {
        id: newId("rs"),
        runId: pipelineRunNew,
        organizationId: orgA,
        stepId: toolStepId,
        stepSlug: "create",
        path: toolStepId,
        kind: "tool",
        status: "succeeded",
        attempt: 1,
        input: { args: { title: "Issue for hello" } },
        // Oversized output: the preview must cap at the shared byte budget.
        output: { text: "x".repeat(PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES + 512) },
        createdAt: new Date(now - 900),
      },
      {
        id: newId("rs"),
        runId: pipelineRunNew,
        organizationId: orgA,
        stepId: inferStepId,
        stepSlug: "summarize",
        path: inferStepId,
        kind: "infer",
        status: "failed",
        attempt: 2,
        errorClass: "validation_failed",
        error: "schema miss",
        createdAt: new Date(now - 800),
      },
    ]);

    // ── workflow state ──────────────────────────────────────────────────────
    await db.insert(schema.workflowState).values([
      { workflowId: wfA, organizationId: orgA, key: "cursor", value: "2026-08-30" },
      { workflowId: wfA, organizationId: orgA, key: "seen", value: [1, 2, 3] },
    ]);
  });

  afterAll(async () => {
    if (handle) {
      // Organization cascade removes workflows/state/agents/sessions/runs.
      for (const org of [orgA, orgB]) {
        await handle.db.delete(schema.organization).where(eq(schema.organization.id, org));
      }
      await handle.close();
    }
  });

  // ── runs list ──────────────────────────────────────────────────────────────

  test("runs list: both modes, newest first, wire-schema-conformant", async () => {
    const res = await api("GET", `/workspaces/${orgA}/workflows/${wfA}/runs`, {
      user: MEMBER,
      org: orgA,
    });
    expect(res.status).toBe(200);
    const parsed = listWorkflowRunsResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBeTrue();
    const runs = parsed.data!.runs;
    expect(runs.map((r) => r.id)).toEqual([pipelineRunNew, pipelineRunOld, agentRun]);
    expect(runs[0]).toMatchObject({
      mode: "pipeline",
      workflowId: wfA,
      agentSessionId: null,
      status: "succeeded",
    });
    // The historical agent-mode run reads null workflowId on the ROW (its
    // provenance lives on the session) and a non-null session id.
    expect(runs[2]!.mode).toBe("agent");
    expect(runs[2]!.workflowId).toBeNull();
    expect(runs[2]!.agentSessionId).not.toBeNull();
    // The foreign workflow's run never appears.
    expect(runs.some((r) => r.id === foreignRun)).toBeFalse();
  });

  test("runs list: status filter and limit clamp", async () => {
    const failed = await api(
      "GET",
      `/workspaces/${orgA}/workflows/${wfA}/runs?status=failed`,
      { user: MEMBER, org: orgA },
    );
    const failedRuns = ((await failed.json()) as { runs: { id: string }[] }).runs;
    expect(failedRuns.map((r) => r.id)).toEqual([pipelineRunOld]);

    const limited = await api(
      "GET",
      `/workspaces/${orgA}/workflows/${wfA}/runs?limit=1`,
      { user: MEMBER, org: orgA },
    );
    const limitedRuns = ((await limited.json()) as { runs: { id: string }[] }).runs;
    expect(limitedRuns.map((r) => r.id)).toEqual([pipelineRunNew]);
  });

  test("runs list authz: anonymous 401, outsider 403 on the path, foreign workflow 404", async () => {
    expect(
      (await api("GET", `/workspaces/${orgA}/workflows/${wfA}/runs`)).status,
    ).toBe(401);
    // Outsider's active org differs from the path workspace → IDOR guard 403.
    expect(
      (
        await api("GET", `/workspaces/${orgA}/workflows/${wfA}/runs`, {
          user: OUTSIDER,
          org: orgB,
        })
      ).status,
    ).toBe(403);
    // Same-path member addressing another org's workflow row → 404.
    const res = await api("GET", `/workspaces/${orgA}/workflows/${wfB}/runs`, {
      user: MEMBER,
      org: orgA,
    });
    expect(res.status).toBe(404);
  });

  // ── run steps ──────────────────────────────────────────────────────────────

  test("run steps: previews only by default, capped; ?full=1 adds snapshots", async () => {
    const res = await api("GET", `/runs/${pipelineRunNew}/steps`, {
      user: MEMBER,
      org: orgA,
    });
    expect(res.status).toBe(200);
    const parsed = listRunStepsResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBeTrue();
    const steps = parsed.data!.steps;
    expect(steps.map((s) => s.slug)).toEqual(["create", "summarize"]);
    expect(steps[0]!).toMatchObject({ kind: "tool", status: "succeeded", attempt: 1 });
    expect(steps[0]!.outputPreview!.length).toBeLessThanOrEqual(
      PIPELINE_STEP_OUTPUT_PREVIEW_MAX_BYTES,
    );
    expect("output" in steps[0]!).toBeFalse();
    expect("input" in steps[0]!).toBeFalse();
    expect(steps[1]!).toMatchObject({
      status: "failed",
      errorClass: "validation_failed",
      error: "schema miss",
      outputPreview: null,
    });

    const full = await api("GET", `/runs/${pipelineRunNew}/steps?full=1`, {
      user: MEMBER,
      org: orgA,
    });
    const fullSteps = ((await full.json()) as {
      steps: { input?: unknown; output?: unknown }[];
    }).steps;
    expect(fullSteps[0]!.input).toEqual({ args: { title: "Issue for hello" } });
    expect(fullSteps[0]!.output).toMatchObject({});
    expect(fullSteps[1]!.output).toBeNull();
  });

  test("run steps authz: agent-mode runs resolve through the session join; foreign/junk runs 404", async () => {
    // The COALESCE arm: this run's row has organization_id NULL.
    const viaSession = await api("GET", `/runs/${agentRun}/steps`, {
      user: MEMBER,
      org: orgA,
    });
    expect(viaSession.status).toBe(200);

    expect(
      (await api("GET", `/runs/${foreignRun}/steps`, { user: MEMBER, org: orgA })).status,
    ).toBe(404);
    expect(
      (await api("GET", `/runs/not-a-uuid/steps`, { user: MEMBER, org: orgA })).status,
    ).toBe(404);
    expect((await api("GET", `/runs/${pipelineRunNew}/steps`)).status).toBe(401);
  });

  // ── workflow state ─────────────────────────────────────────────────────────

  test("state: member reads entries ordered by key; DELETEs are admin-gated", async () => {
    const res = await api("GET", `/workspaces/${orgA}/workflows/${wfA}/state`, {
      user: MEMBER,
      org: orgA,
    });
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: { key: string; value: unknown }[];
    };
    expect(entries.map((e) => e.key)).toEqual(["cursor", "seen"]);
    expect(entries[0]!.value).toBe("2026-08-30");

    // Member cannot delete (operator surgery is owner/admin-gated)…
    expect(
      (
        await api("DELETE", `/workspaces/${orgA}/workflows/${wfA}/state/cursor`, {
          user: MEMBER,
          org: orgA,
        })
      ).status,
    ).toBe(403);

    // …admin deletes one key (idempotent: a second delete answers 0)…
    const delOne = await api(
      "DELETE",
      `/workspaces/${orgA}/workflows/${wfA}/state/cursor`,
      { user: ADMIN, org: orgA },
    );
    expect(delOne.status).toBe(200);
    expect(await delOne.json()).toEqual({ deletedKeys: 1 });
    const again = await api(
      "DELETE",
      `/workspaces/${orgA}/workflows/${wfA}/state/cursor`,
      { user: ADMIN, org: orgA },
    );
    expect(await again.json()).toEqual({ deletedKeys: 0 });

    // …and the bare DELETE clears the rest.
    const delAll = await api("DELETE", `/workspaces/${orgA}/workflows/${wfA}/state`, {
      user: ADMIN,
      org: orgA,
    });
    expect(await delAll.json()).toEqual({ deletedKeys: 1 });
    const after = await api("GET", `/workspaces/${orgA}/workflows/${wfA}/state`, {
      user: MEMBER,
      org: orgA,
    });
    expect(await after.json()).toEqual({ entries: [] });
  });

  test("state authz: anonymous 401, outsider 403, foreign workflow 404", async () => {
    expect(
      (await api("GET", `/workspaces/${orgA}/workflows/${wfA}/state`)).status,
    ).toBe(401);
    expect(
      (
        await api("GET", `/workspaces/${orgA}/workflows/${wfA}/state`, {
          user: OUTSIDER,
          org: orgB,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("GET", `/workspaces/${orgA}/workflows/${wfB}/state`, {
          user: MEMBER,
          org: orgA,
        })
      ).status,
    ).toBe(404);
  });

  // ── per-step test ──────────────────────────────────────────────────────────

  test("step test: renders input against the caller scope and maps the executor outcome", async () => {
    executed.length = 0;
    toolOutcome = { status: "succeeded", output: { id: "ISS-1" } };
    const res = await api(
      "POST",
      `/workspaces/${orgA}/workflows/${wfA}/steps/${toolStepId}/test`,
      {
        user: MEMBER,
        org: orgA,
        body: {
          scope: { trigger: { subject: "hello" }, state: { count: 4 } },
        },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestWorkflowStepResponse;
    expect(body).toMatchObject({
      status: "succeeded",
      input: { args: { title: "Issue for hello", count: 4 } },
      output: { id: "ISS-1" },
    });
    expect(executed).toHaveLength(1);
    const ctx = executed[0]!;
    expect(ctx.orgId).toBe(orgA);
    expect(ctx.run.workflowId).toBe(wfA);
    expect(ctx.attempt).toBe(1);
    expect(ctx.path).toBe(toolStepId);
    expect(ctx.scope.now).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A failed EXECUTION is the 200 payload's failed arm, not an HTTP error.
    toolOutcome = {
      status: "failed",
      errorClass: "tool_error",
      error: "server said no",
      retryable: false,
    };
    const failed = await api(
      "POST",
      `/workspaces/${orgA}/workflows/${wfA}/steps/${toolStepId}/test`,
      { user: MEMBER, org: orgA, body: {} },
    );
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      status: "failed",
      errorClass: "tool_error",
      error: "server said no",
    });
  });

  test("step test: infer steps render the prompt against @steps refs", async () => {
    executed.length = 0;
    const res = await api(
      "POST",
      `/workspaces/${orgA}/workflows/${wfA}/steps/${inferStepId}/test`,
      {
        user: MEMBER,
        org: orgA,
        body: { scope: { steps: { create: { text: "the issue body" } } } },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestWorkflowStepResponse;
    expect(body).toMatchObject({
      status: "succeeded",
      input: { prompt: "Summarize the issue body" },
      output: { text: "summarized" },
    });
  });

  test("step test refusals: unknown step 404, untestable kind 422, unparsable draft 422", async () => {
    const unknown = await api(
      "POST",
      `/workspaces/${orgA}/workflows/${wfA}/steps/${newStepId()}/test`,
      { user: MEMBER, org: orgA, body: {} },
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      "step_not_found",
    );

    const untestable = await api(
      "POST",
      `/workspaces/${orgA}/workflows/${wfA}/steps/${filterStepId}/test`,
      { user: MEMBER, org: orgA, body: {} },
    );
    expect(untestable.status).toBe(422);
    expect(((await untestable.json()) as { error: { code: string } }).error.code).toBe(
      "step_not_testable",
    );

    // wfB's draft is `{}` — not a parseable pipeline config.
    const invalid = await api(
      "POST",
      `/workspaces/${orgB}/workflows/${wfB}/steps/${toolStepId}/test`,
      { user: OUTSIDER, org: orgB, body: {} },
    );
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      "workflow_draft_invalid",
    );
  });

  test("step test authz: anonymous 401, outsider 403 on the path", async () => {
    expect(
      (
        await api(
          "POST",
          `/workspaces/${orgA}/workflows/${wfA}/steps/${toolStepId}/test`,
          { body: {} },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await api(
          "POST",
          `/workspaces/${orgA}/workflows/${wfA}/steps/${toolStepId}/test`,
          { user: OUTSIDER, org: orgB, body: {} },
        )
      ).status,
    ).toBe(403);
  });
});
