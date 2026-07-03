/**
 * MCP connection hooks — BOTH scopes (workspace + user) behind one
 * {@link ScopeRef}. Credential writes travel in the request `auth` field and
 * are encrypted server-side; reads only ever carry `hasCredentials`.
 *
 * `useToggleMcpConnection` is optimistic (a capsule switch must not lag):
 * the list cache flips immediately, rolls back on error, and reconciles on
 * settle.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  deleteResourceResponseSchema,
  getMcpConnectionResponseSchema,
  listMcpConnectionsResponseSchema,
  type CreateMcpConnectionRequest,
  type GetMcpConnectionResponse,
  type InstallMcpConnectionRequest,
  type ListMcpConnectionsResponse,
  type UpdateMcpConnectionRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys, scopeBasePath, type ScopeRef } from "./keys";

const basePath = (ref: ScopeRef) => scopeBasePath(ref, "mcp-connections");

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchMcpConnections(ref: ScopeRef, signal?: AbortSignal) {
  return api.get(basePath(ref), listMcpConnectionsResponseSchema, { signal });
}

export function fetchMcpConnection(
  ref: ScopeRef,
  connectionId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(ref)}/${connectionId}`,
    getMcpConnectionResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

export function invalidateMcpConnections(
  queryClient: QueryClient,
  ref: ScopeRef,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.mcpConnections.all(ref),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useMcpConnections(ref: ScopeRef) {
  return useQuery({
    queryKey: queryKeys.mcpConnections.list(ref),
    queryFn: ({ signal }) => fetchMcpConnections(ref, signal),
    select: (data) => data.connections,
    staleTime: 60_000,
  });
}

export function useMcpConnection(ref: ScopeRef, connectionId: string) {
  return useQuery({
    queryKey: queryKeys.mcpConnections.detail(ref, connectionId),
    queryFn: ({ signal }) => fetchMcpConnection(ref, connectionId, signal),
    select: (data) => data.connection,
    staleTime: 60_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  ref: ScopeRef,
  data: GetMcpConnectionResponse,
) {
  queryClient.setQueryData<GetMcpConnectionResponse>(
    queryKeys.mcpConnections.detail(ref, data.connection.id),
    data,
  );
}

/** Add a custom-URL MCP server. */
export function useCreateMcpConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMcpConnectionRequest) =>
      api.post(basePath(ref), getMcpConnectionResponseSchema, { body: input }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateMcpConnections(queryClient, ref);
    },
  });
}

/** Install a registry server (chosen remote + prompted secrets). */
export function useInstallMcpConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: InstallMcpConnectionRequest) =>
      api.post(`${basePath(ref)}/install`, getMcpConnectionResponseSchema, {
        body: input,
      }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateMcpConnections(queryClient, ref);
    },
  });
}

export function useUpdateMcpConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      connectionId: string;
      patch: UpdateMcpConnectionRequest;
    }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getMcpConnectionResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateMcpConnections(queryClient, ref);
    },
  });
}

export function useDeleteMcpConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.delete(
        `${basePath(ref)}/${connectionId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.mcpConnections.detail(ref, data.id),
      });
      await invalidateMcpConnections(queryClient, ref);
    },
  });
}

/** Optimistic enable/disable toggle. */
export function useToggleMcpConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.mcpConnections.list(ref);
  return useMutation({
    mutationFn: (input: { connectionId: string; enabled: boolean }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getMcpConnectionResponseSchema,
        { body: { enabled: input.enabled } },
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<ListMcpConnectionsResponse>(listKey);
      queryClient.setQueryData<ListMcpConnectionsResponse>(listKey, (current) =>
        current === undefined
          ? current
          : {
              connections: current.connections.map((connection) =>
                connection.id === input.connectionId
                  ? { ...connection, enabled: input.enabled }
                  : connection,
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
    onSettled: () => invalidateMcpConnections(queryClient, ref),
  });
}
