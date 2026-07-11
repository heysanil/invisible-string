/**
 * Workflows CRUD + publish hooks.
 *
 * Endpoint contract: packages/shared/src/api.ts "Workflows CRUD + publish".
 * Workflows have no builds — publish validates + snapshots instantly, and
 * validator diagnostics ride the GET/PATCH responses (no dry-run endpoint;
 * that lives on agents). All mutations keep the detail cache warm with the
 * server's returned row and invalidate the list.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createWorkflowResponseSchema,
  deleteResourceResponseSchema,
  getWorkflowResponseSchema,
  listWorkflowsResponseSchema,
  publishWorkflowResponseSchema,
  updateWorkflowResponseSchema,
  type CreateWorkflowRequest,
  type GetWorkflowResponse,
  type UpdateWorkflowRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

const basePath = (workspaceId: string) => `/workspaces/${workspaceId}/workflows`;

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchWorkflows(workspaceId: string, signal?: AbortSignal) {
  return api.get(basePath(workspaceId), listWorkflowsResponseSchema, { signal });
}

export function fetchWorkflow(
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(workspaceId)}/${workflowId}`,
    getWorkflowResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

/** Drop every workflows query (list + details) for a workspace. */
export function invalidateWorkflows(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.workflows.all(workspaceId),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useWorkflows(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workflows.list(workspaceId),
    queryFn: ({ signal }) => fetchWorkflows(workspaceId, signal),
    select: (data) => data.workflows,
    staleTime: 30_000,
  });
}

export function useWorkflow(workspaceId: string, workflowId: string) {
  return useQuery({
    queryKey: queryKeys.workflows.detail(workspaceId, workflowId),
    queryFn: ({ signal }) => fetchWorkflow(workspaceId, workflowId, signal),
    select: (data) => data.workflow,
    staleTime: 30_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

export function useCreateWorkflow(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkflowRequest) =>
      api.post(basePath(workspaceId), createWorkflowResponseSchema, {
        body: input,
      }),
    onSuccess: async (data) => {
      queryClient.setQueryData<GetWorkflowResponse>(
        queryKeys.workflows.detail(workspaceId, data.workflow.id),
        data,
      );
      await invalidateWorkflows(queryClient, workspaceId);
    },
  });
}

export function useUpdateWorkflow(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { workflowId: string; patch: UpdateWorkflowRequest }) =>
      api.patch(
        `${basePath(workspaceId)}/${input.workflowId}`,
        updateWorkflowResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      queryClient.setQueryData<GetWorkflowResponse>(
        queryKeys.workflows.detail(workspaceId, data.workflow.id),
        data,
      );
      await invalidateWorkflows(queryClient, workspaceId);
    },
  });
}

export function useDeleteWorkflow(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      api.delete(
        `${basePath(workspaceId)}/${workflowId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.workflows.detail(workspaceId, data.id),
      });
      await Promise.all([
        invalidateWorkflows(queryClient, workspaceId),
        // Sessions cascade with the workflow rows.
        queryClient.invalidateQueries({
          queryKey: queryKeys.sessions.all(workspaceId),
        }),
      ]);
    },
  });
}

/**
 * Publish the current draft: instant validate + snapshot (no build). The
 * response is the updated row with `published` freshly snapshotted.
 */
export function usePublishWorkflow(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      api.post(
        `${basePath(workspaceId)}/${workflowId}/publish`,
        publishWorkflowResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.setQueryData<GetWorkflowResponse>(
        queryKeys.workflows.detail(workspaceId, data.workflow.id),
        { workflow: data.workflow },
      );
      await invalidateWorkflows(queryClient, workspaceId);
    },
  });
}
