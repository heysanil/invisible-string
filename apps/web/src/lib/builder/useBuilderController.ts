/**
 * Workflow editor controller: owns the editor reducer, debounced autosave,
 * diagnostics distribution, and the (instant) publish flow. The route
 * renders; this hook holds the behavior.
 *
 * Workflows compile nothing — publish validates + snapshots server-side and
 * returns immediately, so there is no build poll here (builds belong to the
 * AGENT editor, lib/agents). Save → validate chain: the PATCH response
 * carries the shared validator's findings for the SAVED draft; a publish
 * flushes any pending save first so it snapshots what the user sees.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentContext,
  AgentSummaryDto,
  PublishWorkflowResponse,
  WorkflowDiagnostics,
  WorkflowDto,
} from "@invisible-string/shared";

import {
  emptyDiagnostics,
  localDiagnostics,
  mergeDiagnostics,
  serverDiagnostics,
  type BuilderDiagnostics,
} from "./diagnostics";
import {
  builderReducer,
  definitionOf,
  definitionsEqual,
  initBuilderState,
  type BuilderState,
} from "./model";
import type { ReferenceSources } from "./references";
import type { ContextResources } from "./resources";
import { usePublishWorkflow, useUpdateWorkflow } from "../queries/workflows";
import { ApiError } from "../api-client";

const AUTOSAVE_DELAY_MS = 700;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

// ── publish (instant — no build phases) ─────────────────────────────────────

export type WorkflowPublishPhase = "idle" | "publishing" | "published" | "error";

export interface WorkflowPublishState {
  phase: WorkflowPublishPhase;
  /** Populated in "error". */
  error: string | null;
}

const INITIAL_PUBLISH_STATE: WorkflowPublishState = { phase: "idle", error: null };

export interface BuilderControllerOptions {
  workspaceId: string;
  workflow: WorkflowDto;
  initialState: BuilderState;
  /** Merged workspace+user connections/skills (resolves context ids to names). */
  resources: ContextResources;
  /** Workspace agent inventory; null while loading (agent checks skip). */
  agents: readonly AgentSummaryDto[] | null;
  /**
   * The SELECTED agent's attached context (what `@connection`/`@skill`
   * autocomplete + validation resolve against). Null while no agent is
   * selected or its detail is still loading.
   */
  agentContext: AgentContext | null;
  /** Validator findings that rode the workflow GET (seed until first save). */
  initialDiagnostics?: WorkflowDiagnostics;
}

export interface BuilderController {
  state: BuilderState;
  dispatch: React.Dispatch<Parameters<typeof builderReducer>[1]>;
  saveStatus: SaveStatus;
  isDirty: boolean;
  diagnostics: BuilderDiagnostics;
  referenceSources: ReferenceSources;
  publishState: WorkflowPublishState;
  publish: () => Promise<PublishWorkflowResponse | null>;
  resetPublish: () => void;
  canPublish: boolean;
  /** Flush any pending autosave immediately (used before publish/run). */
  flush: () => Promise<void>;
}

export function useBuilderController(
  options: BuilderControllerOptions,
): BuilderController {
  const {
    workspaceId,
    workflow,
    initialState,
    resources,
    agents,
    agentContext,
    initialDiagnostics,
  } = options;

  const [state, dispatch] = useReducer(builderReducer, initialState);
  const definition = definitionOf(state);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [serverFindings, setServerFindings] = useState<BuilderDiagnostics>(() =>
    initialDiagnostics ? serverDiagnostics(initialDiagnostics) : emptyDiagnostics(),
  );
  const [publishState, setPublishState] =
    useState<WorkflowPublishState>(INITIAL_PUBLISH_STATE);

  const updateWorkflow = useUpdateWorkflow(workspaceId);
  const publishWorkflow = usePublishWorkflow(workspaceId);

  // Last definition known to be persisted on the server (dirtiness baseline).
  const savedRef = useRef(definition);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A promise that resolves when the in-flight save settles (for flush()).
  const inFlightSave = useRef<Promise<void> | null>(null);

  const isDirty = !definitionsEqual(definition, savedRef.current);

  // ── save (PATCH answers the validator's findings for free) ────────────────

  const save = useCallback(
    async (next: ReturnType<typeof definitionOf>) => {
      setSaveStatus("saving");
      const promise = (async () => {
        try {
          const result = await updateWorkflow.mutateAsync({
            workflowId: workflow.id,
            patch: { draft: next },
          });
          savedRef.current = next;
          setSaveStatus("saved");
          // The PATCH validated the saved draft — consume its findings
          // instead of a follow-up call (omitted = validation didn't run;
          // keep whatever we had rather than pretending the draft is clean).
          if (result.diagnostics) {
            setServerFindings(serverDiagnostics(result.diagnostics));
          }
        } catch {
          setSaveStatus("error");
        }
      })();
      inFlightSave.current = promise;
      await promise;
      inFlightSave.current = null;
    },
    [updateWorkflow, workflow.id],
  );

  // Debounced autosave on definition change.
  useEffect(() => {
    if (definitionsEqual(definition, savedRef.current)) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void save(definition);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // definition identity changes each reducer step; save/definition captured.
  }, [definition, save]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!definitionsEqual(definition, savedRef.current)) {
      await save(definition);
    } else if (inFlightSave.current) {
      await inFlightSave.current;
    }
  }, [definition, save]);

  // ── diagnostics (local mirror ⊕ server findings) ──────────────────────────

  // `@connection`/`@skill` sources come from the SELECTED AGENT's context —
  // the workflow attaches nothing itself; it delegates to an equipped agent.
  const referenceSources = useMemo<ReferenceSources>(() => {
    const connections = (agentContext?.mcpConnectionIds ?? [])
      .map((id) => resources.connectionById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ name: c.name, description: c.description }));
    const skills = (agentContext?.skillIds ?? [])
      .map((id) => resources.skillById.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({ name: s.name, description: s.description }));
    return { trigger: definition.trigger, connections, skills };
  }, [
    definition.trigger,
    agentContext,
    resources.connectionById,
    resources.skillById,
  ]);

  const local = useMemo(
    () =>
      localDiagnostics({
        definition,
        sources: referenceSources,
        agents,
        // No agent selected ⇒ nothing to wait for (refs are then judged
        // against empty sources, which is the truth).
        contextResolved: definition.agentId === null || agentContext !== null,
      }),
    [definition, referenceSources, agents, agentContext],
  );

  // Only trust server findings while they reflect the SAVED draft (drop them
  // the moment the user edits again — the local mirror covers the gap).
  const diagnostics = useMemo(
    () => (isDirty ? local : mergeDiagnostics(local, serverFindings)),
    [isDirty, local, serverFindings],
  );

  // ── publish (validate + snapshot; instant) ────────────────────────────────

  const publish = useCallback(async (): Promise<PublishWorkflowResponse | null> => {
    setPublishState({ phase: "publishing", error: null });
    try {
      await flush();
      const response = await publishWorkflow.mutateAsync(workflow.id);
      setPublishState({ phase: "published", error: null });
      return response;
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Publish failed. Try again.";
      setPublishState({ phase: "error", error: message });
      return null;
    }
  }, [flush, publishWorkflow, workflow.id]);

  const resetPublish = useCallback(() => {
    setPublishState(INITIAL_PUBLISH_STATE);
  }, []);

  // Publish is offered whenever there are no blocking errors (warnings ok).
  const canPublish = useMemo(
    () =>
      diagnostics.general.every((d) => d.severity !== "error") &&
      Object.values(diagnostics.sections).every((list) =>
        list.every((d) => d.severity !== "error"),
      ) &&
      definition.instructions.markdown.trim().length > 0,
    [diagnostics, definition.instructions.markdown],
  );

  return {
    state,
    dispatch,
    saveStatus,
    isDirty,
    diagnostics,
    referenceSources,
    publishState,
    publish,
    resetPublish,
    canPublish,
    flush,
  };
}

/** Seed the reducer state from a workflow's stored draft (or a fresh empty). */
export function builderStateFromWorkflow(
  draftDefinition: ReturnType<typeof definitionOf> | null,
  fallbackDefinition: ReturnType<typeof definitionOf>,
): BuilderState {
  return initBuilderState(draftDefinition ?? fallbackDefinition);
}
