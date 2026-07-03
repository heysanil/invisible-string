/**
 * Integrations + trigger-binding hooks (Phase 3 triggers):
 * - Slack app install (full-page redirect to the control plane, which 302s to
 *   Slack consent), connected-team list, disconnect.
 * - Per-workflow trigger bindings: webhook/form ingress token minting (the
 *   plaintext token is returned ONCE — only its hash is stored), rotation, and
 *   pointing a Slack trigger at a connected team.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createWebhookTokenResponseSchema,
  deleteResourceResponseSchema,
  getTriggerBindingResponseSchema,
  listIntegrationsResponseSchema,
  listTriggerBindingsResponseSchema,
  type UpdateSlackTriggerBindingRequest,
} from "@invisible-string/shared";

import { api, API_BASE_URL } from "../api-client";
import { queryKeys } from "./keys";

// ── integrations ─────────────────────────────────────────────────────────────

const integrationsPath = (workspaceId: string) =>
  `/workspaces/${workspaceId}/integrations`;

export function fetchIntegrations(workspaceId: string, signal?: AbortSignal) {
  return api.get(integrationsPath(workspaceId), listIntegrationsResponseSchema, {
    signal,
  });
}

export function invalidateIntegrations(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.integrations.all(workspaceId),
  });
}

export function useIntegrations(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.integrations.list(workspaceId),
    queryFn: ({ signal }) => fetchIntegrations(workspaceId, signal),
    select: (data) => data.integrations,
    staleTime: 30_000,
  });
}

/**
 * The Slack install URL. A full-page navigation (not fetch) — the control
 * plane 302s to Slack consent and Slack redirects back to the callback. The
 * session cookie rides the top-level navigation.
 */
export function slackInstallUrl(workspaceId: string): string {
  return `${API_BASE_URL}/workspaces/${workspaceId}/integrations/slack/install`;
}

export function useDisconnectIntegration(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (integrationId: string) =>
      api.delete(
        `${integrationsPath(workspaceId)}/${integrationId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async () => {
      await invalidateIntegrations(queryClient, workspaceId);
    },
  });
}

// ── trigger bindings ─────────────────────────────────────────────────────────

const triggersPath = (workspaceId: string, workflowId: string) =>
  `/workspaces/${workspaceId}/workflows/${workflowId}/triggers`;

export function fetchTriggers(
  workspaceId: string,
  workflowId: string,
  signal?: AbortSignal,
) {
  return api.get(
    triggersPath(workspaceId, workflowId),
    listTriggerBindingsResponseSchema,
    { signal },
  );
}

export function invalidateTriggers(
  queryClient: QueryClient,
  workspaceId: string,
  workflowId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.triggers.all(workspaceId, workflowId),
  });
}

export function useTriggers(workspaceId: string, workflowId: string) {
  return useQuery({
    queryKey: queryKeys.triggers.list(workspaceId, workflowId),
    queryFn: ({ signal }) => fetchTriggers(workspaceId, workflowId, signal),
    select: (data) => data.triggers,
    staleTime: 30_000,
  });
}

/**
 * Mint (or rotate) the webhook/form ingress token. The response carries the
 * PLAINTEXT token ONCE — surface it immediately (copy-to-reveal) and warn it
 * won't be shown again; only its hash is stored server-side.
 */
export function useMintWebhookToken(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (triggerId?: string) =>
      api.post(
        triggerId
          ? `${triggersPath(workspaceId, workflowId)}/${triggerId}/rotate-token`
          : `${triggersPath(workspaceId, workflowId)}/webhook-token`,
        createWebhookTokenResponseSchema,
      ),
    onSuccess: async () => {
      await invalidateTriggers(queryClient, workspaceId, workflowId);
    },
  });
}

export function useBindSlackTrigger(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSlackTriggerBindingRequest) =>
      api.put(
        `${triggersPath(workspaceId, workflowId)}/slack`,
        getTriggerBindingResponseSchema,
        { body: input },
      ),
    onSuccess: async () => {
      await invalidateTriggers(queryClient, workspaceId, workflowId);
    },
  });
}
