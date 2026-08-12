/**
 * Agent editor controller: owns the editor reducer, debounced autosave,
 * diagnostics distribution, the three-state lifecycle derivation, and the
 * publish KICK. The route renders; this hook holds the behavior. Modeled 1:1
 * on the workflow builder's controller.
 *
 * Save → diagnostics chain: publish snapshots the STORED draft and the PATCH
 * response carries dry-run-compile diagnostics for the saved draft, so both
 * must ride a successful PATCH. The debounce collapses keystrokes; a
 * publish/chat flushes any pending save first.
 *
 * `publish()` resolves as soon as the POST answers — it no longer waits for
 * the build (spec D2). The build-status poll belongs to the workspace-level
 * `AgentPublishStore`, which outlives this hook's unmount; `publishState`
 * here is just a subscription to that store.
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
  agentLifecycleState,
  type AgentLifecycleState,
} from "./lifecycle";
import {
  agentEditorReducer,
  agentEditorStatesEqual,
  agentPatchOf,
  initAgentEditorState,
  type AgentEditorAction,
  type AgentEditorState,
} from "./model";
import type { PublishState } from "./publish-machine";
import { agentPublishStore, type AgentPublishStore } from "./publish-store";
import { useAgentPublishState } from "./use-publish-store";
import {
  useDryRunCompileAgent,
  usePublishAgent,
  useUpdateAgent,
} from "../queries/agents";
import { ApiError } from "../api-client";

const AUTOSAVE_DELAY_MS = 700;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface AgentControllerOptions {
  workspaceId: string;
  agent: AgentDto;
  initialState: AgentEditorState;
  /** Enabled allowlist entries; null while still loading (skip the check). */
  allowlist: readonly ModelAllowlistEntryDto[] | null;
  /** Test seam — an isolated publish store instead of the app singleton. */
  publishStore?: AgentPublishStore;
}

export interface AgentController {
  state: AgentEditorState;
  dispatch: React.Dispatch<AgentEditorAction>;
  saveStatus: SaveStatus;
  isDirty: boolean;
  /** Draft / Unsaved changes / Unpublished changes / Published (spec D3). */
  lifecycle: AgentLifecycleState;
  diagnostics: AgentDiagnostics;
  publishState: PublishState;
  /**
   * Kick a publish. Resolves when the POST answers — the response's
   * `buildStatus` is usually still `building`, and the store carries it the
   * rest of the way. Null means the POST itself failed.
   */
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
  const store = options.publishStore ?? agentPublishStore;

  const [state, dispatch] = useReducer(agentEditorReducer, initialState);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [dryRun, setDryRun] = useState<AgentDiagnostics>(emptyAgentDiagnostics());
  const publishState = useAgentPublishState(agent.id, store);

  const updateAgent = useUpdateAgent(workspaceId);
  const dryRunCompile = useDryRunCompileAgent(workspaceId);
  const publishAgent = usePublishAgent(workspaceId);

  // Last state known to be persisted on the server (dirtiness baseline).
  const savedRef = useRef(state);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A promise that resolves when the in-flight save settles (for flush()).
  const inFlightSave = useRef<Promise<void> | null>(null);
  // NOTE: unmount deliberately does NOT cancel the build watch anymore. It
  // used to (a poll nobody rendered was pure waste), which meant publishing
  // and then walking away — exactly what "Chat with agent" does — abandoned
  // the build silently. The store owns the poll now and announces by name.
  //
  // The in-flight publish (single-flight): a second publish() while one is
  // running — e.g. "Chat with agent" clicked mid-build — joins it instead of
  // POSTing a concurrent /publish and racing a second poll loop into the
  // same reducer.
  const inFlightPublish = useRef<Promise<PublishAgentResponse | null> | null>(null);

  const isDirty = !agentEditorStatesEqual(state, savedRef.current);

  // The three save states (D3): dirtiness against the last SAVE, plus the
  // saved draft against `publishedDefinition` — the baseline nothing compared
  // against before. Recomputed each render; both inputs are cheap.
  const lifecycle = agentLifecycleState({
    hasUnsavedChanges: isDirty,
    savedDefinition: savedRef.current.definition,
    publishedDefinition: agent.publishedDefinition,
  });

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
      store.begin({ workspaceId, agentId: agent.id, agentName: agent.name });
      try {
        await flush();
        const response = await publishAgent.mutateAsync(agent.id);
        // Hand the answer to the store and RETURN. A cache hit settles right
        // here; a fresh build answers "building"/"pending" and the store polls
        // it out in the background — past this hook's unmount, deliberately.
        store.received(agent.id, response);
        return response;
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : "Publish failed. Try again.";
        store.failed(agent.id, message);
        return null;
      }
    })();
    inFlightPublish.current = promise;
    try {
      return await promise;
    } finally {
      inFlightPublish.current = null;
    }
  }, [flush, publishAgent, agent.id, agent.name, workspaceId, store]);

  const resetPublish = useCallback(() => {
    store.reset(agent.id);
  }, [store, agent.id]);

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
    lifecycle,
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
