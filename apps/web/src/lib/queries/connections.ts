/**
 * Connection hooks (rebuilt connections domain, connectors redesign spec §3)
 * — BOTH scopes (workspace + user) behind one {@link ScopeRef}. One create
 * route covers all three sources (`catalog` | `registry` | `custom`);
 * credential writes travel in the request `auth` field and are encrypted
 * server-side — reads only ever carry `hasCredentials`.
 *
 * `useToggleConnection` is optimistic (a capsule switch must not lag): the
 * list cache flips immediately, rolls back on error, and reconciles on
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
  getConnectionResponseSchema,
  listConnectionsResponseSchema,
  type CreateConnectionRequest,
  type GetConnectionResponse,
  type ListConnectionsResponse,
  type UpdateConnectionRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys, scopeBasePath, type ScopeRef } from "./keys";

const basePath = (ref: ScopeRef) => scopeBasePath(ref, "connections");

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchConnections(ref: ScopeRef, signal?: AbortSignal) {
  return api.get(basePath(ref), listConnectionsResponseSchema, { signal });
}

export function fetchConnection(
  ref: ScopeRef,
  connectionId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(ref)}/${connectionId}`,
    getConnectionResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

export function invalidateConnections(
  queryClient: QueryClient,
  ref: ScopeRef,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.connections.all(ref),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useConnections(ref: ScopeRef) {
  return useQuery({
    queryKey: queryKeys.connections.list(ref),
    queryFn: ({ signal }) => fetchConnections(ref, signal),
    select: (data) => data.connections,
    staleTime: 60_000,
  });
}

export function useConnection(ref: ScopeRef, connectionId: string) {
  return useQuery({
    queryKey: queryKeys.connections.detail(ref, connectionId),
    queryFn: ({ signal }) => fetchConnection(ref, connectionId, signal),
    select: (data) => data.connection,
    staleTime: 60_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  ref: ScopeRef,
  data: GetConnectionResponse,
) {
  queryClient.setQueryData<GetConnectionResponse>(
    queryKeys.connections.detail(ref, data.connection.id),
    data,
  );
}

/** Create a connection — catalog install, registry install, or custom URL. */
export function useCreateConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConnectionRequest) =>
      api.post(basePath(ref), getConnectionResponseSchema, { body: input }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateConnections(queryClient, ref);
    },
  });
}

export function useUpdateConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      connectionId: string;
      patch: UpdateConnectionRequest;
    }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getConnectionResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateConnections(queryClient, ref);
    },
  });
}

export function useDeleteConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.delete(
        `${basePath(ref)}/${connectionId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.connections.detail(ref, data.id),
      });
      await invalidateConnections(queryClient, ref);
    },
  });
}

/** Optimistic enable/disable toggle. */
export function useToggleConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.connections.list(ref);
  return useMutation({
    mutationFn: (input: { connectionId: string; enabled: boolean }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getConnectionResponseSchema,
        { body: { enabled: input.enabled } },
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<ListConnectionsResponse>(listKey);
      queryClient.setQueryData<ListConnectionsResponse>(listKey, (current) =>
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
    onSettled: () => invalidateConnections(queryClient, ref),
  });
}
