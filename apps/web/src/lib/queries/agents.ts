/**
 * Agent hooks (`/workspaces/:id/agents`): CRUD, publish, build-status poll,
 * dry-run compile.
 *
 * Endpoint contract: packages/shared/src/api.ts "Agents CRUD" + the agent
 * publish/build/dry-run/session sections. All mutations keep the detail
 * cache warm with the server's returned row and invalidate the list.
 *
 * Deleting an agent referenced by workflows or sessions answers 409
 * `agent_in_use` — confirm destructive intent in the UI before calling the
 * delete mutation.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  buildStatusResponseSchema,
  createAgentResponseSchema,
  deleteResourceResponseSchema,
  dryRunCompileResponseSchema,
  getAgentResponseSchema,
  listAgentsResponseSchema,
  publishAgentResponseSchema,
  updateAgentResponseSchema,
  type BuildStatusResponse,
  type CreateAgentRequest,
  type GetAgentResponse,
  type UpdateAgentRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

const basePath = (workspaceId: string) => `/workspaces/${workspaceId}/agents`;

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchAgents(workspaceId: string, signal?: AbortSignal) {
  return api.get(basePath(workspaceId), listAgentsResponseSchema, { signal });
}

export function fetchAgent(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(workspaceId)}/${agentId}`,
    getAgentResponseSchema,
    { signal },
  );
}

/** One-shot build-status poll for a version (editor polls after publish). */
export function fetchAgentBuildStatus(
  workspaceId: string,
  agentId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<BuildStatusResponse> {
  return api.get(
    `${basePath(workspaceId)}/${agentId}/versions/${versionId}/build`,
    buildStatusResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

/** Drop every agents query (list + details) for a workspace. */
export function invalidateAgents(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.agents.all(workspaceId),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useAgents(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.agents.list(workspaceId),
    queryFn: ({ signal }) => fetchAgents(workspaceId, signal),
    select: (data) => data.agents,
    staleTime: 30_000,
  });
}

export function useAgent(workspaceId: string, agentId: string) {
  return useQuery({
    queryKey: queryKeys.agents.detail(workspaceId, agentId),
    queryFn: ({ signal }) => fetchAgent(workspaceId, agentId, signal),
    select: (data) => data.agent,
    staleTime: 30_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  workspaceId: string,
  data: GetAgentResponse,
) {
  queryClient.setQueryData<GetAgentResponse>(
    queryKeys.agents.detail(workspaceId, data.agent.id),
    { agent: data.agent },
  );
}

export function useCreateAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentRequest) =>
      api.post(basePath(workspaceId), createAgentResponseSchema, {
        body: input,
      }),
    onSuccess: async (data) => {
      seedDetail(queryClient, workspaceId, data);
      await invalidateAgents(queryClient, workspaceId);
    },
  });
}

/**
 * PATCH the agent row. When the patch touched the draft, the response
 * additionally carries dry-run-compile `diagnostics` — the editor consumes
 * them instead of a second round-trip.
 */
export function useUpdateAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; patch: UpdateAgentRequest }) =>
      api.patch(
        `${basePath(workspaceId)}/${input.agentId}`,
        updateAgentResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, workspaceId, data);
      await invalidateAgents(queryClient, workspaceId);
    },
  });
}

export function useDeleteAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api.delete(
        `${basePath(workspaceId)}/${agentId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.agents.detail(workspaceId, data.id),
      });
      await invalidateAgents(queryClient, workspaceId);
    },
  });
}

/**
 * Publish the current draft (idempotent by content hash). The response's
 * `buildStatus` may be non-terminal — poll {@link fetchAgentBuildStatus}
 * until it settles (the agent controller owns that loop).
 */
export function usePublishAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api.post(
        `${basePath(workspaceId)}/${agentId}/publish`,
        publishAgentResponseSchema,
      ),
    // publishedVersionId/buildStatus changed on the summary row.
    onSuccess: () => invalidateAgents(queryClient, workspaceId),
  });
}

/**
 * Dry-run compile of the SAVED draft (no rows written). Compile problems are
 * returned as `{ok: false, error}` payloads — the editor renders them
 * inline, they are not thrown.
 */
export function useDryRunCompileAgent(workspaceId: string) {
  return useMutation({
    mutationFn: (agentId: string) =>
      api.post(
        `${basePath(workspaceId)}/${agentId}/dry-run-compile`,
        dryRunCompileResponseSchema,
      ),
  });
}
