/**
 * Model presets + allowlist hooks (workspace settings → models).
 *
 * Presets are the three seeded slugs (powerful/balanced/quick) and are
 * re-pointed with PUT — never created or deleted. Allowlist entries gate
 * which concrete models the builder offers AND what publish/dispatch accept
 * (`model_not_allowlisted`). The enabled toggle is optimistic.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteResourceResponseSchema,
  getModelAllowlistEntryResponseSchema,
  getModelPresetResponseSchema,
  listModelAllowlistResponseSchema,
  listModelCapabilitiesResponseSchema,
  listModelPresetsResponseSchema,
  type AddModelAllowlistEntryRequest,
  type ListModelAllowlistResponse,
  type ModelPresetSlug,
  type UpdateModelPresetRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

const presetsPath = (workspaceId: string) =>
  `/workspaces/${workspaceId}/model-presets`;
const allowlistPath = (workspaceId: string) =>
  `/workspaces/${workspaceId}/model-allowlist`;
const capabilitiesPath = (workspaceId: string) =>
  `/workspaces/${workspaceId}/model-capabilities`;

// ── model presets ───────────────────────────────────────────────────────────

export function fetchModelPresets(workspaceId: string, signal?: AbortSignal) {
  return api.get(presetsPath(workspaceId), listModelPresetsResponseSchema, {
    signal,
  });
}

export function invalidateModelPresets(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.modelPresets.list(workspaceId),
  });
}

export function useModelPresets(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.modelPresets.list(workspaceId),
    queryFn: ({ signal }) => fetchModelPresets(workspaceId, signal),
    select: (data) => data.presets,
    staleTime: 60_000,
  });
}

/** Re-point one preset slug at a provider+model (allowlist-checked server-side). */
export function useUpdateModelPreset(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { slug: ModelPresetSlug; patch: UpdateModelPresetRequest }) =>
      api.put(
        `${presetsPath(workspaceId)}/${input.slug}`,
        getModelPresetResponseSchema,
        { body: input.patch },
      ),
    onSuccess: () => invalidateModelPresets(queryClient, workspaceId),
  });
}

// ── model capabilities ──────────────────────────────────────────────────────

export function fetchModelCapabilities(
  workspaceId: string,
  signal?: AbortSignal,
) {
  return api.get(
    capabilitiesPath(workspaceId),
    listModelCapabilitiesResponseSchema,
    { signal },
  );
}

/**
 * What the OpenRouter catalog says about each enabled allowlist entry —
 * the source for the reasoning-effort selectors. FAIL-OPEN by contract: an
 * unreachable catalog answers `supportedEfforts: null` for every entry (never
 * an error), and callers must then offer the full vocabulary rather than an
 * empty selector. A query ERROR is treated the same way by consumers, which
 * read `data ?? null`.
 */
export function useModelCapabilities(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.modelCapabilities.list(workspaceId),
    queryFn: ({ signal }) => fetchModelCapabilities(workspaceId, signal),
    select: (data) => data.models,
    staleTime: 60_000,
  });
}

// ── model allowlist ─────────────────────────────────────────────────────────

export function fetchModelAllowlist(workspaceId: string, signal?: AbortSignal) {
  return api.get(allowlistPath(workspaceId), listModelAllowlistResponseSchema, {
    signal,
  });
}

/**
 * Capabilities are computed FROM the enabled allowlist entries, so every
 * allowlist write invalidates both — otherwise a freshly added model would
 * have no capability row for a full staleTime and its effort selector would
 * silently fall back to the whole vocabulary.
 */
export function invalidateModelAllowlist(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.modelAllowlist.list(workspaceId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.modelCapabilities.list(workspaceId),
    }),
  ]).then(() => undefined);
}

export function useModelAllowlist(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.modelAllowlist.list(workspaceId),
    queryFn: ({ signal }) => fetchModelAllowlist(workspaceId, signal),
    select: (data) => data.entries,
    staleTime: 60_000,
  });
}

export function useAddModelAllowlistEntry(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddModelAllowlistEntryRequest) =>
      api.post(allowlistPath(workspaceId), getModelAllowlistEntryResponseSchema, {
        body: input,
      }),
    onSuccess: () => invalidateModelAllowlist(queryClient, workspaceId),
  });
}

/** Optimistic enable/disable toggle. */
export function useToggleModelAllowlistEntry(workspaceId: string) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.modelAllowlist.list(workspaceId);
  return useMutation({
    mutationFn: (input: { entryId: string; enabled: boolean }) =>
      api.patch(
        `${allowlistPath(workspaceId)}/${input.entryId}`,
        getModelAllowlistEntryResponseSchema,
        { body: { enabled: input.enabled } },
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<ListModelAllowlistResponse>(listKey);
      queryClient.setQueryData<ListModelAllowlistResponse>(listKey, (current) =>
        current === undefined
          ? current
          : {
              entries: current.entries.map((entry) =>
                entry.id === input.entryId
                  ? { ...entry, enabled: input.enabled }
                  : entry,
              ),
            },
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => invalidateModelAllowlist(queryClient, workspaceId),
  });
}

export function useRemoveModelAllowlistEntry(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId: string) =>
      api.delete(
        `${allowlistPath(workspaceId)}/${entryId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: () => invalidateModelAllowlist(queryClient, workspaceId),
  });
}
