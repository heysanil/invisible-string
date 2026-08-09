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

import { isSessionBusy } from "../../lib/api-client";
import {
  EMPTY_FRAME_STORE,
  reduceRunView,
  type FrameStore,
  type RunView,
} from "../../lib/chat/run-view";
import { isSessionOver } from "../../lib/chat/session-errors";
import { useThreadStreams } from "../../lib/chat/use-thread-streams";
import { titleFromMessage } from "../../lib/chat/time";
import { errorMessage } from "../../lib/forms";
import {
  invalidateSessionLists,
  useCancelRun,
  useClearSessionContext,
  useCompactSessionContext,
  usePostMessage,
  usePostRunInput,
  useResetSession,
  useSession,
} from "../../lib/queries";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import type { ContextMarkerKind } from "./ContextDivider";
import { ThreadView } from "./ThreadView";
import type { SessionContextAction, ThreadHeaderProps } from "./ThreadHeader";

export interface ThreadContainerProps {
  workspaceId: string;
  sessionId: string;
  /** From the session list (the detail DTO doesn't carry names). */
  agentName?: string;
  /** Workflow provenance for trigger-origin sessions (null for direct chat). */
  workflowName?: string | null;
  /**
   * A reset RETIRED this session and minted a replacement row. The owner of
   * the active-session state must switch to the new id — the retired eve
   * session id can never accept another message, so staying put means every
   * send 409s `session_not_active` forever.
   */
  onSessionReplaced?: (newSessionId: string) => void;
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
  onSessionReplaced,
}: ThreadContainerProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useSession(sessionId);
  const postMessage = usePostMessage(workspaceId);
  const postInput = usePostRunInput(workspaceId);
  const cancelRun = useCancelRun(workspaceId);
  const clearContext = useClearSessionContext(workspaceId);
  const compactContext = useCompactSessionContext(workspaceId);
  const resetSession = useResetSession(workspaceId);

  const [pendingInput, setPendingInput] = useState<PendingInput | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [failedDraft, setFailedDraft] = useState<string | undefined>(undefined);
  const [busyNotice, setBusyNotice] = useState<string | null>(null);
  /** Set once eve reports this session id permanently unusable. */
  const [sessionRetired, setSessionRetired] = useState(false);
  const [contextMarker, setContextMarker] = useState<ContextMarkerKind | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

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
  // `canceled` comes off the event stream and lands BEFORE the run_status
  // frame. Without it here, a stopped run would keep the composer disabled
  // ("Working…") and the context menu blocked for a whole round trip after
  // the user already saw the run stop.
  const anyActive = runViews.some(
    (run) => !run.canceled && isActiveStatus(run.status),
  );
  // Two sources, deliberately: `pendingInputs` is FRAME-derived, so on a
  // freshly opened parked thread it is empty until the stream hydrates —
  // leaving the composer enabled for that window, and a message sent into it
  // 409s behind the parked run. The row's `waiting` covers the gap.
  //
  // Gating on the row alone was the original bug this replaced: a STOPPED
  // turn retires its requests, so "Waiting for your response above" pointed
  // at nothing. `!lastRun.canceled` plus reduceRunView's settled-row rule
  // (which resolves a stopped parked run to `canceled`, not the frozen live
  // `waiting`) is what makes reading the row safe again here.
  const awaitingApproval =
    lastRun !== undefined &&
    !lastRun.canceled &&
    (lastRun.pendingInputs.length > 0 || lastRun.status === "waiting");
  // The session's one run slot, as the control plane counts it: `waiting`
  // counts as busy because a parked run still owns the eve turn. Messages AND
  // context controls both serialize behind this.
  const slotHeld = runViews.some(
    (run) => !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
  );
  // The slot holder, read for its run id. Same predicate as `slotHeld` — only
  // one run can hold the slot, so "the one to stop" is unambiguous.
  const stoppableRunId =
    [...runViews]
      .reverse()
      .find(
        (run) =>
          !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
      )?.runId ?? null;
  const modelId =
    [...runViews].reverse().find((run) => run.modelId !== null)?.modelId ?? null;

  // The two 409s have OPPOSITE recoveries and must never share copy:
  // `session_busy` is transient (the draft is worth keeping — retry shortly),
  // `session_not_active` is permanent for this id (eve retired it; retrying
  // can never succeed, so the only honest offer is a new chat).
  const send = useCallback(
    (message: string) => {
      setBusyNotice(null);
      postMessage.mutate(
        { sessionId, message },
        {
          onError: (mutationError) => {
            setFailedDraft(message);
            if (isSessionBusy(mutationError)) {
              setBusyNotice(
                "This session is still working. Your message will be kept — try again once it finishes.",
              );
            } else if (isSessionOver(mutationError)) {
              setSessionRetired(true);
              setBusyNotice(
                "This session has been retired and can’t take new messages. Start a new chat to keep going — your text is still here to copy.",
              );
            } else {
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
  const onStop = useCallback(() => {
    if (stoppableRunId === null) return;
    setBusyNotice(null);
    cancelMutate(
      { runId: stoppableRunId },
      {
        onError: (mutationError) => setBusyNotice(errorMessage(mutationError)),
      },
    );
  }, [cancelMutate, stoppableRunId]);
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

  // ── context controls ──────────────────────────────────────────────────────
  const clearMutate = clearContext.mutate;
  const compactMutate = compactContext.mutate;
  const resetMutate = resetSession.mutate;

  const runContextControl = useCallback(
    (action: "clear" | "compact") => {
      const marker: ContextMarkerKind = action === "clear" ? "cleared" : "compacted";
      const mutate = action === "clear" ? clearMutate : compactMutate;
      mutate(
        { sessionId },
        {
          onSuccess: (result) => {
            // Keyed on `status`, not the HTTP code. `no_active_session` is
            // eve saying there is nothing live behind this id — the same
            // terminal condition a send reports as `session_not_active`, so
            // reporting it as success would be a lie.
            if (result.status === "no_active_session") {
              setSessionRetired(true);
              toast({
                variant: "error",
                message:
                  "This session has been retired, so there was no context to change. Start a new chat.",
              });
              return;
            }
            setContextMarker(marker);
            toast({
              variant: "success",
              message:
                action === "clear"
                  ? "Context cleared — the agent starts fresh from your next message."
                  : "Context compacted — earlier messages were summarized.",
            });
          },
          onError: (mutationError) => {
            if (isSessionOver(mutationError)) setSessionRetired(true);
            toast({ variant: "error", message: errorMessage(mutationError) });
          },
        },
      );
    },
    [clearMutate, compactMutate, sessionId, toast],
  );

  const performReset = useCallback(() => {
    resetMutate(
      { sessionId },
      {
        onSuccess: (result) => {
          setConfirmReset(false);
          if (result.status !== "reset") {
            setSessionRetired(true);
            toast({
              variant: "error",
              message:
                "There was no live session left to reset. Start a new chat instead.",
            });
            return;
          }
          toast({
            variant: "success",
            message: "Session reset — this is a fresh conversation.",
          });
          // The retired id is dead forever; move the user onto the
          // replacement row the control plane just minted.
          onSessionReplaced?.(result.session.id);
        },
        onError: (mutationError) => {
          setConfirmReset(false);
          toast({ variant: "error", message: errorMessage(mutationError) });
        },
      },
    );
  }, [onSessionReplaced, resetMutate, sessionId, toast]);

  const onContextAction = useCallback(
    (action: SessionContextAction) => {
      setContextMarker(null);
      // Reset only ASKS here — it retires the eve session id permanently.
      if (action === "reset") {
        setConfirmReset(true);
        return;
      }
      runContextControl(action);
    },
    [runContextControl],
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

  const contextActionPending: SessionContextAction | null = clearContext.isPending
    ? "clear"
    : compactContext.isPending
      ? "compact"
      : resetSession.isPending
        ? "reset"
        : null;

  const header: ThreadHeaderProps = {
    title,
    agentName: agentName ?? "Agent",
    agentId: session.agentId,
    versionLabel,
    modelId,
    workflowName: workflowName ?? null,
    sessionStatus: session.status,
    lastRunStatus: lastRun?.status ?? null,
    onContextAction,
    contextActionPending,
    // The control plane serializes context controls behind the session's one
    // run slot exactly as it does messages — and `waiting` counts as busy,
    // because a parked run still owns the turn. Say why up front instead of
    // offering a click that can only come back as a 409.
    contextActionsBlockedReason: sessionRetired
      ? "This session has been retired — start a new chat."
      : anyActive
        ? "Wait for the current run to finish, or stop it first."
        : slotHeld
          ? "Answer the request above, or stop the run first."
          : null,
  };

  const composerDisabledReason = anyActive
    ? "Working… you can send a follow-up when this run finishes."
    : awaitingApproval
      ? "Waiting for your response above."
      : busyNotice;

  return (
    <>
      <ThreadView
        header={header}
        runs={runViews}
        isChatOrigin={session.origin === "chat"}
        onRespond={respond}
        onStop={stoppableRunId !== null ? onStop : undefined}
        stopping={cancelRun.isPending}
        // Never two dividers for one clear. The optimistic marker exists for
        // a clear performed while the session is IDLE, where no run is
        // tailing and eve's `context.cleared` reaches nobody. If the newest
        // run did observe that event, it already drew its own divider inline,
        // so the acknowledged-mutation copy is redundant. The UI blocks
        // context actions while a run is live, so this only collides on a
        // narrow race — another tab clearing, or a run starting between the
        // click and the mutation landing.
        contextMarker={lastRun?.contextCleared === true ? null : contextMarker}
        pendingInput={pendingInput}
        inputError={inputError}
        onSend={send}
        composerDisabledReason={composerDisabledReason ?? null}
        sending={postMessage.isPending}
        failedDraft={failedDraft}
      />
      {/* Reset is the one control that destroys something: the eve session id
          is retired for good, so the dialog names that consequence rather
          than asking a generic "are you sure?". */}
      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={performReset}
        destructive
        loading={resetSession.isPending}
        title="Reset this session?"
        description="The agent starts over with no memory of this conversation."
        confirmLabel="Reset session"
      >
        <p className="text-[13px] leading-relaxed text-ink-2">
          This retires the current session for good — it can never take another
          message — and starts a fresh one in its place. The messages above stay
          readable here.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
          To keep the conversation and only drop the agent’s memory of it, use{" "}
          <span className="font-medium text-ink-2">Clear context</span> instead.
        </p>
      </ConfirmDialog>
    </>
  );
}

function shortId(id: string): string | null {
  if (id.length === 0) return null;
  const tail = id.replace(/^.*[_-]/, "");
  return tail.length > 8 ? tail.slice(0, 8) : tail;
}
