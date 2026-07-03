/**
 * Agent preset hooks (AGENT pillar; `/workspaces/:id/agents`).
 *
 * Deleting a preset that workflow drafts reference makes those drafts fail
 * publish with `agent_preset_not_found` — confirm destructive intent in the
 * UI before calling the delete mutation.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteResourceResponseSchema,
  getAgentPresetResponseSchema,
  listAgentPresetsResponseSchema,
  type CreateAgentPresetRequest,
  type GetAgentPresetResponse,
  type UpdateAgentPresetRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

const basePath = (workspaceId: string) => `/workspaces/${workspaceId}/agents`;

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchAgentPresets(workspaceId: string, signal?: AbortSignal) {
  return api.get(basePath(workspaceId), listAgentPresetsResponseSchema, {
    signal,
  });
}

export function fetchAgentPreset(
  workspaceId: string,
  agentId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(workspaceId)}/${agentId}`,
    getAgentPresetResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

export function invalidateAgentPresets(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.agentPresets.all(workspaceId),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useAgentPresets(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.agentPresets.list(workspaceId),
    queryFn: ({ signal }) => fetchAgentPresets(workspaceId, signal),
    select: (data) => data.agents,
    staleTime: 60_000,
  });
}

export function useAgentPreset(workspaceId: string, agentId: string) {
  return useQuery({
    queryKey: queryKeys.agentPresets.detail(workspaceId, agentId),
    queryFn: ({ signal }) => fetchAgentPreset(workspaceId, agentId, signal),
    select: (data) => data.agent,
    staleTime: 60_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  workspaceId: string,
  data: GetAgentPresetResponse,
) {
  queryClient.setQueryData<GetAgentPresetResponse>(
    queryKeys.agentPresets.detail(workspaceId, data.agent.id),
    data,
  );
}

export function useCreateAgentPreset(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentPresetRequest) =>
      api.post(basePath(workspaceId), getAgentPresetResponseSchema, {
        body: input,
      }),
    onSuccess: async (data) => {
      seedDetail(queryClient, workspaceId, data);
      await invalidateAgentPresets(queryClient, workspaceId);
    },
  });
}

export function useUpdateAgentPreset(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; patch: UpdateAgentPresetRequest }) =>
      api.patch(
        `${basePath(workspaceId)}/${input.agentId}`,
        getAgentPresetResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, workspaceId, data);
      await invalidateAgentPresets(queryClient, workspaceId);
    },
  });
}

export function useDeleteAgentPreset(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      api.delete(
        `${basePath(workspaceId)}/${agentId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.agentPresets.detail(workspaceId, data.id),
      });
      await invalidateAgentPresets(queryClient, workspaceId);
    },
  });
}
