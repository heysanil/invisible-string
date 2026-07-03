/**
 * Builder controller: owns the editor reducer, debounced autosave, dry-run
 * compile after each save, diagnostics distribution, and the publish state
 * machine. The route renders; this hook holds the behavior.
 *
 * Save → dry-run chain: publish snapshots the STORED draft, and dry-run
 * compiles the STORED draft, so both must run AFTER a successful PATCH. The
 * debounce collapses keystrokes; a publish/run flushes any pending save first.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentPresetDto,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  PublishWorkflowResponse,
  WorkflowDto,
} from "@invisible-string/shared";

import {
  dryRunDiagnostics,
  emptyDiagnostics,
  localDiagnostics,
  mergeDiagnostics,
  type BuilderDiagnostics,
} from "./diagnostics";
import {
  builderReducer,
  definitionOf,
  definitionsEqual,
  initBuilderState,
  type BuilderState,
  type Pillar,
} from "./model";
import {
  INITIAL_PUBLISH_STATE,
  publishReducer,
  type PublishState,
} from "./publish-machine";
import type { ReferenceSources } from "./references";
import type { ContextResources } from "./resources";
import { useDryRunCompile, usePublishWorkflow, useUpdateWorkflow } from "../queries/workflows";
import { ApiError } from "../api-client";

const AUTOSAVE_DELAY_MS = 700;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface BuilderControllerOptions {
  workspaceId: string;
  workflow: WorkflowDto;
  initialState: BuilderState;
  resources: ContextResources;
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  allowlist: readonly ModelAllowlistEntryDto[];
}

export interface BuilderController {
  state: BuilderState;
  dispatch: React.Dispatch<Parameters<typeof builderReducer>[1]>;
  focusPillar: (pillar: Pillar) => void;
  saveStatus: SaveStatus;
  isDirty: boolean;
  diagnostics: BuilderDiagnostics;
  referenceSources: ReferenceSources;
  publishState: PublishState;
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
    agentPresets,
    modelPresets,
    allowlist,
  } = options;

  const [state, dispatch] = useReducer(builderReducer, initialState);
  const definition = definitionOf(state);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [dryRun, setDryRun] = useState<BuilderDiagnostics>(emptyDiagnostics());
  const [publishState, publishDispatch] = useReducer(
    publishReducer,
    INITIAL_PUBLISH_STATE,
  );

  const updateWorkflow = useUpdateWorkflow(workspaceId);
  const dryRunCompile = useDryRunCompile(workspaceId);
  const publishWorkflow = usePublishWorkflow(workspaceId);

  // Last definition known to be persisted on the server (dirtiness baseline).
  const savedRef = useRef(definition);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A promise that resolves when the in-flight save settles (for flush()).
  const inFlightSave = useRef<Promise<void> | null>(null);

  const isDirty = !definitionsEqual(definition, savedRef.current);

  // ── save + dry-run ─────────────────────────────────────────────────────────

  const runDryRun = useCallback(async () => {
    try {
      const result = await dryRunCompile.mutateAsync(workflow.id);
      setDryRun(result.ok ? emptyDiagnostics() : dryRunDiagnostics(result.error));
    } catch {
      // A dry-run transport failure is non-fatal — local checks still apply.
      setDryRun(emptyDiagnostics());
    }
  }, [dryRunCompile, workflow.id]);

  const save = useCallback(
    async (next: ReturnType<typeof definitionOf>) => {
      setSaveStatus("saving");
      const promise = (async () => {
        try {
          await updateWorkflow.mutateAsync({
            workflowId: workflow.id,
            patch: { draft: next },
          });
          savedRef.current = next;
          setSaveStatus("saved");
          await runDryRun();
        } catch {
          setSaveStatus("error");
        }
      })();
      inFlightSave.current = promise;
      await promise;
      inFlightSave.current = null;
    },
    [updateWorkflow, workflow.id, runDryRun],
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

  // ── diagnostics (local mirror ⊕ dry-run) ──────────────────────────────────

  const referenceSources = useMemo<ReferenceSources>(() => {
    const connections = definition.context.mcpConnectionIds
      .map((id) => resources.connectionById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ name: c.name, description: c.description }));
    const skills = definition.context.skillIds
      .map((id) => resources.skillById.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({ name: s.name, description: s.description }));
    return { trigger: definition.trigger, connections, skills };
  }, [
    definition.trigger,
    definition.context.mcpConnectionIds,
    definition.context.skillIds,
    resources.connectionById,
    resources.skillById,
  ]);

  const local = useMemo(
    () =>
      localDiagnostics({
        definition,
        sources: referenceSources,
        agentPresetIds: agentPresets.map((p) => p.id),
        allowedModelIds: allowlist
          .filter((entry) => entry.enabled)
          .map((entry) => entry.modelId),
      }),
    [definition, referenceSources, agentPresets, allowlist],
  );

  // Only trust the dry-run while it reflects the SAVED draft (drop it the
  // moment the user edits again — the local mirror covers the gap).
  const diagnostics = useMemo(
    () => (isDirty ? local : mergeDiagnostics(local, dryRun)),
    [isDirty, local, dryRun],
  );

  void modelPresets; // consumed by summaries in the rail, not here.

  // ── publish ────────────────────────────────────────────────────────────────

  const publish = useCallback(async (): Promise<PublishWorkflowResponse | null> => {
    publishDispatch({ type: "start" });
    try {
      await flush();
      const response = await publishWorkflow.mutateAsync(workflow.id);
      publishDispatch({ type: "received", response });
      return response;
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Publish failed. Try again.";
      publishDispatch({ type: "failed", message });
      return null;
    }
  }, [flush, publishWorkflow, workflow.id]);

  const resetPublish = useCallback(() => {
    publishDispatch({ type: "reset" });
  }, []);

  const focusPillar = useCallback(
    (pillar: Pillar) => dispatch({ type: "focusPillar", pillar }),
    [],
  );

  // Publish is offered whenever there are no blocking errors (warnings ok).
  const canPublish = useMemo(
    () =>
      diagnostics.general.every((d) => d.severity !== "error") &&
      Object.values(diagnostics.pillars).every((list) =>
        list.every((d) => d.severity !== "error"),
      ) &&
      definition.instructions.markdown.trim().length > 0,
    [diagnostics, definition.instructions.markdown],
  );

  return {
    state,
    dispatch,
    focusPillar,
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
