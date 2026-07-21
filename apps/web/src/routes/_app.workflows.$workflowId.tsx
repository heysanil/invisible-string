/**
 * The workflow editor — a single focused column that reads like a delegation
 * memo: when it runs (Trigger) → who does the work (Agent) → what they should
 * do (Instructions). No rail, no pillar switching — all three sections stay
 * expanded, separated by hairlines, inside one `max-w-3xl` scroll column.
 *
 * Publish is INSTANT (validate + snapshot server-side; builds belong to the
 * agent editor). The header carries the lifecycle: back arrow · inline name ·
 * SaveIndicator · Published/Draft chip · Run (TestRunPopover through the real
 * trigger path) · Publish. The copilot dock rides the right rail on the
 * workflow surface.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  FileText,
  Rocket,
  Zap,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type {
  AgentSummaryDto,
  GetWorkflowResponse,
  WorkflowConfig,
  WorkflowDto,
} from "@invisible-string/shared";
import { parseWorkflowConfig } from "@invisible-string/shared";

import { AgentSection } from "../components/builder/AgentSection";
import { DiagnosticsList } from "../components/builder/DiagnosticsList";
import { InstructionsPanel } from "../components/builder/InstructionsPanel";
import { LiveTriggerConfig } from "../components/builder/LiveTriggerConfig";
import { SaveIndicator } from "../components/builder/SaveIndicator";
import { TestRunPopover } from "../components/builder/TestRunPopover";
import { TriggerEditor } from "../components/builder/TriggerEditor";
import { CopilotDock, type CopilotPrefill } from "../components/copilot/CopilotDock";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip } from "../components/ui/StatusChip";
import { useToast } from "../components/ui/Toast";
import { useSelectedAgentContext } from "../lib/builder/agent-context";
import { countIssues } from "../lib/builder/diagnostics";
import {
  definitionsEqual,
  emptyDefinition,
  WORKFLOW_SECTIONS,
  WORKFLOW_SECTION_LABELS,
  type WorkflowSection,
} from "../lib/builder/model";
import { useContextResources } from "../lib/builder/resources";
import {
  builderStateFromWorkflow,
  useBuilderController,
  type SaveStatus,
} from "../lib/builder/useBuilderController";
import { workflowCopilotAdapter } from "../lib/copilot/mutations";
import { useAgents } from "../lib/queries/agents";
import { queryKeys } from "../lib/queries/keys";
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
          description="Select a workspace to open the workflow editor."
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
  const queryClient = useQueryClient();
  const workflow = useWorkflow(workspaceId, workflowId);
  const resources = useContextResources(workspaceId);
  const agents = useAgents(workspaceId);

  if (workflow.isPending) return <CenteredSpinner />;

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

  // Validator findings ride the GET response (dropped by useWorkflow's
  // select) — pull them from the cached raw response as the controller seed.
  const initialDiagnostics = queryClient.getQueryData<GetWorkflowResponse>(
    queryKeys.workflows.detail(workspaceId, workflowId),
  )?.diagnostics;

  return (
    <Builder
      // Remount cleanly when switching between workflows.
      key={workflow.data.id}
      workspaceId={workspaceId}
      workflow={workflow.data}
      resources={resources}
      agents={agents.data ?? null}
      // null + error ≠ loading: the Agent section must show a designed error
      // state with retry, not skeleton ghost cards forever.
      agentsError={agents.isError}
      onRetryAgents={() => void agents.refetch()}
      {...(initialDiagnostics ? { initialDiagnostics } : {})}
    />
  );
}

function Builder({
  workspaceId,
  workflow,
  resources,
  agents,
  agentsError = false,
  onRetryAgents,
  initialDiagnostics,
}: {
  workspaceId: string;
  workflow: WorkflowDto;
  resources: ReturnType<typeof useContextResources>;
  agents: readonly AgentSummaryDto[] | null;
  agentsError?: boolean;
  onRetryAgents?: () => void;
  initialDiagnostics?: GetWorkflowResponse["diagnostics"];
}) {
  const { toast } = useToast();

  const initialState = useMemo(
    () =>
      builderStateFromWorkflow(
        parseWorkflowConfig(workflow.draft),
        emptyDefinition(null),
      ),
    // Seed once per Builder mount (keyed by workflow.id upstream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The definition lives inside the controller, but the selected agent's
  // context query must be a top-level hook — track the id through state
  // initialized from the same seed the controller uses.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    initialState.definition.agentId,
  );
  const agentContext = useSelectedAgentContext(workspaceId, selectedAgentId);

  const controller = useBuilderController({
    workspaceId,
    workflow,
    initialState,
    resources,
    agents,
    agentContext,
    ...(initialDiagnostics ? { initialDiagnostics } : {}),
  });

  const { state, dispatch, diagnostics, referenceSources } = controller;
  const definition = state.definition;

  // Keep the agent-context query keyed to the live selection.
  useEffect(() => {
    setSelectedAgentId(definition.agentId);
  }, [definition.agentId]);

  // ── copilot plumbing (prefill + applied-suggestion flash) ─────────────────

  const [copilotPrefill, setCopilotPrefill] = useState<CopilotPrefill | null>(null);
  const [flashSection, setFlashSection] = useState<WorkflowSection | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function askCopilot(text: string) {
    setCopilotPrefill((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }

  function onSuggestionApplied(section: WorkflowSection) {
    setFlashSection(null);
    // Cancel BOTH timers: a stale clear-timer from the previous apply would
    // otherwise cut the new flash short mid-animation.
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    // Re-arm on the next frame so consecutive applies re-trigger the animation.
    flashTimer.current = setTimeout(() => setFlashSection(section), 16);
    flashClearTimer.current = setTimeout(
      () => setFlashSection((s) => (s === section ? null : s)),
      900,
    );
  }

  // The adapter reads the LIVE draft through a ref — never a stale capture.
  const draftRef = useRef<WorkflowConfig>(definition);
  draftRef.current = definition;
  const adapter = workflowCopilotAdapter({
    workflowId: workflow.id,
    getDraft: () => draftRef.current,
    dispatch,
    agents: agents ?? [],
    onApplied: onSuggestionApplied,
  });

  // ── publish (instant: validate + snapshot) ────────────────────────────────

  const isPublished = workflow.publishedAt !== null;
  // Run dispatches the PUBLISHED snapshot — stale means unsaved edits OR a
  // saved draft that has drifted from the last snapshot.
  const publishedConfig = useMemo(
    () => parseWorkflowConfig(workflow.published),
    [workflow.published],
  );
  const publishedStale =
    !isPublished ||
    publishedConfig === null ||
    !definitionsEqual(definition, publishedConfig);

  async function onPublish() {
    const response = await controller.publish();
    if (response) {
      toast({ variant: "success", message: "Published — live for new runs." });
    }
  }

  // Publish failures surface as toasts (the button itself stays put).
  const publishError =
    controller.publishState.phase === "error" ? controller.publishState.error : null;
  useEffect(() => {
    if (!publishError) return;
    toast({ variant: "error", message: publishError });
    controller.resetPublish();
    // toast/controller identities are stable enough; keyed on the error text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishError]);

  const publishPending = controller.publishState.phase === "publishing";

  return (
    <div className="flex h-full flex-col gap-4">
      <BuilderHeader
        workspaceId={workspaceId}
        workflow={workflow}
        saveStatus={controller.saveStatus}
        issueCount={countIssues(diagnostics)}
        isDirty={controller.isDirty}
        isPublished={isPublished}
        runPopover={
          <TestRunPopover
            workspaceId={workspaceId}
            workflowId={workflow.id}
            trigger={definition.trigger}
            isPublished={isPublished}
            isDirty={publishedStale}
            canPublish={controller.canPublish}
            publishPending={publishPending}
            onPublish={onPublish}
          />
        }
        publishButton={
          <Button
            size="sm"
            onClick={() => void onPublish()}
            disabled={!controller.canPublish}
            loading={publishPending}
          >
            {!publishPending ? <Rocket size={14} aria-hidden="true" /> : null}
            Publish
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4">
        <Panel className="panel-enter flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="thin-scroll flex-1 overflow-y-auto p-6">
            <div className="mx-auto flex max-w-3xl flex-col">
              {diagnostics.general.length > 0 ? (
                <div className="pb-6">
                  <DiagnosticsList
                    diagnostics={diagnostics.general}
                    onAskCopilot={askCopilot}
                  />
                </div>
              ) : null}

              {WORKFLOW_SECTIONS.map((section, index) => (
                <div key={section} className="flex flex-col">
                  {index > 0 ? (
                    <div aria-hidden="true" className="my-8 h-px bg-black/[0.06]" />
                  ) : null}
                  <section
                    aria-labelledby={`workflow-section-${section}`}
                    className={cn(
                      "flex scroll-mt-6 flex-col gap-4 rounded-card",
                      flashSection === section && "pillar-flash",
                    )}
                  >
                    <SectionHeader section={section} />
                    <DiagnosticsList
                      diagnostics={diagnostics.sections[section]}
                      onAskCopilot={askCopilot}
                    />
                    {section === "trigger" ? (
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
                    {section === "agent" ? (
                      <AgentSection
                        agents={agents}
                        isError={agentsError}
                        {...(onRetryAgents ? { onRetry: onRetryAgents } : {})}
                        selectedAgentId={definition.agentId}
                        dispatch={dispatch}
                      />
                    ) : null}
                    {section === "instructions" ? (
                      <InstructionsPanel
                        definition={definition}
                        onChange={(markdown) =>
                          dispatch({ type: "setInstructions", markdown })
                        }
                        sources={referenceSources}
                      />
                    ) : null}
                  </section>
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <CopilotDock
          workspaceId={workspaceId}
          adapter={adapter}
          prefill={copilotPrefill}
        />
      </div>
    </div>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

const SECTION_ICONS: Record<WorkflowSection, ComponentType<{ size?: number }>> = {
  trigger: Zap,
  agent: Bot,
  instructions: FileText,
};

const SECTION_HINTS: Record<WorkflowSection, string> = {
  trigger: "When this runs",
  agent: "Who does the work",
  instructions: "What they should do",
};

function SectionHeader({ section }: { section: WorkflowSection }) {
  const Icon = SECTION_ICONS[section];
  return (
    <header className="flex items-baseline justify-between">
      <h2
        id={`workflow-section-${section}`}
        className="flex items-center gap-2 text-[16px]"
      >
        <Icon size={15} aria-hidden="true" />
        {WORKFLOW_SECTION_LABELS[section]}
      </h2>
      <span className="text-[12px] text-ink-4">{SECTION_HINTS[section]}</span>
    </header>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

function BuilderHeader({
  workspaceId,
  workflow,
  saveStatus,
  issueCount,
  isDirty,
  isPublished,
  runPopover,
  publishButton,
}: {
  workspaceId: string;
  workflow: WorkflowDto;
  saveStatus: SaveStatus;
  issueCount: number;
  isDirty: boolean;
  isPublished: boolean;
  runPopover: ReactNode;
  publishButton: ReactNode;
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
    // z-10: the Run popover drops DOWN out of this panel over the row below;
    // without it the copilot dock (a later glass-panel sibling, its own
    // stacking context) paints over the open popover.
    <Panel className="panel-enter z-10 flex items-center gap-3 px-4 py-2.5">
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
      {isPublished ? (
        <StatusChip tone="success" dot>
          Published
        </StatusChip>
      ) : (
        <StatusChip tone="neutral" dot>
          Draft
        </StatusChip>
      )}
      {runPopover}
      {publishButton}
    </Panel>
  );
}

// ── shells ──────────────────────────────────────────────────────────────────

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
