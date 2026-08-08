/**
 * Chat/agent session hooks (list, detail, create, follow-up message, and the
 * eve 0.31 context controls).
 *
 * `agent_sessions` are chat/eve sessions — NOT Better Auth login sessions.
 *
 * TWO 409s with OPPOSITE recoveries ride these routes; branch on `code`,
 * never on the status:
 * - `SESSION_BUSY_ERROR_CODE` — TRANSIENT. One run (one NDJSON tail) at a
 *   time per session, and `waiting` counts as busy. Keep the draft, offer
 *   "try again once it finishes".
 * - `SESSION_NOT_ACTIVE_ERROR_CODE` — PERMANENT for this session. eve says
 *   the id is terminal/timed-out/RESET. Never offer a retry — offer a new
 *   chat. Collapsing the two makes the composer lie to the user.
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
  resetSessionResponseSchema,
  sessionContextControlResponseSchema,
  type GetSessionResponse,
  type ResetSessionResponse,
  type SessionContextControlResponse,
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

/**
 * Follow-up message → new run in the same ID-addressed eve session.
 *
 * Fails 409 `session_busy` while a run is active (retry later) or 409
 * `session_not_active` once eve has retired the id (never retry — start a new
 * chat). See the module header.
 */
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

// ── context controls (eve 0.31) ─────────────────────────────────────────────

/**
 * Clear or compact the agent's durable model history for a session.
 *
 * NON-DESTRUCTIVE: the session id survives, the thread keeps every run, and
 * only the agent's memory of them changes — so neither needs a confirm step.
 * The response is keyed on `status`, not the HTTP code: `no_active_session`
 * means eve had nothing live behind the id (the same terminal condition a
 * follow-up reports as 409 `session_not_active`), so it is NOT a silent
 * success — the caller must say so.
 */
function useSessionContextControl(
  workspaceId: string,
  control: "clear" | "compact",
) {
  const queryClient = useQueryClient();
  return useMutation<SessionContextControlResponse, Error, { sessionId: string }>({
    mutationFn: (input) =>
      api.post(
        `/sessions/${input.sessionId}/${control}`,
        sessionContextControlResponseSchema,
        { body: {} },
      ),
    onSuccess: async (_data, input) => {
      await Promise.all([
        invalidateSession(queryClient, input.sessionId),
        invalidateSessionLists(queryClient, workspaceId),
      ]);
    },
  });
}

export function useClearSessionContext(workspaceId: string) {
  return useSessionContextControl(workspaceId, "clear");
}

export function useCompactSessionContext(workspaceId: string) {
  return useSessionContextControl(workspaceId, "compact");
}

/**
 * Reset a session — DESTRUCTIVE, and the only control that changes identity.
 *
 * eve retires the session id permanently (it can never accept another
 * message), so the control plane mints a REPLACEMENT `agent_sessions` row and
 * returns both. The caller must switch its active session to
 * `data.session.id`; leaving the user on the retired row means every send
 * 409s `session_not_active` forever. The replacement's detail cache is seeded
 * here so the new thread renders instantly (empty, no runs yet).
 */
export function useResetSession(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    ResetSessionResponse,
    Error,
    { sessionId: string; reason?: string }
  >({
    mutationFn: (input) =>
      api.post(`/sessions/${input.sessionId}/reset`, resetSessionResponseSchema, {
        body: input.reason === undefined ? {} : { reason: input.reason },
      }),
    onSuccess: async (data, input) => {
      if (data.status === "reset") {
        queryClient.setQueryData<GetSessionResponse>(
          queryKeys.sessions.detail(data.session.id),
          { session: data.session, runs: [] },
        );
      }
      await Promise.all([
        invalidateSession(queryClient, input.sessionId),
        invalidateSessionLists(queryClient, workspaceId),
      ]);
    },
  });
}
