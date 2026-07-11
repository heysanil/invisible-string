/**
 * Left agent rail (270px glass): monogram + name + lifecycle chips, four
 * live section cards (Persona · Model · Context · Access — each with
 * ✓ valid / amber issue badge and a live summary) that anchor-scroll the
 * center column, and "Chat with agent" + Publish capsules at the bottom with
 * inline build progress (builds belong to agents now).
 */
import {
  AlertTriangle,
  Check,
  Cpu,
  FileText,
  MessageCircle,
  Plug,
  Rocket,
  UserRound,
} from "lucide-react";
import type { ComponentType } from "react";
import type {
  ModelPresetDto,
  WorkspaceMemberDto,
} from "@invisible-string/shared";

import {
  countAgentIssues,
  sectionIssueCount,
  type AgentDiagnostics,
} from "../../lib/agents/diagnostics";
import {
  AGENT_SECTIONS,
  AGENT_SECTION_LABELS,
  type AgentEditorState,
  type AgentSection,
} from "../../lib/agents/model";
import {
  isPublishBusy,
  publishPhaseLabel,
  type PublishState,
} from "../../lib/agents/publish-machine";
import type { ContextResources } from "../../lib/builder/resources";
import { PRESET_LABEL } from "../../lib/labels";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { StatusChip } from "../ui/StatusChip";
import { AgentMonogram } from "./AgentMonogram";
import { resolvedModelLine } from "./ModelSection";

const SECTION_ICONS: Record<AgentSection, ComponentType<{ size?: number }>> = {
  persona: FileText,
  model: Cpu,
  context: Plug,
  access: UserRound,
};

export interface AgentRailProps {
  name: string;
  publishedVersionId: string | null;
  isDirty: boolean;
  state: AgentEditorState;
  diagnostics: AgentDiagnostics;
  /** The section the center column currently rests on (aria-current card). */
  activeSection: AgentSection;
  /** Anchor-scrolls the center column to the section. */
  onSelectSection: (section: AgentSection) => void;
  resources: ContextResources;
  members: readonly WorkspaceMemberDto[];
  modelPresets: readonly ModelPresetDto[];
  publishState: PublishState;
  onPublish: () => void;
  canPublish: boolean;
  onChatWithAgent: () => void;
  chatPending: boolean;
  /** Section to flash/settle after a copilot suggestion lands (or null). */
  flashSection?: AgentSection | null;
}

export function AgentRail(props: AgentRailProps) {
  const {
    name,
    publishedVersionId,
    isDirty,
    state,
    diagnostics,
    activeSection,
    onSelectSection,
    publishState,
    onPublish,
    canPublish,
    onChatWithAgent,
    chatPending,
  } = props;

  const issues = countAgentIssues(diagnostics);

  return (
    <div className="glass-panel panel-enter flex w-[270px] shrink-0 flex-col overflow-hidden">
      {/* Header */}
      <header className="flex flex-col gap-2 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2.5">
          <AgentMonogram name={name} active={publishedVersionId !== null} />
          <h1 className="min-w-0 truncate text-[15px] font-semibold" title={name}>
            {name}
          </h1>
        </div>
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

      {/* Section cards */}
      <nav
        aria-label="Agent sections"
        className="thin-scroll flex flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        {AGENT_SECTIONS.map((section) => (
          <SectionCard
            key={section}
            section={section}
            active={section === activeSection}
            flash={section === props.flashSection}
            issueCount={sectionIssueCount(diagnostics, section)}
            summary={
              <SectionSummary
                section={section}
                state={state}
                resources={props.resources}
                members={props.members}
                modelPresets={props.modelPresets}
              />
            }
            onClick={() => onSelectSection(section)}
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
          onClick={onChatWithAgent}
          loading={chatPending}
          className="w-full"
        >
          {!chatPending ? <MessageCircle size={14} aria-hidden="true" /> : null}
          Chat with agent
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

function SectionCard({
  section,
  active,
  flash,
  issueCount,
  summary,
  onClick,
}: {
  section: AgentSection;
  active: boolean;
  flash?: boolean;
  issueCount: number;
  summary: React.ReactNode;
  onClick: () => void;
}) {
  const Icon = SECTION_ICONS[section];
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
          {AGENT_SECTION_LABELS[section]}
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
          <Check size={14} className="text-ok" aria-label="Valid" />
        )}
      </div>
      <div className="text-[12px] leading-snug text-ink-3">{summary}</div>
    </button>
  );
}

// ── Per-section summary bodies ──────────────────────────────────────────────

function SectionSummary({
  section,
  state,
  resources,
  members,
  modelPresets,
}: {
  section: AgentSection;
  state: AgentEditorState;
  resources: ContextResources;
  members: readonly WorkspaceMemberDto[];
  modelPresets: readonly ModelPresetDto[];
}) {
  const definition = state.definition;

  if (section === "persona") {
    const persona = definition.persona;
    const trimmed = persona.trim();
    if (trimmed.length === 0) {
      return <span className="text-ink-4">Empty — required to publish</span>;
    }
    const firstLine =
      persona.split("\n").find((line) => line.trim().length > 0) ?? "";
    const preview =
      firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
    return (
      <span className="flex flex-col gap-0.5">
        <span className="truncate">{preview}</span>
        <span className="text-[11px] text-ink-4">
          {persona.length.toLocaleString()} character
          {persona.length === 1 ? "" : "s"}
        </span>
      </span>
    );
  }

  if (section === "model") {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-ink-2">
          {PRESET_LABEL[definition.model.preset]}
        </span>
        <span className="font-mono text-[11px] text-ink-3">
          {resolvedModelLine(definition.model, modelPresets)}
        </span>
      </span>
    );
  }

  if (section === "context") {
    const chips = [
      ...definition.context.mcpConnectionIds.map((id) => ({
        kind: "connection" as const,
        id,
        name: resources.connectionById.get(id)?.name ?? "missing",
      })),
      ...definition.context.skillIds.map((id) => ({
        kind: "skill" as const,
        id,
        name: resources.skillById.get(id)?.name ?? "missing",
      })),
    ];
    if (chips.length === 0) return <span>No connections or skills</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {chips.slice(0, 4).map((chip) => (
          <span
            key={`${chip.kind}-${chip.id}`}
            className="inline-flex items-center gap-1 rounded-capsule bg-chip px-1.5 py-0.5 text-[11px] text-ink"
            title={chip.name}
          >
            {chip.name}
          </span>
        ))}
        {chips.length > 4 ? <span>+{chips.length - 4}</span> : null}
      </span>
    );
  }

  const member = members.find((m) => m.userId === state.runAsUserId);
  return (
    <span className="truncate">
      {member ? `Runs as ${member.email}` : "Runs as a former member"}
    </span>
  );
}
