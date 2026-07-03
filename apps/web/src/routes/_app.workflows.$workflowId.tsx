import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, CircleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type {
  AgentPresetDto,
  ModelAllowlistEntryDto,
  ModelPresetDto,
  WorkflowDto,
  WorkspaceMemberDto,
} from "@invisible-string/shared";
import { parseWorkflowDraft } from "@invisible-string/shared";

import { AgentEditor } from "../components/builder/AgentEditor";
import { ContextEditor } from "../components/builder/ContextEditor";
import { CopilotDock, type CopilotPrefill } from "../components/builder/CopilotDock";
import { DiagnosticsList } from "../components/builder/DiagnosticsList";
import { InstructionsPanel } from "../components/builder/InstructionsPanel";
import { LiveTriggerConfig } from "../components/builder/LiveTriggerConfig";
import { PillarRail } from "../components/builder/PillarRail";
import { TriggerEditor } from "../components/builder/TriggerEditor";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { useToast } from "../components/ui/Toast";
import { PILLAR_LABELS, emptyDefinition, type Pillar } from "../lib/builder/model";
import { countIssues } from "../lib/builder/diagnostics";
import { useContextResources } from "../lib/builder/resources";
import {
  builderStateFromWorkflow,
  useBuilderController,
  type SaveStatus,
} from "../lib/builder/useBuilderController";
import { useAgentPresets } from "../lib/queries/agent-presets";
import { useModelAllowlist, useModelPresets } from "../lib/queries/models";
import { useWorkspaceMembers } from "../lib/queries/members";
import { useUpdateWorkflow, useWorkflow } from "../lib/queries/workflows";
import { errorMessage } from "../lib/forms";
import { cn } from "../lib/cn";
import { useActiveWorkspaceId } from "../lib/workspace";

export const Route = createFileRoute("/_app/workflows/$workflowId")({
  component: BuilderRoute,
});

function BuilderRoute() {
  const { workflowId } = Route.useParams();
  const { workspaceId, isPending: workspacePending } = useActiveWorkspaceId();

  if (workspacePending) return <CenteredSpinner />;
  if (!workspaceId) {
    return (
      <BuilderShell>
        <EmptyState
          icon={CircleAlert}
          title="No active workspace"
          description="Select a workspace to open the builder."
        />
      </BuilderShell>
    );
  }
  return <BuilderLoader workspaceId={workspaceId} workflowId={workflowId} />;
}

function BuilderLoader({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const workflow = useWorkflow(workspaceId, workflowId);
  const resources = useContextResources(workspaceId);
  const agentPresets = useAgentPresets(workspaceId);
  const modelPresets = useModelPresets(workspaceId);
  const allowlist = useModelAllowlist(workspaceId);
  const members = useWorkspaceMembers(workspaceId);

  if (workflow.isPending || agentPresets.isPending) {
    return <CenteredSpinner />;
  }

  if (workflow.isError || !workflow.data) {
    return (
      <BuilderShell>
        <EmptyState
          icon={CircleAlert}
          title="Workflow not found"
          description="It may have been deleted. Head back to the list to pick another."
          action={
            <Link
              to="/workflows"
              className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-4 py-2 text-[13px] font-medium text-ink"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back to workflows
            </Link>
          }
        />
      </BuilderShell>
    );
  }

  const presets = agentPresets.data ?? [];
  if (presets.length === 0) {
    return (
      <BuilderShell>
        <EmptyState
          icon={CircleAlert}
          title="No agent presets yet"
          description="Create an agent preset in this workspace before building a workflow."
        />
      </BuilderShell>
    );
  }

  return (
    <Builder
      // Remount cleanly when switching between workflows.
      key={workflow.data.id}
      workspaceId={workspaceId}
      workflow={workflow.data}
      resources={resources}
      agentPresets={presets}
      modelPresets={modelPresets.data ?? []}
      allowlist={allowlist.data ?? []}
      members={members.data ?? []}
    />
  );
}

function Builder({
  workspaceId,
  workflow,
  resources,
  agentPresets,
  modelPresets,
  allowlist,
  members,
}: {
  workspaceId: string;
  workflow: WorkflowDto;
  resources: ReturnType<typeof useContextResources>;
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  allowlist: readonly ModelAllowlistEntryDto[];
  members: readonly WorkspaceMemberDto[];
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const updateWorkflow = useUpdateWorkflow(workspaceId);

  const initialState = useMemo(
    () =>
      builderStateFromWorkflow(
        parseWorkflowDraft(workflow.draft),
        emptyDefinition(agentPresets[0]!.id),
      ),
    // Seed once per Builder mount (keyed by workflow.id upstream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const controller = useBuilderController({
    workspaceId,
    workflow,
    initialState,
    resources,
    agentPresets,
    modelPresets,
    allowlist,
  });

  const { state, dispatch, diagnostics, referenceSources } = controller;
  const definition = state.definition;
  const activePillar = state.activePillar;

  const [runAsUserId, setRunAsUserId] = useState(workflow.runAsUserId);
  const [runDraftPending, setRunDraftPending] = useState(false);

  // Copilot plumbing: composer prefill (from diagnostics affordances) and the
  // pillar-card flash after an applied suggestion.
  const [copilotPrefill, setCopilotPrefill] = useState<CopilotPrefill | null>(null);
  const [flashPillar, setFlashPillar] = useState<Pillar | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function askCopilot(text: string) {
    setCopilotPrefill((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }

  function onSuggestionApplied(pillar: Pillar) {
    setFlashPillar(null);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    // Re-arm on the next frame so consecutive applies re-trigger the animation.
    flashTimer.current = setTimeout(() => setFlashPillar(pillar), 16);
    setTimeout(() => setFlashPillar((p) => (p === pillar ? null : p)), 900);
  }

  function changeRunAs(userId: string) {
    setRunAsUserId(userId);
    updateWorkflow.mutate(
      { workflowId: workflow.id, patch: { runAsUserId: userId } },
      {
        onError: (error) => {
          setRunAsUserId(workflow.runAsUserId);
          toast({ variant: "error", message: errorMessage(error) });
        },
      },
    );
  }

  async function onPublish() {
    const response = await controller.publish();
    if (response && response.buildStatus === "succeeded") {
      toast({
        variant: "success",
        message: response.cached
          ? "Published — served from build cache."
          : "Published and built.",
      });
    }
  }

  async function onRunDraft() {
    setRunDraftPending(true);
    try {
      const response = await controller.publish();
      if (!response) return; // publish surfaced its own error
      if (response.buildStatus !== "succeeded") {
        toast({
          variant: "error",
          message: "The draft must build cleanly before you can run it.",
        });
        return;
      }
      toast({
        variant: "success",
        message: "Draft published — starting a session in Chat.",
      });
      navigate({ to: "/chat", search: { workflow: workflow.id } });
    } finally {
      setRunDraftPending(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <BuilderHeader
        workspaceId={workspaceId}
        workflow={workflow}
        saveStatus={controller.saveStatus}
        issueCount={countIssues(diagnostics)}
        isDirty={controller.isDirty}
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <PillarRail
          name={workflow.name}
          publishedVersionId={workflow.publishedVersionId}
          isDirty={controller.isDirty}
          definition={definition}
          diagnostics={diagnostics}
          activePillar={activePillar}
          onFocusPillar={controller.focusPillar}
          connections={resources.connections}
          skills={resources.skills}
          agentPresets={agentPresets}
          modelPresets={modelPresets}
          publishState={controller.publishState}
          onPublish={onPublish}
          onRunDraft={onRunDraft}
          runDraftPending={runDraftPending}
          canPublish={controller.canPublish}
          flashPillar={flashPillar}
        />

        <Panel className="panel-enter flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex items-baseline justify-between px-6 pb-3 pt-5">
            <h2 className="text-[16px]">{PILLAR_LABELS[activePillar]}</h2>
            <span className="text-[12px] text-ink-4">{pillarHint(activePillar)}</span>
          </header>
          <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />
          <div className="thin-scroll flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              <DiagnosticsList
                diagnostics={diagnostics.pillars[activePillar]}
                onAskCopilot={askCopilot}
              />
              {activePillar === "trigger" ? (
                <>
                  <TriggerEditor definition={definition} dispatch={dispatch} />
                  {definition.trigger.type === "webhook" ||
                  definition.trigger.type === "form" ||
                  definition.trigger.type === "slack" ? (
                    <LiveTriggerConfig
                      workspaceId={workspaceId}
                      workflowId={workflow.id}
                      triggerType={definition.trigger.type}
                      slackBinding={
                        definition.trigger.type === "slack"
                          ? definition.trigger.binding
                          : undefined
                      }
                    />
                  ) : null}
                </>
              ) : null}
              {activePillar === "context" ? (
                <ContextEditor
                  workspaceId={workspaceId}
                  definition={definition}
                  dispatch={dispatch}
                  resources={resources}
                />
              ) : null}
              {activePillar === "agent" ? (
                <AgentEditor
                  definition={definition}
                  dispatch={dispatch}
                  presets={agentPresets}
                  modelPresets={modelPresets}
                  allowlist={allowlist}
                  members={members}
                  runAsUserId={runAsUserId}
                  onChangeRunAs={changeRunAs}
                />
              ) : null}
              {activePillar === "instructions" ? (
                <InstructionsPanel
                  definition={definition}
                  onChange={(markdown) =>
                    dispatch({ type: "setInstructions", markdown })
                  }
                  resources={resources}
                />
              ) : null}
            </div>
          </div>
        </Panel>

        <CopilotDock
          workspaceId={workspaceId}
          workflowId={workflow.id}
          definition={definition}
          dispatch={dispatch}
          resources={resources}
          agentPresets={agentPresets}
          modelPresets={modelPresets}
          prefill={copilotPrefill}
          onApplied={onSuggestionApplied}
        />
      </div>
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

function BuilderHeader({
  workspaceId,
  workflow,
  saveStatus,
  issueCount,
  isDirty,
}: {
  workspaceId: string;
  workflow: WorkflowDto;
  saveStatus: SaveStatus;
  issueCount: number;
  isDirty: boolean;
}) {
  const { toast } = useToast();
  const updateWorkflow = useUpdateWorkflow(workspaceId);
  const [name, setName] = useState(workflow.name);
  const committed = useRef(workflow.name);

  function commitName() {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === committed.current) {
      setName(committed.current);
      return;
    }
    committed.current = trimmed;
    setName(trimmed);
    updateWorkflow.mutate(
      { workflowId: workflow.id, patch: { name: trimmed } },
      {
        onError: (error) => {
          setName(committed.current);
          toast({ variant: "error", message: errorMessage(error) });
        },
      },
    );
  }

  return (
    <Panel className="panel-enter flex items-center gap-3 px-4 py-2.5">
      <Link
        to="/workflows"
        aria-label="Back to workflows"
        className="lift flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Link>
      <input
        value={name}
        aria-label="Workflow name"
        onChange={(event) => setName(event.currentTarget.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(committed.current);
            event.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 rounded-card bg-transparent px-2 py-1 text-[15px] font-semibold text-ink outline-none hover:bg-black/[0.03] focus-visible:bg-white/70"
      />
      <SaveIndicator status={saveStatus} issueCount={issueCount} isDirty={isDirty} />
    </Panel>
  );
}

function SaveIndicator({
  status,
  issueCount,
  isDirty,
}: {
  status: SaveStatus;
  issueCount: number;
  isDirty: boolean;
}) {
  if (status === "saving" || (isDirty && status !== "error")) {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Spinner size={12} /> Saving…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-err">
        <CircleAlert size={13} aria-hidden="true" /> Save failed
      </span>
    );
  }
  if (status === "saved") {
    return issueCount > 0 ? (
      <span className="flex items-center gap-1.5 text-[12.5px] text-warn">
        <CircleAlert size={13} aria-hidden="true" />
        {issueCount} issue{issueCount === 1 ? "" : "s"}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Check size={13} className="text-ok" aria-hidden="true" /> Saved · compiles
        clean
      </span>
    );
  }
  return (
    <span className={cn("text-[12.5px] text-ink-4")}>All changes saved</span>
  );
}

// ── shells ──────────────────────────────────────────────────────────────────

function pillarHint(pillar: keyof typeof PILLAR_LABELS): string {
  switch (pillar) {
    case "trigger":
      return "How runs start";
    case "context":
      return "Tools and knowledge";
    case "agent":
      return "Model and persona";
    case "instructions":
      return "What the agent does";
  }
}

function BuilderShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <Panel className="panel-enter flex h-full items-center justify-center">
        {children}
      </Panel>
    </div>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} className="text-ink-4" />
    </div>
  );
}
