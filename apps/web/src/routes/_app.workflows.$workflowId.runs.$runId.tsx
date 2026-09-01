/**
 * One run's step timeline. The SAME PipelineStrip renders the published
 * config in "run" density — one grammar for the pipeline at rest and in
 * motion: status badges, durations, `for_each` iteration counters, retries.
 * Live runs fold their `pipeline.*` SSE frames through
 * lib/pipeline/run-progress on top of the persisted `run_steps` ledger.
 *
 * Steps the run never reached are marked `skipped` once the run settles (a
 * branch's untaken lane, steps after a false top-level filter); while the run
 * is still moving they simply carry no badge.
 *
 * Clicking a step opens a drawer with every INSTANCE the ledger holds for it
 * (a loop body step yields one per iteration): status · attempt · duration ·
 * capped input/output snapshots as code blocks. AGENT steps embed the child
 * run's real chat rendering (reduceRunView → RunMessage) — the step has real
 * depth, and the ledger only holds its extract.
 *
 * There is deliberately no `GET /runs/:id`, so the run row resolves from the
 * workflow's runs list (the parent tab's query).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, ArrowLeft, CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  addFrame,
  EMPTY_FRAME_STORE,
  reduceRunView,
  type FrameStore,
} from "../lib/chat/run-view";
import {
  isRunSettledStatus,
  parseWorkflowConfig,
  walkSteps,
  type PipelineStep,
  type RunDto,
  type RunStatus,
  type RunStepDetailDto,
  type TriggerEvent,
  type WorkflowConfig,
} from "@invisible-string/shared";

import { RunMessage } from "../components/chat/RunMessage";
import { Markdown } from "../components/chat/Markdown";
import { PipelineStrip, StepStatusBadge } from "../components/pipeline";
import { Drawer } from "../components/ui/Drawer";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Spinner } from "../components/ui/Spinner";
import { StatusChip } from "../components/ui/StatusChip";
import type { StepRunState } from "../components/pipeline";
import type { StepSummaryContext } from "../lib/builder/summary";
import { useRunSteps, useWorkflowRuns } from "../lib/pipeline/queries";
import { RUN_STATUS_TONE, runDuration } from "../lib/pipeline/run-display";
import { usePipelineRunProgress } from "../lib/pipeline/use-run-progress";
import { useWorkflowShell } from "../lib/pipeline/workflow-shell";
import { usePostRunInput } from "../lib/queries/runs";
import { formatRelativeTime } from "../lib/format";
import { streamRun } from "../lib/sse";

export const Route = createFileRoute("/_app/workflows/$workflowId/runs/$runId")({
  component: RunDetail,
});

function RunDetail() {
  const { runId } = Route.useParams();
  const shell = useWorkflowShell();
  const { workspaceId, workflow } = shell;

  const runs = useWorkflowRuns(workspaceId, workflow.id);
  const run = runs.data?.find((candidate) => candidate.id === runId) ?? null;

  if (runs.isPending) {
    return (
      <Panel className="panel-enter flex h-full items-center justify-center">
        <Spinner size={18} className="text-ink-4" />
      </Panel>
    );
  }

  if (run === null) {
    return (
      <Panel className="panel-enter flex h-full items-center justify-center">
        <EmptyState
          icon={CircleAlert}
          title="Run not found"
          description="It may be older than the run history window, or belong to another workflow."
          action={<BackToRuns workflowId={workflow.id} />}
        />
      </Panel>
    );
  }

  return <RunTimeline key={run.id} run={run} />;
}

function BackToRuns({ workflowId }: { workflowId: string }) {
  return (
    <Link
      to="/workflows/$workflowId/runs"
      params={{ workflowId }}
      className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-3 py-1.5 text-[12.5px] font-medium text-ink"
    >
      <ArrowLeft size={13} aria-hidden="true" /> All runs
    </Link>
  );
}

function RunTimeline({ run }: { run: RunDto }) {
  const shell = useWorkflowShell();
  const { workspaceId, workflow, resources, agents, publishedConfig } = shell;

  const steps = useRunSteps(run.id, { full: true });
  const progress = usePipelineRunProgress(run, {
    seed: steps.data ?? null,
    // The ledger's terminal snapshot has the authoritative previews/outputs.
    onSettled: () => void steps.refetch(),
  });

  // The run executed the PUBLISHED snapshot; today's snapshot is the closest
  // renderable view of it (drift after a republish is possible — the ledger
  // rows themselves are the ground truth the drawer shows).
  const config: WorkflowConfig | null =
    publishedConfig ?? parseWorkflowConfig(workflow.draft);

  const settled = isRunSettledStatus(progress.status);

  // Fill steps the run never reached: skipped once settled, no badge before.
  const runStates = useMemo(() => {
    if (config === null) return progress.runStates;
    if (!settled) return progress.runStates;
    const filled = new Map<string, StepRunState>(progress.runStates);
    for (const entry of walkSteps(config.steps)) {
      if (!filled.has(entry.step.id)) {
        filled.set(entry.step.id, { status: "skipped" });
      }
    }
    return filled;
  }, [config, progress.runStates, settled]);

  const ctx: StepSummaryContext = useMemo(
    () => ({
      connections: resources.isPending ? null : resources.connections,
      agents,
    }),
    [resources.isPending, resources.connections, agents],
  );

  const [drawerStepId, setDrawerStepId] = useState<string | null>(null);
  const drawerStep =
    config !== null && drawerStepId !== null
      ? (walkSteps(config.steps).find((entry) => entry.step.id === drawerStepId)
          ?.step ?? null)
      : null;
  const drawerRows = useMemo(
    () => (steps.data ?? []).filter((row) => row.stepId === drawerStepId),
    [steps.data, drawerStepId],
  );

  const duration = runDuration(run);
  const error = progress.error ?? run.error;

  return (
    <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-center gap-3 px-5 pb-3 pt-4">
        <BackToRuns workflowId={workflow.id} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">
          {run.triggerEvent.triggerType} · {formatRelativeTime(run.createdAt)}
          {duration !== null ? ` · ${duration}` : ""}
        </span>
        <StatusChip tone={RUN_STATUS_TONE[progress.status]} dot>
          {progress.status}
        </StatusChip>
      </header>
      <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />

      <div className="thin-scroll flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-xl flex-col gap-3">
          {error !== null && progress.status === "failed" ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-card border border-err/35 bg-err/[0.05] px-3 py-2 text-[13px] text-ink"
            >
              <AlertCircle
                size={15}
                className="mt-0.5 shrink-0 text-err"
                aria-hidden="true"
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
            </div>
          ) : null}

          {config === null ? (
            <EmptyState
              icon={CircleAlert}
              title="Pipeline unavailable"
              description="This workflow's config can no longer be read — the step ledger below the strip is unaffected."
            />
          ) : (
            <PipelineStrip
              steps={config.steps}
              ctx={ctx}
              runStates={runStates}
              selectedStepId={drawerStepId}
              onSelectStep={(stepId) => setDrawerStepId(stepId)}
            />
          )}
        </div>
      </div>

      <Drawer
        open={drawerStep !== null}
        onClose={() => setDrawerStepId(null)}
        title={drawerStep !== null ? stepDrawerTitle(drawerStep) : "Step"}
        widthClassName="max-w-2xl"
      >
        {drawerStep !== null ? (
          <StepDrawerBody
            workspaceId={workspaceId}
            step={drawerStep}
            rows={drawerRows}
            loading={steps.isPending}
          />
        ) : null}
      </Drawer>
    </Panel>
  );
}

function stepDrawerTitle(step: PipelineStep): string {
  const name = step.name?.trim() ?? "";
  if (name.length > 0) return name;
  return step.slug.length > 0 ? step.slug : step.kind;
}

// ── Step drawer (per-instance ledger rows) ──────────────────────────────────

function StepDrawerBody({
  workspaceId,
  step,
  rows,
  loading,
}: {
  workspaceId: string;
  step: PipelineStep;
  rows: readonly RunStepDetailDto[];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner size={16} className="text-ink-4" />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-1 py-4 text-[13px] text-ink-3">
        This step never ran — a filter or branch decided against it, or the run
        ended before reaching it.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <InstanceCard
          key={row.path}
          workspaceId={workspaceId}
          step={step}
          row={row}
        />
      ))}
    </div>
  );
}

function instanceDuration(row: RunStepDetailDto): string | null {
  if (row.startedAt === null || row.completedAt === null) return null;
  const ms = Date.parse(row.completedAt) - Date.parse(row.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Fenced-JSON view of a capped snapshot (chat Markdown = styled code block). */
function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text = useMemo(() => {
    try {
      const json = JSON.stringify(value, null, 2) ?? "null";
      return json.length > 8000 ? `${json.slice(0, 8000)}\n…` : json;
    } catch {
      return "(unserializable)";
    }
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-ink-4">
        {label}
      </span>
      <Markdown text={`\`\`\`json\n${text}\n\`\`\``} />
    </div>
  );
}

function InstanceCard({
  workspaceId,
  step,
  row,
}: {
  workspaceId: string;
  step: PipelineStep;
  row: RunStepDetailDto;
}) {
  const duration = instanceDuration(row);
  return (
    <section
      data-testid="step-instance"
      className="flex flex-col gap-2.5 rounded-card-lg border border-black/[0.08] bg-white/55 p-3.5"
    >
      <header className="flex flex-wrap items-center gap-2">
        <StepStatusBadge status={row.status} attempt={row.attempt} />
        {row.iteration !== null ? (
          <span className="text-[11.5px] text-ink-4">item {row.iteration + 1}</span>
        ) : null}
        {duration !== null ? (
          <span className="text-[11.5px] tabular-nums text-ink-4">{duration}</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-ink-4">
          {row.path}
        </span>
      </header>

      {row.error !== null ? (
        <p className="rounded-card border border-err/30 bg-err/[0.05] px-2.5 py-2 text-[12.5px] text-ink [overflow-wrap:anywhere]">
          {row.errorClass !== null ? (
            <span className="font-mono text-[11px] text-err">{row.errorClass}</span>
          ) : null}{" "}
          {row.error}
        </p>
      ) : null}

      {step.kind === "agent" && row.childRunId !== null ? (
        <ChildRunThread workspaceId={workspaceId} childRunId={row.childRunId} />
      ) : (
        <>
          {row.input !== undefined ? (
            <JsonBlock label="Input" value={row.input} />
          ) : null}
          {row.output !== undefined && row.output !== null ? (
            <JsonBlock label="Output" value={row.output} />
          ) : row.outputPreview !== null ? (
            <JsonBlock label="Output preview" value={row.outputPreview} />
          ) : null}
        </>
      )}
    </section>
  );
}

// ── Agent-step drill-in (the child run's real chat rendering) ───────────────

/**
 * Minimal run identity for {@link reduceRunView}: the child run's own row is
 * not fetchable (no `GET /runs/:id`), so identity is synthesized and the
 * stream fills in the rest (`message.received` carries the task message; the
 * run_status frames carry status + error).
 */
function syntheticChildRun(childRunId: string, workspaceId: string) {
  const triggerEvent: TriggerEvent = {
    agentId: "00000000-0000-4000-8000-000000000000",
    workflowId: null,
    triggerType: "manual",
    message: "",
    data: {},
    principal: { workspaceId, source: "pipeline" },
  };
  return { id: childRunId, status: "running" as RunStatus, triggerEvent, error: null };
}

function ChildRunThread({
  workspaceId,
  childRunId,
}: {
  workspaceId: string;
  childRunId: string;
}) {
  const [store, setStore] = useState<FrameStore>(EMPTY_FRAME_STORE);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const postInput = usePostRunInput(workspaceId);

  // A terminal child replays its whole event history and closes; a live one
  // keeps streaming — either way the same reduction renders it.
  useEffect(() => {
    setStore(EMPTY_FRAME_STORE);
    setStatus(null);
    setError(null);
    setStreamError(null);
    const handle = streamRun(childRunId, {
      onRunEvent: (frame) => setStore((current) => addFrame(current, frame)),
      onRunStatus: (frame) => {
        setStatus(frame.status);
        setError(frame.error ?? null);
      },
      onError: (cause) => setStreamError(cause.message),
    });
    return () => handle.close();
  }, [childRunId]);

  const view = useMemo(() => {
    const base = syntheticChildRun(childRunId, workspaceId);
    return reduceRunView(
      { ...base, status: status ?? base.status, error },
      store,
    );
  }, [childRunId, workspaceId, status, error, store]);

  if (streamError !== null) {
    return (
      <p className="text-[12.5px] text-ink-3">
        The agent session's transcript could not be streamed: {streamError}
      </p>
    );
  }

  return (
    <div data-testid="child-run-thread" className="rounded-card bg-black/[0.02] p-3">
      <RunMessage
        run={view}
        isChatOrigin={false}
        onRespond={(runId, response) =>
          postInput.mutate({ runId, input: response })
        }
      />
    </div>
  );
}
