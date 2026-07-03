/**
 * Left pillar rail (270px glass): workflow name + draft/vN chip, four live
 * summary cards (each with ✓ valid / amber warning state; the ACTIVE card
 * "solidifies"), and Run draft + Publish capsules at the bottom with inline
 * build progress.
 */
import {
  AlertTriangle,
  Bot,
  Check,
  FileText,
  Play,
  Plug,
  Rocket,
  Zap,
} from "lucide-react";
import type { ComponentType } from "react";
import type {
  AgentPresetDto,
  McpConnectionDto,
  ModelPresetDto,
  SkillDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import {
  countIssues,
  pillarIssueCount,
  type BuilderDiagnostics,
} from "../../lib/builder/diagnostics";
import { PILLAR_LABELS, PILLARS, type Pillar } from "../../lib/builder/model";
import {
  isPublishBusy,
  publishPhaseLabel,
  type PublishState,
} from "../../lib/builder/publish-machine";
import {
  agentSummary,
  contextChips,
  instructionsSummary,
  triggerSummary,
} from "../../lib/builder/summary";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { StatusChip } from "../ui/StatusChip";

const PILLAR_ICONS: Record<Pillar, ComponentType<{ size?: number }>> = {
  trigger: Zap,
  context: Plug,
  agent: Bot,
  instructions: FileText,
};

export interface PillarRailProps {
  name: string;
  publishedVersionId: string | null;
  isDirty: boolean;
  definition: WorkflowDefinition;
  diagnostics: BuilderDiagnostics;
  activePillar: Pillar;
  onFocusPillar: (pillar: Pillar) => void;
  connections: readonly McpConnectionDto[];
  skills: readonly SkillDto[];
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  publishState: PublishState;
  onPublish: () => void;
  onRunDraft: () => void;
  runDraftPending: boolean;
  canPublish: boolean;
  /** Pillar to flash/settle after a copilot suggestion lands (or null). */
  flashPillar?: Pillar | null;
}

export function PillarRail(props: PillarRailProps) {
  const {
    name,
    publishedVersionId,
    isDirty,
    definition,
    diagnostics,
    activePillar,
    onFocusPillar,
    publishState,
    onPublish,
    onRunDraft,
    runDraftPending,
    canPublish,
  } = props;

  const issues = countIssues(diagnostics);

  return (
    <div className="glass-panel panel-enter flex w-[270px] shrink-0 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex flex-col gap-2 px-4 pb-3 pt-4">
        <h1 className="truncate text-[15px] font-semibold" title={name}>
          {name}
        </h1>
        <div className="flex items-center gap-1.5">
          {publishedVersionId ? (
            <StatusChip tone="success" dot>
              Published
            </StatusChip>
          ) : (
            <StatusChip tone="neutral" dot>
              Draft
            </StatusChip>
          )}
          {isDirty ? <StatusChip tone="warning">Unsaved</StatusChip> : null}
        </div>
      </header>

      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />

      {/* Pillar cards */}
      <nav
        aria-label="Workflow pillars"
        className="thin-scroll flex flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {PILLARS.map((pillar) => (
          <PillarCard
            key={pillar}
            pillar={pillar}
            active={pillar === activePillar}
            flash={pillar === props.flashPillar}
            issueCount={pillarIssueCount(diagnostics, pillar)}
            summary={
              <PillarSummary
                pillar={pillar}
                definition={definition}
                connections={props.connections}
                skills={props.skills}
                agentPresets={props.agentPresets}
                modelPresets={props.modelPresets}
              />
            }
            onClick={() => onFocusPillar(pillar)}
          />
        ))}
      </nav>

      {/* Publish progress / build errors */}
      {publishState.phase === "error" ? (
        <div className="mx-3 mb-2 rounded-card border border-err/30 bg-err/[0.06] px-3 py-2">
          <p className="text-[12px] font-medium text-err">Publish failed</p>
          <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-ink-2">
            {publishState.error}
          </p>
        </div>
      ) : null}
      {publishState.phase === "ready" ? (
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded-card border border-ok/30 bg-ok/[0.06] px-3 py-2">
          <Check size={13} className="text-ok" aria-hidden="true" />
          <p className="text-[12px] text-ink-2">
            {publishState.result?.cached
              ? "Published — build served from cache."
              : "Published and built."}
          </p>
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-col gap-2 border-t border-black/[0.06] p-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRunDraft}
          loading={runDraftPending}
          className="w-full"
        >
          {!runDraftPending ? <Play size={14} aria-hidden="true" /> : null}
          Run draft
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onPublish}
          disabled={!canPublish || isPublishBusy(publishState)}
          className="w-full"
        >
          {isPublishBusy(publishState) ? (
            <Spinner size={13} />
          ) : (
            <Rocket size={14} aria-hidden="true" />
          )}
          {publishPhaseLabel(publishState)}
        </Button>
        {issues > 0 ? (
          <p className="px-1 text-center text-[11.5px] text-warn">
            {issues} issue{issues === 1 ? "" : "s"} to resolve before publishing
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

function PillarCard({
  pillar,
  active,
  flash,
  issueCount,
  summary,
  onClick,
}: {
  pillar: Pillar;
  active: boolean;
  flash?: boolean;
  issueCount: number;
  summary: React.ReactNode;
  onClick: () => void;
}) {
  const Icon = PILLAR_ICONS[pillar];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "lift group flex flex-col gap-1.5 rounded-card border p-3 text-left",
        flash && "pillar-flash",
        active
          ? "border-ink/85 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.07)]"
          : "border-white/60 bg-white/35 hover:bg-white/55",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} aria-hidden="true" />
        <span className="flex-1 text-[13px] font-semibold text-ink">
          {PILLAR_LABELS[pillar]}
        </span>
        {issueCount > 0 ? (
          <span
            className="flex items-center gap-1 text-warn"
            title={`${issueCount} issue${issueCount === 1 ? "" : "s"}`}
          >
            <AlertTriangle size={13} aria-hidden="true" />
            <span className="text-[11px] font-semibold">{issueCount}</span>
          </span>
        ) : (
          <Check
            size={14}
            className="text-ok"
            aria-label="Valid"
          />
        )}
      </div>
      <div className="text-[12px] leading-snug text-ink-3">{summary}</div>
    </button>
  );
}

// ── Per-pillar summary bodies ───────────────────────────────────────────────

function PillarSummary({
  pillar,
  definition,
  connections,
  skills,
  agentPresets,
  modelPresets,
}: {
  pillar: Pillar;
  definition: WorkflowDefinition;
  connections: readonly McpConnectionDto[];
  skills: readonly SkillDto[];
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
}) {
  if (pillar === "trigger") {
    const summary = triggerSummary(definition);
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusChip tone="ink">{summary.typeLabel}</StatusChip>
        <span className="truncate">{summary.detail}</span>
      </span>
    );
  }

  if (pillar === "context") {
    const chips = contextChips(definition, connections, skills);
    if (chips.length === 0) return <span>No connections or skills</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {chips.slice(0, 4).map((chip) => (
          <span
            key={`${chip.kind}-${chip.id}`}
            className="inline-flex items-center gap-1 rounded-capsule bg-chip px-1.5 py-0.5 text-[11px] text-ink"
            title={chip.gating ? `${chip.name} · ${chip.gating}` : chip.name}
          >
            {chip.name}
            {chip.gating ? (
              <span className="text-warn" title={chip.gating}>
                ⏸
              </span>
            ) : null}
          </span>
        ))}
        {chips.length > 4 ? <span>+{chips.length - 4}</span> : null}
      </span>
    );
  }

  if (pillar === "agent") {
    const summary = agentSummary(definition, agentPresets, modelPresets);
    return (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ink-2">{summary.presetName}</span>
        <span className="font-mono text-[11px] text-ink-3">
          {summary.modelChain}
        </span>
      </span>
    );
  }

  const summary = instructionsSummary(definition);
  if (summary.isEmpty) return <span className="text-ink-4">Empty</span>;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="truncate">{summary.preview}</span>
      <span className="text-[11px] text-ink-4">
        {summary.lineCount} line{summary.lineCount === 1 ? "" : "s"}
        {summary.refCount > 0
          ? ` · ${summary.refCount} @ref${summary.refCount === 1 ? "" : "s"}`
          : ""}
      </span>
    </span>
  );
}
