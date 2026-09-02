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
 *
 * Reference sources are POSITIONAL in a pipeline (a step sees only the steps
 * before it), so the controller exposes `referenceSourcesFor(stepId)` rather
 * than one static source set. An agent step's inspector overlays the bound
 * agent's published context via the optional second argument — the
 * controller never fetches per-step agent contexts itself.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentSummaryDto,
  PublishWorkflowResponse,
  WorkflowDiagnostics,
  WorkflowDto,
} from "@invisible-string/shared";

import {
  emptyDiagnostics,
  hasBlockingIssue,
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
import {
  referenceSourcesForStep,
  type NamedResource,
  type ReferenceSources,
} from "./references";
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

/** The connection/skill context an agent-step surface resolves against. */
export interface StepReferenceContext {
  connections: readonly NamedResource[];
  skills: readonly NamedResource[];
}

const EMPTY_STEP_CONTEXT: StepReferenceContext = { connections: [], skills: [] };

export interface BuilderControllerOptions {
  workspaceId: string;
  workflow: WorkflowDto;
  initialState: BuilderState;
  /** Merged workspace+user connections/skills (tool-step checks + pickers). */
  resources: ContextResources;
  /** Workspace agent inventory; null while loading (agent checks skip). */
  agents: readonly AgentSummaryDto[] | null;
  /** Validator findings that rode the workflow GET (seed until first save). */
  initialDiagnostics?: WorkflowDiagnostics;
}

export interface BuilderController {
  state: BuilderState;
  dispatch: React.Dispatch<Parameters<typeof builderReducer>[1]>;
  saveStatus: SaveStatus;
  isDirty: boolean;
  diagnostics: BuilderDiagnostics;
  /**
   * The `@reference` sources for a surface belonging to `stepId` — prior
   * steps only, state keys, `@item` inside loops. Agent-step inspectors pass
   * their bound agent's resolved context as `context`; every other surface
   * omits it (connection/skill refs are prose there).
   */
  referenceSourcesFor: (
    stepId: string,
    context?: StepReferenceContext,
  ) => ReferenceSources;
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
    initialDiagnostics,
  } = options;

  const [state, dispatch] = useReducer(builderReducer, initialState);
  const definition = definitionOf(state);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [serverFindings, setServerFindings] = useState<BuilderDiagnostics>(() =>
    initialDiagnostics
      ? serverDiagnostics(initialDiagnostics, initialState.definition.steps)
      : emptyDiagnostics(),
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
          // Paths route against the draft that was SAVED.
          if (result.diagnostics) {
            setServerFindings(serverDiagnostics(result.diagnostics, next.steps));
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

  // ── reference sources (positional) ────────────────────────────────────────

  const referenceSourcesFor = useCallback(
    (stepId: string, context?: StepReferenceContext): ReferenceSources => {
      const overlay = context ?? EMPTY_STEP_CONTEXT;
      return referenceSourcesForStep(definition.steps, stepId, {
        trigger: definition.trigger,
        connections: overlay.connections,
        skills: overlay.skills,
      });
    },
    [definition.steps, definition.trigger],
  );

  // ── diagnostics (local mirror ⊕ server findings) ──────────────────────────

  const local = useMemo(
    () =>
      localDiagnostics({
        definition,
        connections: resources.isPending ? null : resources.connections,
        agents,
      }),
    [definition, resources.isPending, resources.connections, agents],
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

  // Publish is offered whenever there are no blocking errors (warnings ok)
  // and the pipeline has at least one step.
  const canPublish = useMemo(
    () => !hasBlockingIssue(diagnostics) && definition.steps.length > 0,
    [diagnostics, definition.steps.length],
  );

  return {
    state,
    dispatch,
    saveStatus,
    isDirty,
    diagnostics,
    referenceSourcesFor,
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
