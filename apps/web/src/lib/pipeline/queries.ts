/**
 * Pipeline run queries — the Runs tab's data plane.
 *
 * Endpoint contracts: packages/shared/src/api.ts "PIPELINE RUNS".
 * - `GET /workspaces/:id/workflows/:wfId/runs` — run history (RunDto rows,
 *   newest first; there is deliberately NO `GET /runs/:id`, so a deep-linked
 *   run detail resolves its row from this list).
 * - `GET /runs/:runId/steps?full=1` — the `run_steps` ledger (ascending claim
 *   order) with capped input/output snapshots for the step drawer.
 * - `POST …/workflows/:wfId/steps/:stepId/test` — execute ONE draft step
 *   (tool + infer only) with REAL side effects; the editor's "Test step".
 */
import { useQuery } from "@tanstack/react-query";
import {
  isRunSettledStatus,
  listRunStepsResponseSchema,
  listWorkflowRunsResponseSchema,
  testWorkflowStepResponseSchema,
  type ListWorkflowRunsQuery,
  type RunStatus,
  type TestWorkflowStepRequest,
  type TestWorkflowStepResponse,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "../queries/keys";

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchWorkflowRuns(
  workspaceId: string,
  workflowId: string,
  query: ListWorkflowRunsQuery = {},
  signal?: AbortSignal,
) {
  const params: Record<string, string> = {};
  if (query.status !== undefined) params["status"] = query.status;
  if (query.limit !== undefined) params["limit"] = String(query.limit);
  return api.get(
    `/workspaces/${workspaceId}/workflows/${workflowId}/runs`,
    listWorkflowRunsResponseSchema,
    { signal, ...(Object.keys(params).length > 0 ? { query: params } : {}) },
  );
}

export function fetchRunSteps(runId: string, full: boolean, signal?: AbortSignal) {
  return api.get(`/runs/${runId}/steps`, listRunStepsResponseSchema, {
    signal,
    ...(full ? { query: { full: "1" } } : {}),
  });
}

/**
 * Execute one draft step against an empty (server-completed) scope. Side
 * effects are REAL — the calling surface owns saying so in its copy.
 */
export function testWorkflowStep(
  workspaceId: string,
  workflowId: string,
  stepId: string,
  body: TestWorkflowStepRequest = {},
): Promise<TestWorkflowStepResponse> {
  return api.post(
    `/workspaces/${workspaceId}/workflows/${workflowId}/steps/${stepId}/test`,
    testWorkflowStepResponseSchema,
    { body },
  );
}

// ── queries ─────────────────────────────────────────────────────────────────

export interface WorkflowRunFilters {
  status?: RunStatus;
  limit?: number;
}

export function useWorkflowRuns(
  workspaceId: string,
  workflowId: string,
  filters: WorkflowRunFilters = {},
) {
  return useQuery({
    queryKey: queryKeys.workflowRuns.list(workspaceId, workflowId, filters.status),
    queryFn: ({ signal }) =>
      fetchWorkflowRuns(workspaceId, workflowId, filters, signal),
    select: (data) => data.runs,
    // Live movement within a run rides its SSE stream; the list itself only
    // needs to feel current across visits, plus a gentle poll while any run
    // is still moving (a run's terminal flip has no push channel here).
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => !isRunSettledStatus(run.status))
        ? 5_000
        : false,
  });
}

export function useRunSteps(runId: string | null, { full = true } = {}) {
  return useQuery({
    queryKey: queryKeys.runSteps.detail(runId ?? "none", full),
    queryFn: ({ signal }) => fetchRunSteps(runId ?? "", full, signal),
    select: (data) => data.steps,
    enabled: runId !== null,
    staleTime: 5_000,
  });
}
