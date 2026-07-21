/**
 * Live thread container: joins the fetched session (`GET /sessions/:id`, the
 * run rows) with the per-run SSE streams (history replay + live tail), folds
 * each run into a {@link RunView}, and wires the composer + HITL round-trips.
 *
 * Reconciliation: run ROWS come from the query; run EVENTS come only from the
 * streams (the server replays persisted events on connect). seq is
 * authoritative, so a re-delivered frame after a resume is a no-op.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";

import type {
  RunDto,
  RunInputRequest,
  RunStatus,
} from "@invisible-string/shared";

import { isApiErrorCode } from "../../lib/api-client";
import {
  EMPTY_FRAME_STORE,
  reduceRunView,
  type FrameStore,
  type RunView,
} from "../../lib/chat/run-view";
import { useThreadStreams } from "../../lib/chat/use-thread-streams";
import { titleFromMessage } from "../../lib/chat/time";
import { errorMessage } from "../../lib/forms";
import {
  invalidateSessionLists,
  useCancelRun,
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
  /** From the session list (the detail DTO doesn't carry names). */
  agentName?: string;
  /** Workflow provenance for trigger-origin sessions (null for direct chat). */
  workflowName?: string | null;
}

interface PendingInput {
  runId: string;
  requestId: string;
  optionId?: string;
  text?: string;
}

/** Per-run memo entry: reuse the RunView when its inputs are reference-equal. */
interface RunViewCacheEntry {
  run: RunDto;
  store: FrameStore;
  status: RunStatus | undefined;
  view: RunView;
}

function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export function ThreadContainer({
  workspaceId,
  sessionId,
  agentName,
  workflowName,
}: ThreadContainerProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useSession(sessionId);
  const postMessage = usePostMessage(workspaceId);
  const postInput = usePostRunInput(workspaceId);
  const cancelRun = useCancelRun(workspaceId);

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

  // Fold each run row + its live frames into a view model. A streamed token
  // grows exactly ONE run's frame store (the others keep their reference), so
  // we memoize per run: only the run that received a frame gets a fresh
  // RunView. Combined with a memoized RunMessage this stops every settled row
  // from re-reducing/repainting on each token of the newest run.
  const viewCacheRef = useRef(new Map<string, RunViewCacheEntry>());
  const runViews: RunView[] = useMemo(() => {
    const nextCache = new Map<string, RunViewCacheEntry>();
    const views = runRows.map((run) => {
      const live = streams.runs.get(run.id);
      const store = live?.store ?? EMPTY_FRAME_STORE;
      const status = live?.status ?? undefined;
      const prev = viewCacheRef.current.get(run.id);
      if (prev && prev.run === run && prev.store === store && prev.status === status) {
        nextCache.set(run.id, prev);
        return prev.view;
      }
      const view = reduceRunView(run, store, status);
      nextCache.set(run.id, { run, store, status, view });
      return view;
    });
    viewCacheRef.current = nextCache;
    return views;
  }, [runRows, streams.runs]);

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

  // Depend on the STABLE pieces (react-query's bound mutate + the reopen
  // useCallback), not the freshly-allocated `streams`/`postInput` wrappers, so
  // `respond` keeps a stable identity across streamed frames — otherwise the
  // memoized RunMessage rows would see a new onRespond every token and repaint.
  const postInputMutate = postInput.mutate;
  const reopenStream = streams.reopen;
  const cancelMutate = cancelRun.mutate;
  const onCancel = useCallback(
    (runId: string) => {
      setBusyNotice(null);
      cancelMutate(
        { runId },
        {
          onError: (mutationError) => setBusyNotice(errorMessage(mutationError)),
        },
      );
    },
    [cancelMutate],
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
      postInputMutate(
        { runId, input: response },
        {
          onSuccess: () => {
            setPendingInput(null);
            // The parked run resumes server-side — re-attach its tail
            // (resumes from the cursor, nothing replays twice).
            reopenStream(runId);
          },
          onError: (mutationError) => {
            setInputError(errorMessage(mutationError));
            setPendingInput(null);
          },
        },
      );
    },
    [postInputMutate, reopenStream],
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
  const versionLabel = shortId(session.agentVersionId);

  const header: ThreadHeaderProps = {
    title,
    agentName: agentName ?? "Agent",
    agentId: session.agentId,
    versionLabel,
    modelId,
    workflowName: workflowName ?? null,
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
      onCancel={onCancel}
      cancelingRunId={cancelRun.isPending ? (cancelRun.variables?.runId ?? null) : null}
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
