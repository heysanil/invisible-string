/**
 * Agent editor controller: owns the editor reducer, debounced autosave,
 * diagnostics distribution, and the publish state machine (with the
 * post-publish build-status poll). The route renders; this hook holds the
 * behavior. Modeled 1:1 on the workflow builder's controller.
 *
 * Save → diagnostics chain: publish snapshots the STORED draft and the PATCH
 * response carries dry-run-compile diagnostics for the saved draft, so both
 * must ride a successful PATCH. The debounce collapses keystrokes; a
 * publish/chat flushes any pending save first.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentDto,
  ModelAllowlistEntryDto,
  PublishAgentResponse,
} from "@invisible-string/shared";

import {
  dryRunAgentDiagnostics,
  emptyAgentDiagnostics,
  hasBlockingAgentIssues,
  localAgentDiagnostics,
  mergeAgentDiagnostics,
  type AgentDiagnostics,
} from "./diagnostics";
import {
  agentEditorReducer,
  agentEditorStatesEqual,
  agentPatchOf,
  initAgentEditorState,
  type AgentEditorAction,
  type AgentEditorState,
} from "./model";
import {
  INITIAL_PUBLISH_STATE,
  publishReducer,
  type PublishState,
} from "./publish-machine";
import {
  fetchAgentBuildStatus,
  useDryRunCompileAgent,
  usePublishAgent,
  useUpdateAgent,
} from "../queries/agents";
import { ApiError } from "../api-client";

/** Poll cadence + ceiling for the post-publish build-status watch. */
const BUILD_POLL_INTERVAL_MS = 1500;
const BUILD_POLL_MAX_ATTEMPTS = 1000; // ~25 min ceiling; a fresh eve build is minutes

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const AUTOSAVE_DELAY_MS = 700;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface AgentControllerOptions {
  workspaceId: string;
  agent: AgentDto;
  initialState: AgentEditorState;
  /** Enabled allowlist entries; null while still loading (skip the check). */
  allowlist: readonly ModelAllowlistEntryDto[] | null;
  /** Test seam — shortens the build-status poll cadence. */
  buildPollIntervalMs?: number;
}

export interface AgentController {
  state: AgentEditorState;
  dispatch: React.Dispatch<AgentEditorAction>;
  saveStatus: SaveStatus;
  isDirty: boolean;
  diagnostics: AgentDiagnostics;
  publishState: PublishState;
  publish: () => Promise<PublishAgentResponse | null>;
  resetPublish: () => void;
  canPublish: boolean;
  /** Flush any pending autosave immediately (used before publish/chat). */
  flush: () => Promise<void>;
}

export function useAgentController(
  options: AgentControllerOptions,
): AgentController {
  const { workspaceId, agent, initialState, allowlist } = options;
  const pollIntervalMs = options.buildPollIntervalMs ?? BUILD_POLL_INTERVAL_MS;

  const [state, dispatch] = useReducer(agentEditorReducer, initialState);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [dryRun, setDryRun] = useState<AgentDiagnostics>(emptyAgentDiagnostics());
  const [publishState, publishDispatch] = useReducer(
    publishReducer,
    INITIAL_PUBLISH_STATE,
  );

  const updateAgent = useUpdateAgent(workspaceId);
  const dryRunCompile = useDryRunCompileAgent(workspaceId);
  const publishAgent = usePublishAgent(workspaceId);

  // Last state known to be persisted on the server (dirtiness baseline).
  const savedRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A promise that resolves when the in-flight save settles (for flush()).
  const inFlightSave = useRef<Promise<void> | null>(null);
  // Editor unmount cancels the build-status poll loop (nothing renders the
  // result anymore — without this, a fresh publish keeps fetching every
  // 1.5 s for up to ~25 min after navigating away).
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);
  // The in-flight publish (single-flight): a second publish() while one is
  // running — e.g. "Chat with agent" clicked mid-build — joins it instead of
  // POSTing a concurrent /publish and racing a second poll loop into the
  // same reducer.
  const inFlightPublish = useRef<Promise<PublishAgentResponse | null> | null>(null);

  const isDirty = !agentEditorStatesEqual(state, savedRef.current);

  // ── save + dry-run ─────────────────────────────────────────────────────────

  const runDryRun = useCallback(async () => {
    try {
      const result = await dryRunCompile.mutateAsync(agent.id);
      setDryRun(
        result.ok ? emptyAgentDiagnostics() : dryRunAgentDiagnostics(result.error),
      );
    } catch {
      // A dry-run transport failure is non-fatal — local checks still apply.
      setDryRun(emptyAgentDiagnostics());
    }
  }, [dryRunCompile, agent.id]);

  const save = useCallback(
    async (next: AgentEditorState) => {
      setSaveStatus("saving");
      const promise = (async () => {
        try {
          const result = await updateAgent.mutateAsync({
            agentId: agent.id,
            patch: agentPatchOf(next),
          });
          savedRef.current = next;
          setSaveStatus("saved");
          // The PATCH already dry-ran the saved draft — consume its
          // diagnostics instead of a redundant follow-up call. Fall back to
          // the dedicated endpoint only when the server omitted them (e.g.
          // the object store was briefly down).
          if (result.diagnostics) {
            setDryRun(
              result.diagnostics.ok
                ? emptyAgentDiagnostics()
                : dryRunAgentDiagnostics(result.diagnostics.error),
            );
          } else {
            await runDryRun();
          }
        } catch {
          setSaveStatus("error");
        }
      })();
      inFlightSave.current = promise;
      await promise;
      inFlightSave.current = null;
    },
    [updateAgent, agent.id, runDryRun],
  );

  // Debounced autosave on state change.
  useEffect(() => {
    if (agentEditorStatesEqual(state, savedRef.current)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void save(state);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // state identity changes each reducer step; save/state captured.
  }, [state, save]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!agentEditorStatesEqual(state, savedRef.current)) {
      await save(state);
    } else if (inFlightSave.current) {
      await inFlightSave.current;
    }
  }, [state, save]);

  // ── diagnostics (local mirror ⊕ dry-run) ──────────────────────────────────

  const local = useMemo(
    () =>
      localAgentDiagnostics({
        definition: state.definition,
        allowedModelIds:
          allowlist === null
            ? null
            : allowlist
                .filter((entry) => entry.enabled)
                .map((entry) => entry.modelId),
      }),
    [state.definition, allowlist],
  );

  // Only trust the dry-run while it reflects the SAVED draft (drop it the
  // moment the user edits again — the local mirror covers the gap).
  const diagnostics = useMemo(
    () => (isDirty ? local : mergeAgentDiagnostics(local, dryRun)),
    [isDirty, local, dryRun],
  );

  // ── publish ────────────────────────────────────────────────────────────────

  const publish = useCallback(async (): Promise<PublishAgentResponse | null> => {
    // Single-flight: join the running publish rather than starting a twin.
    if (inFlightPublish.current) return inFlightPublish.current;
    const promise = (async (): Promise<PublishAgentResponse | null> => {
      publishDispatch({ type: "start" });
      try {
        await flush();
        const response = await publishAgent.mutateAsync(agent.id);
        publishDispatch({ type: "received", response });

        // A fresh build answers "building"/"pending" and finishes in the
        // background — poll the version's build status until it is terminal
        // so the rail flips from "Building…" to the ready/error chip. The
        // loop stops when the editor unmounts (disposedRef): nothing renders
        // the outcome anymore, and the next mount's publish is a cheap
        // idempotent re-kick.
        let current = response;
        let attempts = 0;
        while (
          (current.buildStatus === "building" || current.buildStatus === "pending") &&
          attempts < BUILD_POLL_MAX_ATTEMPTS &&
          !disposedRef.current
        ) {
          attempts += 1;
          await sleep(pollIntervalMs);
          if (disposedRef.current) break;
          try {
            const status = await fetchAgentBuildStatus(
              workspaceId,
              agent.id,
              response.versionId,
            );
            current = {
              ...response,
              buildStatus: status.status,
              buildError: status.error,
            };
            publishDispatch({ type: "received", response: current });
          } catch {
            // Transient poll failure — keep waiting for the build to settle.
          }
        }
        return current;
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : "Publish failed. Try again.";
        publishDispatch({ type: "failed", message });
        return null;
      }
    })();
    inFlightPublish.current = promise;
    try {
      return await promise;
    } finally {
      inFlightPublish.current = null;
    }
  }, [flush, publishAgent, agent.id, workspaceId, pollIntervalMs]);

  const resetPublish = useCallback(() => {
    publishDispatch({ type: "reset" });
  }, []);

  // Publish is offered whenever there are no blocking errors (warnings ok).
  const canPublish = useMemo(
    () =>
      !hasBlockingAgentIssues(diagnostics) &&
      state.definition.persona.trim().length > 0,
    [diagnostics, state.definition.persona],
  );

  return {
    state,
    dispatch,
    saveStatus,
    isDirty,
    diagnostics,
    publishState,
    publish,
    resetPublish,
    canPublish,
    flush,
  };
}

/** Seed the reducer state from an agent's stored row (route convenience). */
export function agentEditorStateFromAgent(agent: AgentDto): AgentEditorState {
  return initAgentEditorState(agent);
}
