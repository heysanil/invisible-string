/**
 * Workflow shell LAYOUT (pipelines redesign) — the lifecycle chrome every
 * workflow surface shares: back arrow · inline name · SaveIndicator ·
 * Published/Draft chip · Run (TestRunPopover through the real trigger path) ·
 * Publish · an Edit | Runs segmented control. The children render below:
 *
 *   index.tsx        — the conversational-first editor (ComposerPane +
 *                      PipelinePane).
 *   runs.tsx         — run history; runs.$runId.tsx — one run's step
 *                      timeline (linkable).
 *
 * The BUILDER CONTROLLER lives HERE, not in the editor child: the header's
 * save indicator, publish button and run gate all read it, and it must
 * survive an Edit ↔ Runs tab switch without dropping a pending autosave.
 * Children reach everything through {@link useWorkflowShell}.
 *
 * Publish is INSTANT (validate + snapshot server-side; builds belong to the
 * agent editor).
 */
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, Rocket } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentSummaryDto,
  GetWorkflowResponse,
  RunDto,
  WorkflowDto,
} from "@invisible-string/shared";
import { parseWorkflowConfig } from "@invisible-string/shared";

import { SaveIndicator } from "../components/builder/SaveIndicator";
import { TestRunPopover } from "../components/builder/TestRunPopover";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip } from "../components/ui/StatusChip";
import { useToast } from "../components/ui/Toast";
import { countIssues } from "../lib/builder/diagnostics";
import { definitionsEqual, emptyDefinition } from "../lib/builder/model";
import { useContextResources, type ContextResources } from "../lib/builder/resources";
import {
  builderStateFromWorkflow,
  useBuilderController,
  type BuilderController,
} from "../lib/builder/useBuilderController";
import {
  WorkflowShellContext,
  type WorkflowShellState,
} from "../lib/pipeline/workflow-shell";
import { useAgents } from "../lib/queries/agents";
import { queryKeys } from "../lib/queries/keys";
import { useUpdateWorkflow, useWorkflow } from "../lib/queries/workflows";
import { errorMessage } from "../lib/forms";
import { useActiveWorkspaceId } from "../lib/workspace";

export const Route = createFileRoute("/_app/workflows/$workflowId")({
  component: WorkflowShellRoute,
});

// ── Route ───────────────────────────────────────────────────────────────────
//
// Children read the shell's shared state (controller, inventories, the
// started-run hand-off) via lib/pipeline/workflow-shell's useWorkflowShell.

function WorkflowShellRoute() {
  const { workflowId } = Route.useParams();
  const { workspaceId, isPending: workspacePending } = useActiveWorkspaceId();

  if (workspacePending) return <CenteredSpinner />;
  if (!workspaceId) {
    return (
      <ShellFallback>
        <EmptyState
          icon={CircleAlert}
          title="No active workspace"
          description="Select a workspace to open the workflow editor."
        />
      </ShellFallback>
    );
  }
  return <ShellLoader workspaceId={workspaceId} workflowId={workflowId} />;
}

function ShellLoader({
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
      <ShellFallback>
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
      </ShellFallback>
    );
  }

  // Validator findings ride the GET response (dropped by useWorkflow's
  // select) — pull them from the cached raw response as the controller seed.
  const initialDiagnostics = queryClient.getQueryData<GetWorkflowResponse>(
    queryKeys.workflows.detail(workspaceId, workflowId),
  )?.diagnostics;

  return (
    <WorkflowShell
      // Remount cleanly when switching between workflows.
      key={workflow.data.id}
      workspaceId={workspaceId}
      workflow={workflow.data}
      resources={resources}
      agents={agents.data ?? null}
      // null + error ≠ loading: agent pickers show a designed error state
      // with retry, not skeleton ghost cards forever.
      agentsError={agents.isError}
      onRetryAgents={() => void agents.refetch()}
      {...(initialDiagnostics ? { initialDiagnostics } : {})}
    />
  );
}

function WorkflowShell({
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
  resources: ContextResources;
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
        emptyDefinition(),
      ),
    // Seed once per shell mount (keyed by workflow.id upstream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const controller = useBuilderController({
    workspaceId,
    workflow,
    initialState,
    resources,
    agents,
    ...(initialDiagnostics ? { initialDiagnostics } : {}),
  });

  const definition = controller.state.definition;

  // ── run overlay hand-off (header Run → editor strip) ─────────────────────

  const [startedRun, setStartedRun] = useState<RunDto | null>(null);

  // ── publish (instant: validate + snapshot) ───────────────────────────────

  const isPublished = workflow.publishedAt !== null;
  const publishedConfig = useMemo(
    () => parseWorkflowConfig(workflow.published),
    [workflow.published],
  );
  // Run dispatches the PUBLISHED snapshot — stale means unsaved edits OR a
  // saved draft that has drifted from the last snapshot.
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

  const shell: WorkflowShellState = {
    workspaceId,
    workflow,
    controller,
    resources,
    agents,
    agentsError,
    onRetryAgents: onRetryAgents ?? (() => {}),
    isPublished,
    publishedConfig,
    startedRun,
    dismissStartedRun: () => setStartedRun(null),
  };

  return (
    <WorkflowShellContext.Provider value={shell}>
      <div className="flex h-full flex-col gap-4">
        <ShellHeader
          workspaceId={workspaceId}
          workflow={workflow}
          controller={controller}
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
              onStarted={setStartedRun}
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
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
    </WorkflowShellContext.Provider>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────

type ShellTab = "edit" | "runs";

function ShellHeader({
  workspaceId,
  workflow,
  controller,
  isPublished,
  runPopover,
  publishButton,
}: {
  workspaceId: string;
  workflow: WorkflowDto;
  controller: BuilderController;
  isPublished: boolean;
  runPopover: ReactNode;
  publishButton: ReactNode;
}) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const updateWorkflow = useUpdateWorkflow(workspaceId);
  const [name, setName] = useState(workflow.name);
  const committed = useRef(workflow.name);

  const onRuns =
    matchRoute({ to: "/workflows/$workflowId/runs", fuzzy: true }) !== false;
  const tab: ShellTab = onRuns ? "runs" : "edit";

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
    // without it a later glass-panel sibling (its own stacking context)
    // paints over the open popover.
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
      <SaveIndicator
        status={controller.saveStatus}
        issueCount={countIssues(controller.diagnostics)}
        isDirty={controller.isDirty}
      />
      {isPublished ? (
        <StatusChip tone="success" dot>
          Published
        </StatusChip>
      ) : (
        <StatusChip tone="neutral" dot>
          Draft
        </StatusChip>
      )}
      <SegmentedControl<ShellTab>
        size="sm"
        ariaLabel="Workflow view"
        value={tab}
        options={[
          { value: "edit", label: "Edit" },
          { value: "runs", label: "Runs" },
        ]}
        onChange={(next) =>
          void navigate(
            next === "runs"
              ? {
                  to: "/workflows/$workflowId/runs",
                  params: { workflowId: workflow.id },
                }
              : {
                  to: "/workflows/$workflowId",
                  params: { workflowId: workflow.id },
                },
          )
        }
      />
      {runPopover}
      {publishButton}
    </Panel>
  );
}

// ── shells ──────────────────────────────────────────────────────────────────

function ShellFallback({ children }: { children: ReactNode }) {
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
