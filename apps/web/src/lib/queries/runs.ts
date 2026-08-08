/**
 * Run mutations — the HITL input round-trip.
 *
 * `POST /runs/:id/input` answers an `input.requested` frame (approval card /
 * question) with exactly one of {optionId} or {text}. On success the parked
 * run resumes server-side; the caller should re-open the run's SSE stream
 * (lib/sse.ts resumes seamlessly via Last-Event-ID).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  runCancelResponseSchema,
  runInputResponseSchema,
  type RunCancelRequest,
  type RunInputRequest,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { invalidateSession, invalidateSessionLists } from "./sessions";

export function usePostRunInput(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { runId: string; input: RunInputRequest }) =>
      api.post(`/runs/${variables.runId}/input`, runInputResponseSchema, {
        body: variables.input,
      }),
    onSuccess: async (data) => {
      await Promise.all([
        invalidateSession(queryClient, data.run.agentSessionId),
        invalidateSessionLists(queryClient, workspaceId),
      ]);
    },
  });
}

/**
 * Stop an in-flight run — the Stop button (`POST /runs/:id/cancel`, which now
 * fronts eve's real `POST /eve/v1/session/:id/cancel`). Idempotent for
 * already-terminal runs.
 *
 * eve 0.31 semantics the UI depends on:
 * - Cancellation is a USER DECISION, NEVER AN ERROR. The turn ends with
 *   `turn.cancelled` → `session.waiting` and emits NO failure event, so the
 *   run settles `canceled` and must never render as failed.
 * - It is cooperative, at durable step boundaries: a tool call already in
 *   flight runs to completion and still lands its `action.result`. "Stop"
 *   therefore cannot undo a side effect already underway — the UI copy says
 *   so rather than promising an instant halt.
 * - The SESSION stays usable afterwards; the next message just continues.
 */
export function useCancelRun(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { runId: string; reason?: string }) =>
      api.post(`/runs/${variables.runId}/cancel`, runCancelResponseSchema, {
        body: variables.reason ? ({ reason: variables.reason } satisfies RunCancelRequest) : {},
      }),
    onSuccess: async (data) => {
      await Promise.all([
        invalidateSession(queryClient, data.run.agentSessionId),
        invalidateSessionLists(queryClient, workspaceId),
      ]);
    },
  });
}
