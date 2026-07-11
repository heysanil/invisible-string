/**
 * Chat/agent session hooks (list, detail, create, follow-up message).
 *
 * `agent_sessions` are chat/eve sessions — NOT Better Auth login sessions.
 * One run at a time per session: a follow-up while a run is queued/running
 * answers 409 `session_busy` — surface it via
 * `isApiErrorCode(error, "session_busy")` (disable the composer, offer
 * retry); it is an expected state, not a crash.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createSessionResponseSchema,
  getSessionResponseSchema,
  listSessionsResponseSchema,
  postMessageResponseSchema,
  type GetSessionResponse,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys, type SessionListFilters } from "./keys";

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchSessions(
  workspaceId: string,
  filters: SessionListFilters = {},
  signal?: AbortSignal,
) {
  return api.get(`/workspaces/${workspaceId}/sessions`, listSessionsResponseSchema, {
    query: {
      agentId: filters.agentId,
      workflowId: filters.workflowId,
      status: filters.status,
    },
    signal,
  });
}

export function fetchSession(sessionId: string, signal?: AbortSignal) {
  return api.get(`/sessions/${sessionId}`, getSessionResponseSchema, { signal });
}

// ── invalidation ────────────────────────────────────────────────────────────

/** Drop every session list for a workspace (details are keyed by id). */
export function invalidateSessionLists(
  queryClient: QueryClient,
  workspaceId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.sessions.all(workspaceId),
  });
}

export function invalidateSession(
  queryClient: QueryClient,
  sessionId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.sessions.detail(sessionId),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useSessions(workspaceId: string, filters: SessionListFilters = {}) {
  return useQuery({
    queryKey: queryKeys.sessions.list(workspaceId, filters),
    queryFn: ({ signal }) => fetchSessions(workspaceId, filters, signal),
    select: (data) => data.sessions,
    // The chat list should feel current without hammering the API — live
    // updates within a thread come from the run SSE stream, not polling.
    staleTime: 10_000,
  });
}

export function useSession(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId),
    queryFn: ({ signal }) => fetchSession(sessionId, signal),
    staleTime: 5_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

/** Start a chat session on an agent's published version (first run). */
export function useCreateSession(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; message: string }) =>
      api.post(
        `/workspaces/${workspaceId}/agents/${input.agentId}/sessions`,
        createSessionResponseSchema,
        { body: { message: input.message } },
      ),
    onSuccess: async (data) => {
      // Seed the thread cache so navigation into it renders instantly.
      queryClient.setQueryData<GetSessionResponse>(
        queryKeys.sessions.detail(data.session.id),
        { session: data.session, runs: [data.run] },
      );
      await invalidateSessionLists(queryClient, workspaceId);
    },
  });
}

/** Follow-up message → new run in the same eve session (409 session_busy while one is active). */
export function usePostMessage(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; message: string }) =>
      api.post(`/sessions/${input.sessionId}/messages`, postMessageResponseSchema, {
        body: { message: input.message },
      }),
    onSuccess: async (data, input) => {
      // Append the accepted run immediately; SSE takes over from here.
      queryClient.setQueryData<GetSessionResponse>(
        queryKeys.sessions.detail(input.sessionId),
        (current) =>
          current === undefined
            ? current
            : { ...current, runs: [...current.runs, data.run] },
      );
      await invalidateSessionLists(queryClient, workspaceId);
    },
  });
}
