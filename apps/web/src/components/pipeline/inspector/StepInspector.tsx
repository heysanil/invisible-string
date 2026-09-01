/**
 * The selected step's inspector: one shared frame (name · slug · this step's
 * diagnostics · Remove) dispatching to the per-kind form. Mounted by the
 * strip's inline accordion (`renderInspector`) or a Drawer escape hatch — in
 * either case the shell mounts exactly ONE StepInspector, which is what keeps
 * the one-Tiptap-inspector-at-a-time invariant true structurally (only the
 * infer and agent forms carry an editor, and only one form renders).
 *
 * All edits are `patchStepParams` — the keystroke-level reducer action — so
 * autosave and dirtiness ride the same path as every other edit.
 */
import { Trash2 } from "lucide-react";
import {
  STEP_SLUG_PATTERN,
  walkSteps,
  type AgentSummaryDto,
  type ModelPresetDto,
  type PipelineStep,
  type WorkflowConfig,
} from "@invisible-string/shared";

import type { BuilderAction, StepParamsPatch } from "../../../lib/builder/model";
import type { BuilderDiagnostic } from "../../../lib/builder/diagnostics";
import type { ReferenceSources } from "../../../lib/builder/references";
import type { ContextResources } from "../../../lib/builder/resources";
import { STEP_KIND_LABELS } from "../../../lib/builder/summary";
import type { StepReferenceContext } from "../../../lib/builder/useBuilderController";
import { DiagnosticsList } from "../../builder/DiagnosticsList";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { AgentStepForm } from "./AgentStepForm";
import {
  BranchStepForm,
  FilterStepForm,
  ForEachStepForm,
} from "./ControlStepForms";
import { InferStepForm } from "./InferStepForm";
import { StateStepForm } from "./StateStepForm";
import { ToolStepForm } from "./ToolStepForm";

export interface StepInspectorProps {
  step: PipelineStep;
  /** The whole draft (slug-uniqueness checks, the trigger for agent forms). */
  definition: WorkflowConfig;
  dispatch: (action: BuilderAction) => void;
  /** THIS step's diagnostics (BuilderDiagnostics.byStep[step.id]). */
  diagnostics?: readonly BuilderDiagnostic[];
  /** Workspace/user resource inventory (tool connections, agent context names). */
  resources: ContextResources;
  /** Workspace agent inventory; null while loading. */
  agents: readonly AgentSummaryDto[] | null;
  /** Workspace model presets; null while loading (infer form). */
  presets: readonly ModelPresetDto[] | null;
  workspaceId: string;
  /** The controller's positional `@reference` source derivation. */
  referenceSourcesFor: (
    stepId: string,
    context?: StepReferenceContext,
  ) => ReferenceSources;
  /** "✦ ask copilot to fix" on the diagnostics list. */
  onAskCopilot?: ((prompt: string) => void) | undefined;
}

export function StepInspector({
  step,
  definition,
  dispatch,
  diagnostics = [],
  resources,
  agents,
  presets,
  workspaceId,
  referenceSourcesFor,
  onAskCopilot,
}: StepInspectorProps) {
  const onPatch = (patch: StepParamsPatch) =>
    dispatch({ type: "patchStepParams", stepId: step.id, patch });
  const sources = referenceSourcesFor(step.id);

  const slugTakenElsewhere = walkSteps(definition.steps).some(
    (entry) => entry.step.id !== step.id && entry.step.slug === step.slug,
  );
  const slugError =
    step.slug !== "" && !STEP_SLUG_PATTERN.test(step.slug)
      ? "Slugs start with a letter and use letters, digits, _ or -."
      : step.slug !== "" && slugTakenElsewhere
        ? "Another step already uses this slug."
        : null;

  return (
    <section
      data-testid="step-inspector"
      aria-label={`${STEP_KIND_LABELS[step.kind]} step settings`}
      className="flex flex-col gap-4 rounded-card-lg border border-black/[0.08] bg-white/55 p-4"
    >
      {diagnostics.length > 0 ? (
        <DiagnosticsList
          diagnostics={diagnostics}
          {...(onAskCopilot ? { onAskCopilot } : {})}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Input
          label="Name"
          placeholder={`${STEP_KIND_LABELS[step.kind]} step`}
          value={step.name ?? ""}
          onChange={(event) => {
            const name = event.currentTarget.value;
            // An empty name means "no name" — drop the key, don't store "".
            onPatch(name === "" ? { name: undefined } : { name });
          }}
        />
        <Input
          label="Slug"
          placeholder="e.g. search"
          value={step.slug}
          error={slugError}
          className="font-mono text-[12.5px]"
          onChange={(event) => onPatch({ slug: event.currentTarget.value })}
        />
      </div>
      <p className="-mt-2 px-1 text-[11px] leading-snug text-ink-4">
        The slug is this step's <code className="mono-chip">@steps.&lt;slug&gt;</code>{" "}
        handle — renaming it does not rewrite references elsewhere.
      </p>

      {step.kind === "tool" ? (
        <ToolStepForm
          step={step}
          connections={resources.connections}
          sources={sources}
          onPatch={onPatch}
        />
      ) : step.kind === "infer" ? (
        <InferStepForm
          step={step}
          presets={presets}
          sources={sources}
          onPatch={onPatch}
        />
      ) : step.kind === "agent" ? (
        <AgentStepForm
          step={step}
          agents={agents}
          resources={resources}
          workspaceId={workspaceId}
          triggerType={definition.trigger.type}
          referenceSourcesFor={referenceSourcesFor}
          onPatch={onPatch}
        />
      ) : step.kind === "for_each" ? (
        <ForEachStepForm step={step} sources={sources} onPatch={onPatch} />
      ) : step.kind === "branch" ? (
        <BranchStepForm step={step} sources={sources} onPatch={onPatch} />
      ) : step.kind === "filter" ? (
        <FilterStepForm step={step} sources={sources} onPatch={onPatch} />
      ) : (
        <StateStepForm step={step} sources={sources} onPatch={onPatch} />
      )}

      <div className="flex justify-end border-t border-black/[0.06] pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-err hover:border-err/30 hover:bg-err/[0.05]"
          onClick={() => dispatch({ type: "removeStep", stepId: step.id })}
        >
          <Trash2 size={13} aria-hidden="true" />
          Remove step
        </Button>
      </div>
    </section>
  );
}
