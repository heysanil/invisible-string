/**
 * Live thread container: joins the fetched session (`GET /sessions/:id`, the
 * run rows) with the per-run SSE streams (history replay + live tail), folds
 * each run into a {@link RunView}, and wires the composer + HITL round-trips.
 *
 * Reconciliation: run ROWS come from the query; run EVENTS come only from the
 * streams (the server replays persisted events on connect). seq is
 * authoritative, so a re-delivered frame after a resume is a no-op.
 */
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";

import type {
  RunInputRequest,
  RunStatus,
} from "@invisible-string/shared";

import { isApiErrorCode } from "../../lib/api-client";
import { reduceRunView, type RunView } from "../../lib/chat/run-view";
import { useThreadStreams } from "../../lib/chat/use-thread-streams";
import { titleFromMessage } from "../../lib/chat/time";
import { errorMessage } from "../../lib/forms";
import {
  invalidateSessionLists,
  usePostMessage,
  usePostRunInput,
  useSession,
} from "../../lib/queries";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { ThreadView } from "./ThreadView";
import type { ThreadHeaderProps } from "./ThreadHeader";

export interface ThreadContainerProps {
  workspaceId: string;
  sessionId: string;
  /** From the session list (detail DTO doesn't carry it). */
  workflowName?: string;
}

interface PendingInput {
  runId: string;
  requestId: string;
  optionId?: string;
  text?: string;
}

function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export function ThreadContainer({
  workspaceId,
  sessionId,
  workflowName,
}: ThreadContainerProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useSession(sessionId);
  const postMessage = usePostMessage(workspaceId);
  const postInput = usePostRunInput(workspaceId);

  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [failedDraft, setFailedDraft] = useState<string | undefined>(undefined);
  const [busyNotice, setBusyNotice] = useState<string | null>(null);

  const runRows = useMemo(() => data?.runs ?? [], [data?.runs]);

  const onRunStatus = useCallback(
    (_runId: string, _status: RunStatus) => {
      void invalidateSessionLists(queryClient, workspaceId);
    },
    [queryClient, workspaceId],
  );

  const streams = useThreadStreams(runRows, { onRunStatus });

  // Fold each run row + its live frames into a view model.
  const runViews: RunView[] = useMemo(
    () =>
      runRows.map((run) => {
        const live = streams.runs.get(run.id);
        return reduceRunView(
          run,
          live?.store ?? { frames: [], maxSeq: -1 },
          live?.status ?? undefined,
        );
      }),
    [runRows, streams.runs],
  );

  const lastRun = runViews[runViews.length - 1];
  const anyActive = runViews.some((run) => isActiveStatus(run.status));
  const awaitingApproval = lastRun?.status === "waiting";
  const modelId =
    [...runViews].reverse().find((run) => run.modelId !== null)?.modelId ?? null;

  const send = useCallback(
    (message: string) => {
      setBusyNotice(null);
      postMessage.mutate(
        { sessionId, message },
        {
          onError: (mutationError) => {
            if (isApiErrorCode(mutationError, "session_busy")) {
              setFailedDraft(message);
              setBusyNotice(
                "This session is still working. Your message will be kept — try again once it finishes.",
              );
            } else {
              setFailedDraft(message);
              setBusyNotice(errorMessage(mutationError));
            }
          },
          onSuccess: () => {
            setFailedDraft(undefined);
            setBusyNotice(null);
          },
        },
      );
    },
    [postMessage, sessionId],
  );

  const respond = useCallback(
    (runId: string, response: RunInputRequest) => {
      setInputError(null);
      setPendingInput({
        runId,
        requestId: response.requestId,
        optionId: response.optionId,
        text: response.text,
      });
      postInput.mutate(
        { runId, input: response },
        {
          onSuccess: () => {
            setPendingInput(null);
            // The parked run resumes server-side — re-attach its tail
            // (resumes from the cursor, nothing replays twice).
            streams.reopen(runId);
          },
          onError: (mutationError) => {
            setInputError(errorMessage(mutationError));
            setPendingInput(null);
          },
        },
      );
    },
    [postInput, streams],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} className="text-ink-4" />
      </div>
    );
  }

  if (isError || data === undefined) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Couldn’t load this conversation"
        description={errorMessage(error, "The session may have been deleted.")}
      />
    );
  }

  const { session } = data;
  const title = titleFromMessage(runRows[0]?.triggerEvent.message ?? "");
  const versionLabel = shortId(session.workflowVersionId);

  const header: ThreadHeaderProps = {
    title,
    workflowName: workflowName ?? "Workflow",
    workflowId: session.workflowId,
    versionLabel,
    modelId,
    sessionStatus: session.status,
    lastRunStatus: lastRun?.status ?? null,
  };

  const composerDisabledReason = anyActive
    ? "Working… you can send a follow-up when this run finishes."
    : awaitingApproval
      ? "Waiting for your approval above."
      : busyNotice;

  return (
    <ThreadView
      header={header}
      runs={runViews}
      isChatOrigin={session.origin === "chat"}
      onRespond={respond}
      pendingInput={pendingInput}
      inputError={inputError}
      onSend={send}
      composerDisabledReason={composerDisabledReason ?? null}
      sending={postMessage.isPending}
      failedDraft={failedDraft}
    />
  );
}

function shortId(id: string): string | null {
  if (id.length === 0) return null;
  const tail = id.replace(/^.*[_-]/, "");
  return tail.length > 8 ? tail.slice(0, 8) : tail;
}
