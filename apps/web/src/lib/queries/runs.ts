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
  runInputResponseSchema,
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
