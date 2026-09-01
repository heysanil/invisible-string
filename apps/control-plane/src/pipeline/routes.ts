/**
 * Pipeline HTTP surface (workflow-pipelines redesign, API-surface section):
 * run history, the run_steps ledger, workflow state (operator cursor
 * surgery), and the per-step test route. Mounted from index.ts beside the
 * runtime plugin whenever the runtime is configured.
 *
 * Every route is workspace-scoped (`requireWorkspace` macro + row-ownership
 * predicates): workflow routes verify the row belongs to the caller's active
 * organization, and the run-steps route resolves the run's workspace through
 * `COALESCE(runs.organization_id, agent_sessions.organization_id)` — the
 * LEFT-join discipline the NOT-NULL relaxation on `runs.agent_session_id`
 * demands (an inner join would silently drop pipeline runs). All paths live
 * under the existing `/workspaces` and `/runs` prefixes the prod web gateway
 * (infra/nginx/web.conf) already enumerates — no new top-level prefix.
 *
 * Reads are member ops; state DELETEs are owner/admin-gated (destructive
 * operator surgery on live cursor semantics). The step test executes the
 * REAL tool/infer executor against a caller-supplied scope — side effects are
 * real, which the editor's UI copy owns saying; a failed EXECUTION is the 200
 * payload's `failed` arm, never an HTTP error.
 */
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { schema } from "@invisible-string/db";
import {
  buildStepOutputPreview,
  findStep,
  listWorkflowRunsQuerySchema,
  renderMarkdownTemplate,
  renderTemplateRecord,
  testWorkflowStepRequestSchema,
  workflowConfigSchema,
  type DeleteWorkflowStateResponse,
  type GetWorkflowStateResponse,
  type ListRunStepsResponse,
  type ListWorkflowRunsResponse,
  type Logger,
  type PipelineScope,
  type RunDto,
  type RunStepDetailDto,
  type TestWorkflowStepResponse,
  type TriggerEvent,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { parseBody } from "../resources/common";
import { errors, isRuntimeApiError, RuntimeApiError } from "../runtime/errors";
import { workspacePlugin, type WorkspaceDeps } from "../workspace";
import {
  DEFAULT_INFER_STEP_TIMEOUT_MS,
  DEFAULT_TOOL_STEP_TIMEOUT_MS,
} from "./runner";
import { executeInferStep } from "./steps/infer";
import { executeToolStep } from "./steps/tool";
import type { PipelineExecutorDeps, StepExecutor, StepOutcome } from "./types";

/** Page-size default for the runs list (the query may raise it to 200). */
const DEFAULT_RUNS_PAGE_SIZE = 50;

export interface PipelineRouteDeps {
  db: Db;
  workspaceDeps: WorkspaceDeps;
  /** Structured logger for the step-test route's unexpected-throw path. */
  logger: Logger;
  /**
   * Executor dependency graph for the per-step test route — the SAME shape
   * the runner hands its executors (guarded egress fetch, oauth broker,
   * provider keys), constructed once in index.ts.
   */
  executorDeps: PipelineExecutorDeps;
  /** Test seam: step-test executors by kind (default: the real tool/infer). */
  testExecutors?: { tool: StepExecutor; infer: StepExecutor };
}

type RunRow = typeof schema.runs.$inferSelect;
type RunStepRow = typeof schema.runSteps.$inferSelect;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run row → wire DTO, both modes. The chat surface's mapper lives in
 * runtime/routes.ts (`runDto`); this one is kept beside the pipeline routes
 * so the two surfaces can evolve independently — keep the field mapping in
 * lockstep with the shared `runDtoSchema`.
 */
function pipelineRunDto(row: RunRow): RunDto {
  return {
    id: row.id,
    mode: row.mode,
    agentSessionId: row.agentSessionId,
    workflowId: row.workflowId,
    status: row.status,
    triggerEvent: row.triggerEvent as unknown as TriggerEvent,
    taskMessage: row.taskMessage,
    deliveryStatus: row.deliveryStatus,
    eveRunId: row.eveRunId,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Ledger row → wire DTO. `full` additionally carries the capped snapshots. */
function runStepDto(row: RunStepRow, full: boolean): RunStepDetailDto {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    slug: row.stepSlug,
    kind: row.kind,
    status: row.status,
    path: row.path,
    parentPath: row.parentPath,
    iteration: row.iteration,
    attempt: row.attempt,
    errorClass: row.errorClass,
    error: row.error,
    childRunId: row.childRunId,
    outputPreview:
      row.output == null ? null : (buildStepOutputPreview(row.output) ?? null),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(full
      ? {
          ...(row.input === null || row.input === undefined
            ? {}
            : { input: row.input }),
          output: row.output ?? null,
        }
      : {}),
  };
}

/** Workspace-scoped workflow row (404 when unowned/unknown). */
async function loadWorkflowOwned(
  db: Db,
  organizationId: string,
  workflowId: string,
): Promise<typeof schema.workflows.$inferSelect> {
  if (!UUID_PATTERN.test(workflowId)) throw errors.workflowNotFound();
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.id, workflowId),
        eq(schema.workflows.organizationId, organizationId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw errors.workflowNotFound();
  return row;
}

export function pipelinePlugin(deps: PipelineRouteDeps) {
  const { db } = deps;
  const testExecutors = deps.testExecutors ?? {
    tool: executeToolStep,
    infer: executeInferStep,
  };

  /** COALESCE org predicate: pipeline runs carry their own org; agent-mode
   *  rows written before the column joined derive it from their session. */
  const runOrgIs = (organizationId: string) =>
    sql`coalesce(${schema.runs.organizationId}, ${schema.agentSessions.organizationId}) = ${organizationId}`;

  return (
    new Elysia({ name: "pipeline" })
      .use(workspacePlugin(deps.workspaceDeps))
      .onError(({ error, set }) => {
        if (isRuntimeApiError(error)) {
          set.status = error.status;
          return error.toBody();
        }
        return undefined;
      })

      // ── run history for one workflow (the Runs tab list) ──────────────────
      //
      // Both modes: pipeline runs carry `workflow_id` on the row; historical
      // agent-mode runs join through their session's provenance.
      .get(
        "/workspaces/:workspaceId/workflows/:wfId/runs",
        async ({ workspace, params, query }): Promise<ListWorkflowRunsResponse> => {
          const organizationId = workspace.organizationId;
          const workflow = await loadWorkflowOwned(db, organizationId, params.wfId);
          const parsed = parseBody(listWorkflowRunsQuerySchema, query);
          const limit = parsed.limit ?? DEFAULT_RUNS_PAGE_SIZE;
          const rows = await db
            .select({ run: schema.runs })
            .from(schema.runs)
            .leftJoin(
              schema.agentSessions,
              eq(schema.runs.agentSessionId, schema.agentSessions.id),
            )
            .where(
              and(
                runOrgIs(organizationId),
                or(
                  eq(schema.runs.workflowId, workflow.id),
                  eq(schema.agentSessions.workflowId, workflow.id),
                ),
                ...(parsed.status ? [eq(schema.runs.status, parsed.status)] : []),
              ),
            )
            .orderBy(desc(schema.runs.createdAt))
            .limit(limit);
          return { runs: rows.map(({ run }) => pipelineRunDto(run)) };
        },
        { requireWorkspace: true },
      )

      // ── run_steps ledger for one run ──────────────────────────────────────
      //
      // Previews only by default; `?full=1` adds the capped input/output
      // snapshots for the step drawer. Ordered by claim time (= execution
      // order; ids break sub-millisecond ties deterministically).
      .get(
        "/runs/:runId/steps",
        async ({ workspace, params, query }): Promise<ListRunStepsResponse> => {
          const organizationId = workspace.organizationId;
          if (!UUID_PATTERN.test(params.runId)) throw errors.runNotFound();
          const runRows = await db
            .select({ id: schema.runs.id })
            .from(schema.runs)
            .leftJoin(
              schema.agentSessions,
              eq(schema.runs.agentSessionId, schema.agentSessions.id),
            )
            .where(and(eq(schema.runs.id, params.runId), runOrgIs(organizationId)))
            .limit(1);
          if (!runRows[0]) throw errors.runNotFound();
          const full = query.full === "1";
          const rows = await db
            .select()
            .from(schema.runSteps)
            .where(eq(schema.runSteps.runId, params.runId))
            .orderBy(asc(schema.runSteps.createdAt), asc(schema.runSteps.id));
          return { steps: rows.map((row) => runStepDto(row, full)) };
        },
        { requireWorkspace: true },
      )

      // ── workflow state (read) ─────────────────────────────────────────────
      .get(
        "/workspaces/:workspaceId/workflows/:wfId/state",
        async ({ workspace, params }): Promise<GetWorkflowStateResponse> => {
          const workflow = await loadWorkflowOwned(
            db,
            workspace.organizationId,
            params.wfId,
          );
          const rows = await db
            .select()
            .from(schema.workflowState)
            .where(eq(schema.workflowState.workflowId, workflow.id))
            .orderBy(asc(schema.workflowState.key));
          return {
            entries: rows.map((row) => ({
              key: row.key,
              value: row.value,
              updatedByRunId: row.updatedByRunId,
              updatedAt: row.updatedAt.toISOString(),
            })),
          };
        },
        { requireWorkspace: true },
      )

      // ── workflow state (clear all) — operator cursor surgery ──────────────
      .delete(
        "/workspaces/:workspaceId/workflows/:wfId/state",
        async ({ workspace, params }): Promise<DeleteWorkflowStateResponse> => {
          const workflow = await loadWorkflowOwned(
            db,
            workspace.organizationId,
            params.wfId,
          );
          const deleted = await db
            .delete(schema.workflowState)
            .where(eq(schema.workflowState.workflowId, workflow.id))
            .returning({ key: schema.workflowState.key });
          return { deletedKeys: deleted.length };
        },
        { requireWorkspace: "admin" },
      )

      // ── workflow state (delete one key) ───────────────────────────────────
      //
      // Deleting a missing key answers `deletedKeys: 0`, not an error — the
      // desired state is "gone" either way.
      .delete(
        "/workspaces/:workspaceId/workflows/:wfId/state/:key",
        async ({ workspace, params }): Promise<DeleteWorkflowStateResponse> => {
          const workflow = await loadWorkflowOwned(
            db,
            workspace.organizationId,
            params.wfId,
          );
          const deleted = await db
            .delete(schema.workflowState)
            .where(
              and(
                eq(schema.workflowState.workflowId, workflow.id),
                eq(schema.workflowState.key, decodeURIComponent(params.key)),
              ),
            )
            .returning({ key: schema.workflowState.key });
          return { deletedKeys: deleted.length };
        },
        { requireWorkspace: "admin" },
      )

      // ── per-step test (tool + infer) ──────────────────────────────────────
      //
      // Renders the DRAFT step's input against a caller-supplied partial
      // scope (`now` minted server-side) exactly the way the runner would,
      // then executes the real executor — no run row, no ledger claim.
      .post(
        "/workspaces/:workspaceId/workflows/:wfId/steps/:stepId/test",
        async ({ workspace, params, body }): Promise<TestWorkflowStepResponse> => {
          const organizationId = workspace.organizationId;
          const request = parseBody(testWorkflowStepRequestSchema, body ?? {});
          const workflow = await loadWorkflowOwned(db, organizationId, params.wfId);
          const parsed = workflowConfigSchema.safeParse(workflow.draft);
          if (!parsed.success) {
            throw new RuntimeApiError(
              422,
              "workflow_draft_invalid",
              "workflow draft does not parse as a pipeline config — fix the draft before testing steps",
              { issues: parsed.error.issues },
            );
          }
          const step = findStep(parsed.data.steps, params.stepId);
          if (!step) {
            throw new RuntimeApiError(
              404,
              "step_not_found",
              "no step with that id in the workflow draft",
            );
          }
          if (step.kind !== "tool" && step.kind !== "infer") {
            throw new RuntimeApiError(
              422,
              "step_not_testable",
              `only tool and infer steps are testable (got "${step.kind}")`,
            );
          }

          const scope: PipelineScope = {
            trigger: request.scope?.trigger ?? {},
            steps: request.scope?.steps ?? {},
            state: request.scope?.state ?? {},
            ...(request.scope?.item !== undefined
              ? { item: request.scope.item }
              : {}),
            now: new Date().toISOString(),
          };
          // The DECREED rendered-input shapes the executors validate
          // (toolStepRenderedInputSchema / inferStepRenderedInputSchema) —
          // mirrors the runner's own leaf rendering.
          const input =
            step.kind === "tool"
              ? { args: renderTemplateRecord(step.args, scope) }
              : { prompt: renderMarkdownTemplate(step.prompt.markdown, scope) };
          const timeoutMs =
            step.kind === "tool"
              ? (step.timeoutMs ?? DEFAULT_TOOL_STEP_TIMEOUT_MS)
              : DEFAULT_INFER_STEP_TIMEOUT_MS;

          const startedAt = Date.now();
          let outcome: StepOutcome;
          try {
            outcome = await testExecutors[step.kind]({
              deps: deps.executorDeps,
              orgId: organizationId,
              run: { id: `test_${step.id}`, workflowId: workflow.id },
              step,
              input,
              scope,
              signal: AbortSignal.timeout(timeoutMs),
              attempt: 1,
              path: step.id,
            });
          } catch (error) {
            // Executors classify their own failures; a throw is a bug. The
            // raw message never reaches the wire (it bypassed the executor's
            // scrubbing discipline).
            deps.logger.warn("pipeline.step_test_threw", {
              workspaceId: organizationId,
              err: error instanceof Error ? error : new Error(String(error)),
              fields: { workflowId: workflow.id, stepId: step.id, kind: step.kind },
            });
            outcome = {
              status: "failed",
              errorClass: "executor_error",
              error: "step executor threw unexpectedly — see server logs",
              retryable: false,
            };
          }
          const durationMs = Date.now() - startedAt;

          if (outcome.status === "succeeded") {
            return { status: "succeeded", input, output: outcome.output, durationMs };
          }
          if (outcome.status === "failed") {
            return {
              status: "failed",
              input,
              errorClass: outcome.errorClass,
              error: outcome.error,
              durationMs,
            };
          }
          // Unreachable for tool/infer — neither parks on a child run.
          return {
            status: "failed",
            input,
            errorClass: "internal",
            error: "step executor parked waiting — not possible for tool/infer steps",
            durationMs,
          };
        },
        { requireWorkspace: true },
      )
  );
}
