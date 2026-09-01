/**
 * The workflow EDITOR (pipelines redesign): conversational-first, two panes.
 *
 * - Left, primary (flex-1, min 400px): the copilot conversation — the shared
 *   CopilotThread + CopilotComposer pair at panel width, no collapse pill,
 *   the allow-edits switch in the header (initial value ON only for
 *   never-published drafts). The pane owns `useCopilot` HERE, in the route,
 *   because the strip's ghost cards are derived from the thread's pending
 *   step proposals — the shell must see `copilot.items`.
 * - Right (clamp(360px,34vw,460px)): the pipeline at rest — TriggerCard on
 *   top, the vertical PipelineStrip under it; the selected card expands an
 *   inline inspector accordion (deep prompt editors get a max-height and an
 *   "Open full editor" Drawer escape hatch — the Drawer REPLACES the inline
 *   form while open, keeping exactly one Tiptap inspector mounted).
 * - <1180px (the dock's narrow-viewport breakpoint): a Compose | Pipeline
 *   segmented control with pending-count badges swaps the panes.
 *
 * A run started from the header's Run popover overlays the strip in run
 * density (live progress via lib/pipeline) until dismissed.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Sparkles, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PipelineStep, WorkflowConfig } from "@invisible-string/shared";

import { DiagnosticsList } from "../components/builder/DiagnosticsList";
import { StepTestPopover } from "../components/builder/StepTestPopover";
import {
  AllowEditsSwitch,
  AutoApplyBanner,
  CopilotComposer,
  ReconnectingBanner,
  type CopilotComposerHandle,
  type CopilotPrefill,
} from "../components/copilot/CopilotComposer";
import { CopilotThread } from "../components/copilot/CopilotThread";
import {
  PipelineStrip,
  StepInspector,
  TriggerCard,
  type PipelineGhost,
} from "../components/pipeline";
import { LiveTriggerConfig } from "../components/builder/LiveTriggerConfig";
import { Button } from "../components/ui/Button";
import { Drawer } from "../components/ui/Drawer";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { StatusChip } from "../components/ui/StatusChip";
import { useCopilot } from "../lib/copilot/useCopilot";
import {
  describeStepPosition,
  isWorkflowProposal,
  stepCardData,
  stepDisplayTitle,
  workflowCopilotAdapter,
  type WorkflowApplyTarget,
} from "../lib/copilot/mutations";
import { RUN_STATUS_TONE } from "../lib/pipeline/run-display";
import { usePipelineRunProgress } from "../lib/pipeline/use-run-progress";
import { useWorkflowShell } from "../lib/pipeline/workflow-shell";
import { useModelPresets } from "../lib/queries/models";
import type { StepSummaryContext } from "../lib/builder/summary";
import { findStep } from "@invisible-string/shared";
import { cn } from "../lib/cn";

export const Route = createFileRoute("/_app/workflows/$workflowId/")({
  component: WorkflowEditor,
});

/**
 * Same breakpoint as CopilotDock's narrow-viewport collapse — below it the
 * two panes cannot sit side by side, so a segmented control swaps them.
 */
const NARROW_VIEWPORT_QUERY = "(max-width: 1179px)";

function WorkflowEditor() {
  const shell = useWorkflowShell();
  const {
    workspaceId,
    workflow,
    controller,
    resources,
    agents,
    isPublished,
    startedRun,
    dismissStartedRun,
  } = shell;
  const { state, dispatch, diagnostics } = controller;
  const definition = state.definition;

  const presets = useModelPresets(workspaceId);

  // ── selection (at most ONE thing expanded: trigger or one step) ──────────

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [triggerExpanded, setTriggerExpanded] = useState(false);
  const [drawerStepId, setDrawerStepId] = useState<string | null>(null);

  function selectStep(stepId: string) {
    setTriggerExpanded(false);
    setDrawerStepId(null);
    setSelectedStepId((current) => (current === stepId ? null : stepId));
  }

  // A removed/never-inserted selection self-heals (e.g. copilot removeStep).
  const selectedStep =
    selectedStepId !== null ? findStep(definition.steps, selectedStepId) : null;
  useEffect(() => {
    if (selectedStepId !== null && selectedStep === null) {
      setSelectedStepId(null);
      setDrawerStepId(null);
    }
  }, [selectedStepId, selectedStep]);

  // ── copilot (route-owned: the strip's ghosts read the thread) ────────────

  const [composerText, setComposerText] = useState("");
  const [prefill, setPrefill] = useState<CopilotPrefill | null>(null);
  // Initial value only — surface-aware default (ON for never-published
  // drafts), session-scoped after; publishing mid-session must not flip it.
  const [allowEdits, setAllowEdits] = useState(() => !isPublished);
  const composerRef = useRef<CopilotComposerHandle | null>(null);

  const [flashTrigger, setFlashTrigger] = useState(false);
  const [flashStepId, setFlashStepId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onApplied(target: WorkflowApplyTarget) {
    setFlashTrigger(false);
    setFlashStepId(null);
    // Cancel BOTH timers: a stale clear-timer from the previous apply would
    // otherwise cut the new flash short mid-animation.
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (flashClearTimer.current) clearTimeout(flashClearTimer.current);
    // Re-arm on the next frame so consecutive applies re-trigger the animation.
    flashTimer.current = setTimeout(() => {
      if (target.kind === "trigger") setFlashTrigger(true);
      else setFlashStepId(target.stepId);
    }, 16);
    flashClearTimer.current = setTimeout(() => {
      setFlashTrigger(false);
      setFlashStepId(null);
    }, 900);
  }

  // The adapter reads the LIVE draft through a ref — never a stale capture.
  const draftRef = useRef<WorkflowConfig>(definition);
  draftRef.current = definition;
  const adapter = workflowCopilotAdapter({
    workflowId: workflow.id,
    getDraft: () => draftRef.current,
    dispatch,
    agents: agents ?? [],
    connections: resources.connections,
    onApplied,
  });

  const copilot = useCopilot({
    workspaceId,
    adapter,
    // The pane cannot collapse — the socket lives as long as the editor.
    enabled: true,
    allowEdits,
  });

  function askCopilot(text: string) {
    setNarrowTab("compose");
    setPrefill((current) => ({ id: (current?.id ?? 0) + 1, text }));
  }

  useEffect(() => {
    if (!prefill) return;
    setComposerText(prefill.text);
    composerRef.current?.focus();
  }, [prefill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleAllowEdits() {
    // Computed outside the updater: updaters must stay pure (StrictMode
    // double-invokes them), and this one announces.
    const next = !allowEdits;
    setAllowEdits(next);
    composerRef.current?.announce(
      next
        ? "Auto-apply on — copilot edits the draft without asking"
        : "Auto-apply off — copilot asks before every edit",
    );
  }

  // ── ghost proposals (pending step mutations → dashed strip cards) ────────

  const summaryCtx: StepSummaryContext = useMemo(
    () => ({
      connections: resources.isPending ? null : resources.connections,
      agents,
    }),
    [resources.isPending, resources.connections, agents],
  );

  const pendingProposals = copilot.items.filter(
    (item): item is Extract<(typeof copilot.items)[number], { kind: "suggestion" }> =>
      item.kind === "suggestion" &&
      (item.status === "pending" || item.status === "applying"),
  );

  const ghosts: PipelineGhost[] = [];
  for (const item of pendingProposals) {
    const proposal = item.proposal;
    if (!isWorkflowProposal(proposal)) continue;
    switch (proposal.tool) {
      case "addStep": {
        const card = stepCardData(proposal.params.step, {
          agents: agents ?? [],
          connections: resources.connections,
        });
        ghosts.push({
          key: item.id,
          mode: "add",
          kind: proposal.params.step.kind,
          title: card.title,
          summary: card.summary,
          position: proposal.params.position,
        });
        break;
      }
      case "updateStep":
        ghosts.push({
          key: item.id,
          mode: "update",
          kind: proposal.params.step.kind,
          title: stepDisplayTitle(proposal.params.step),
          targetStepId: proposal.params.stepId,
        });
        break;
      case "removeStep": {
        const current = findStep(definition.steps, proposal.params.stepId);
        if (current === null) break;
        ghosts.push({
          key: item.id,
          mode: "remove",
          kind: current.kind,
          title: stepDisplayTitle(current),
          targetStepId: proposal.params.stepId,
        });
        break;
      }
      case "moveStep": {
        const current = findStep(definition.steps, proposal.params.stepId);
        if (current === null) break;
        ghosts.push({
          key: item.id,
          mode: "move",
          kind: current.kind,
          title: stepDisplayTitle(current),
          summary: describeStepPosition(proposal.params.position, definition.steps),
          position: proposal.params.position,
          targetStepId: proposal.params.stepId,
        });
        break;
      }
      case "setTrigger":
        break; // Trigger proposals preview on their card, not the strip.
    }
  }

  // ── just-started run overlay ─────────────────────────────────────────────

  const progress = usePipelineRunProgress(startedRun);
  const runOverlayActive = startedRun !== null;

  // ── narrow viewport segmentation ─────────────────────────────────────────

  const [narrow, setNarrow] = useState(false);
  const [narrowTab, setNarrowTab] = useState<"compose" | "pipeline">("compose");
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const issueCount =
    diagnostics.trigger.length +
    diagnostics.general.length +
    Object.values(diagnostics.byStep).reduce((sum, list) => sum + list.length, 0);

  // ── inspector (inline accordion; Drawer escape hatch for deep editors) ───

  const drawerStep =
    drawerStepId !== null ? findStep(definition.steps, drawerStepId) : null;

  function inspectorFor(step: PipelineStep): ReactNode {
    if (drawerStepId === step.id && drawerStep !== null) {
      // The Drawer holds the ONE mounted inspector — a second inline copy
      // would break the one-Tiptap-inspector invariant.
      return (
        <p className="rounded-card border border-dashed border-black/15 px-3 py-2 text-[12px] text-ink-4">
          Editing in the full editor…
        </p>
      );
    }
    const deep = step.kind === "infer" || step.kind === "agent";
    return (
      <div className="flex flex-col gap-1.5">
        <div className={cn(deep && "thin-scroll max-h-[50vh] overflow-y-auto")}>
          <StepInspector
            step={step}
            definition={definition}
            dispatch={dispatch}
            diagnostics={diagnostics.byStep[step.id] ?? []}
            resources={resources}
            agents={agents}
            presets={presets.data ?? null}
            workspaceId={workspaceId}
            referenceSourcesFor={controller.referenceSourcesFor}
            onAskCopilot={askCopilot}
          />
        </div>
        <div className="flex items-center justify-end gap-1.5 px-1">
          {step.kind === "tool" || step.kind === "infer" ? (
            <StepTestPopover
              workspaceId={workspaceId}
              workflowId={workflow.id}
              stepId={step.id}
              kind={step.kind}
              beforeTest={controller.flush}
            />
          ) : null}
          {deep ? (
            <button
              type="button"
              onClick={() => setDrawerStepId(step.id)}
              className="lift inline-flex items-center gap-1 rounded-capsule border border-black/10 bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink"
            >
              Open full editor <ExternalLink size={10} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  // ── panes ────────────────────────────────────────────────────────────────

  const composerPane = (
    <section
      aria-label="Copilot"
      className="glass-panel panel-enter flex h-full min-w-0 flex-1 flex-col overflow-hidden lg:min-w-[400px]"
    >
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="flex-1 text-[14px] font-semibold">Copilot</h2>
        <AllowEditsSwitch checked={allowEdits} onToggle={toggleAllowEdits} />
      </header>
      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />

      {allowEdits ? <AutoApplyBanner /> : null}
      {copilot.status === "reconnecting" ? <ReconnectingBanner /> : null}

      <CopilotThread
        copilot={copilot}
        adapter={adapter}
        onFocusComposer={() => composerRef.current?.focus()}
      />

      <CopilotComposer
        ref={composerRef}
        copilot={copilot}
        allowEdits={allowEdits}
        value={composerText}
        onChange={setComposerText}
      />
    </section>
  );

  const pipelinePane = (
    <section
      aria-label="Pipeline"
      data-testid="pipeline-pane"
      className={cn(
        "glass-panel panel-enter flex h-full min-w-0 flex-col overflow-hidden",
        !narrow && "w-[clamp(360px,34vw,460px)] shrink-0",
      )}
    >
      <div className="thin-scroll flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {runOverlayActive && startedRun !== null ? (
            <div
              data-testid="run-overlay-banner"
              className="flex items-center gap-2 rounded-card border border-black/[0.08] bg-white/55 px-3 py-2"
            >
              <StatusChip tone={RUN_STATUS_TONE[progress.status]} dot>
                {progress.status}
              </StatusChip>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                {progress.status === "queued" || progress.status === "running"
                  ? "Run in progress on the published version"
                  : "Run finished — dismiss to keep editing"}
              </span>
              <Link
                to="/workflows/$workflowId/runs/$runId"
                params={{ workflowId: workflow.id, runId: startedRun.id }}
                className="lift shrink-0 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 text-[11.5px] font-medium text-ink-2 hover:text-ink"
              >
                View run
              </Link>
              <button
                type="button"
                aria-label="Dismiss run overlay"
                onClick={dismissStartedRun}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {diagnostics.general.length > 0 ? (
            <DiagnosticsList
              diagnostics={diagnostics.general}
              onAskCopilot={askCopilot}
            />
          ) : null}

          <TriggerCard
            definition={definition}
            dispatch={dispatch}
            diagnostics={diagnostics.trigger}
            expanded={triggerExpanded && !runOverlayActive}
            onToggle={() => {
              setSelectedStepId(null);
              setDrawerStepId(null);
              setTriggerExpanded((current) => !current);
            }}
            flash={flashTrigger}
            onAskCopilot={askCopilot}
            live={
              definition.trigger.type === "webhook" ||
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
              ) : null
            }
          />

          <PipelineStrip
            steps={definition.steps}
            ctx={summaryCtx}
            dispatch={dispatch}
            diagnostics={diagnostics}
            selectedStepId={runOverlayActive ? null : selectedStepId}
            onSelectStep={selectStep}
            ghosts={runOverlayActive ? [] : ghosts}
            runStates={runOverlayActive ? progress.runStates : null}
            flashStepId={flashStepId}
            onDescribeInstead={() => askCopilot("")}
            renderInspector={runOverlayActive ? undefined : inspectorFor}
          />
        </div>
      </div>
    </section>
  );

  return (
    <div className="flex h-full flex-col gap-3">
      {narrow ? (
        <>
          <SegmentedControl<"compose" | "pipeline">
            size="sm"
            ariaLabel="Editor pane"
            className="self-center"
            value={narrowTab}
            options={[
              {
                value: "compose",
                label:
                  pendingProposals.length > 0
                    ? `Compose (${pendingProposals.length})`
                    : "Compose",
              },
              {
                value: "pipeline",
                label: issueCount > 0 ? `Pipeline (${issueCount})` : "Pipeline",
              },
            ]}
            onChange={setNarrowTab}
          />
          <div className="min-h-0 flex-1">
            {/* Both panes stay MOUNTED (hidden, not unmounted) so the copilot
                socket and the composer draft survive a tab flip. */}
            <div className={cn("h-full", narrowTab !== "compose" && "hidden")}>
              {composerPane}
            </div>
            <div className={cn("h-full", narrowTab !== "pipeline" && "hidden")}>
              {pipelinePane}
            </div>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {composerPane}
          {pipelinePane}
        </div>
      )}

      <Drawer
        open={drawerStep !== null}
        onClose={() => setDrawerStepId(null)}
        title={drawerStep !== null ? stepDisplayTitle(drawerStep) : "Step"}
        widthClassName="max-w-2xl"
      >
        {drawerStep !== null ? (
          <StepInspector
            step={drawerStep}
            definition={definition}
            dispatch={dispatch}
            diagnostics={diagnostics.byStep[drawerStep.id] ?? []}
            resources={resources}
            agents={agents}
            presets={presets.data ?? null}
            workspaceId={workspaceId}
            referenceSourcesFor={controller.referenceSourcesFor}
            onAskCopilot={(text) => {
              setDrawerStepId(null);
              askCopilot(text);
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
