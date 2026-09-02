/**
 * AGENT step inspector: a published-agent card picker (the AgentSection
 * pattern — roving-tabindex radio cards, stale/empty states designed), the
 * instructions Tiptap (placeholder/ariaLabel are module constants — the
 * never-change-after-mount invariant), and the fresh/thread session toggle
 * where it is legal (Slack trigger, no output schema).
 *
 * The instructions' `@connection`/`@skill` sources resolve against the BOUND
 * agent's PUBLISHED context (mirroring dispatch — `useSelectedAgentContext`),
 * mapped to names through the workspace resource inventory and overlaid onto
 * the controller's positional sources.
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, ExternalLink } from "lucide-react";
import type { AgentStep, AgentSummaryDto, TriggerConfig } from "@invisible-string/shared";

import { useSelectedAgentContext } from "../../../lib/builder/agent-context";
import type { StepParamsPatch } from "../../../lib/builder/model";
import type { NamedResource, ReferenceSources } from "../../../lib/builder/references";
import type { ContextResources } from "../../../lib/builder/resources";
import type { StepReferenceContext } from "../../../lib/builder/useBuilderController";
import { cn } from "../../../lib/cn";
import { AgentMonogram } from "../../agents/AgentMonogram";
import { InstructionsEditor } from "../../builder/InstructionsEditor";
import { Skeleton } from "../../ui/Skeleton";
import { StatusChip } from "../../ui/StatusChip";
import { Switch } from "../../ui/Switch";

/** NEVER derive these from state — changing either destroys the draft. */
const INSTRUCTIONS_PLACEHOLDER =
  "What should the agent do?  Type @ to reference the trigger, earlier steps, or its connections and skills.";
const INSTRUCTIONS_ARIA_LABEL = "Agent instructions editor";

export interface AgentStepFormProps {
  step: AgentStep;
  /** Workspace agent inventory; null while loading. */
  agents: readonly AgentSummaryDto[] | null;
  /** Workspace/user resources (resolves the bound agent's context ids to names). */
  resources: ContextResources;
  workspaceId: string;
  /** The draft's trigger type — decides whether "thread" sessions are legal. */
  triggerType: TriggerConfig["type"];
  /** The controller's positional source derivation. */
  referenceSourcesFor: (
    stepId: string,
    context?: StepReferenceContext,
  ) => ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function AgentStepForm({
  step,
  agents,
  resources,
  workspaceId,
  triggerType,
  referenceSourcesFor,
  onPatch,
}: AgentStepFormProps) {
  // The bound agent's PUBLISHED context, name-resolved for the chip sources.
  const agentContext = useSelectedAgentContext(workspaceId, step.agentId);
  const stepContext = useMemo((): StepReferenceContext => {
    const named = <T extends NamedResource>(
      ids: readonly string[],
      byId: ReadonlyMap<string, T>,
    ): NamedResource[] =>
      ids
        .map((id) => byId.get(id))
        .filter((entry): entry is T => entry !== undefined);
    return {
      connections: named(agentContext?.mcpConnectionIds ?? [], resources.connectionById),
      skills: named(agentContext?.skillIds ?? [], resources.skillById),
    };
  }, [agentContext, resources.connectionById, resources.skillById]);
  const sources = referenceSourcesFor(step.id, stepContext);

  const threadLegal = triggerType === "slack" && step.output === undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-[13px] font-medium text-ink-2">Agent</span>
        <AgentPicker
          agents={agents}
          selectedAgentId={step.agentId}
          onSelect={(agentId) => onPatch({ agentId })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-[13px] font-medium text-ink-2">
          Instructions
        </span>
        <InstructionsEditor
          value={step.instructions.markdown}
          onChange={(markdown) => onPatch({ instructions: { markdown } })}
          sources={sources}
          placeholder={INSTRUCTIONS_PLACEHOLDER}
          ariaLabel={INSTRUCTIONS_ARIA_LABEL}
        />
      </div>

      {triggerType === "slack" || step.session === "thread" ? (
        <label className="flex items-start justify-between gap-4 rounded-card border border-black/[0.07] bg-white/40 px-3.5 py-3">
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-ink">
              Continue the Slack thread
            </span>
            <span className="text-[11.5px] leading-snug text-ink-3">
              {threadLegal
                ? "Replies in the same thread reuse one session, so the agent keeps its context."
                : triggerType !== "slack"
                  ? "Thread sessions need a Slack trigger."
                  : "Thread sessions can't declare structured output."}
            </span>
          </span>
          <Switch
            label="Continue the Slack thread"
            checked={step.session === "thread"}
            disabled={!threadLegal && step.session !== "thread"}
            onChange={(checked) =>
              onPatch({ session: checked ? "thread" : "fresh" })
            }
          />
        </label>
      ) : null}
    </div>
  );
}

// ── Picker (AgentSection's card-radio pattern, agentId → patchStepParams) ────

function AgentPicker({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: readonly AgentSummaryDto[] | null;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
}) {
  if (agents === null) {
    return (
      <div className="flex flex-col gap-2" aria-hidden="true">
        <GhostRow />
        <GhostRow />
      </div>
    );
  }

  const published = agents.filter((agent) => agent.publishedVersionId !== null);
  const selected = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;
  const selectedIsStale =
    selectedAgentId !== null &&
    (selected === null || selected.publishedVersionId === null);

  if (published.length === 0 && !selectedIsStale) {
    return <NoPublishedAgents />;
  }

  const selectedIndex = published.findIndex((agent) => agent.id === selectedAgentId);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  // Same ARIA contract as AgentSection: one tab stop, arrows move focus AND
  // selection.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const focused = radios.findIndex((el) => el === document.activeElement);
    const index = focused >= 0 ? focused : tabbableIndex;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % published.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + published.length) % published.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = published.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    radios[next]?.focus();
    const target = published[next];
    if (target !== undefined) onSelect(target.id);
  }

  return (
    <div className="flex flex-col gap-2">
      {selectedIsStale ? <StaleAgentRow agent={selected} /> : null}
      <div
        role="radiogroup"
        aria-label="Agent"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2"
      >
        {published.map((agent, index) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            selected={agent.id === selectedAgentId}
            tabbable={index === tabbableIndex}
            onSelect={() => onSelect(agent.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentRow({
  agent,
  selected,
  tabbable,
  onSelect,
}: {
  agent: AgentSummaryDto;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={cn(
          "lift flex w-full items-start gap-2.5 rounded-card-lg border p-3 text-left",
          selected
            ? "border-ink/80 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
            : "border-black/10 bg-white/40 hover:border-black/20 hover:bg-white/60",
        )}
      >
        <AgentMonogram name={agent.name} size="sm" active={selected} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-[13px] font-semibold text-ink", selected && "pr-20")}>
            {agent.name}
          </span>
          {agent.description ? (
            <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">
              {agent.description}
            </span>
          ) : null}
        </span>
      </button>
      {selected ? (
        // A focusable link nested inside the radio would violate WCAG 4.1.2
        // (nested-interactive) — overlay it as a sibling, like AgentSection.
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className="lift absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink"
        >
          Edit agent <ExternalLink size={10} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function StaleAgentRow({ agent }: { agent: AgentSummaryDto | null }) {
  return (
    <div
      data-testid="stale-agent-card"
      className="flex items-start gap-2.5 rounded-card-lg border border-black/10 bg-white/30 p-3 opacity-70"
    >
      <AgentMonogram name={agent?.name ?? "?"} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-ink">
          {agent ? agent.name : "Unknown agent"}
        </span>
        <span className="text-[11.5px] leading-snug text-ink-3">
          {agent
            ? "This agent hasn't been published — publish it, or pick another below."
            : "The selected agent no longer exists — pick another below."}
        </span>
        <span className="mt-0.5">
          <StatusChip tone={agent ? "warning" : "error"} dot>
            {agent ? "Not published" : "Missing"}
          </StatusChip>
        </span>
      </span>
    </div>
  );
}

function NoPublishedAgents() {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-card border border-dashed border-black/15 px-4 py-6 text-center">
      <span className="flex size-9 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
        <Bot size={15} aria-hidden="true" />
      </span>
      <p className="text-[12.5px] font-medium text-ink">No published agents yet</p>
      <p className="max-w-xs text-[11.5px] leading-relaxed text-ink-3">
        An agent step delegates to a published Agent. Publish one, then pick it
        here.
      </p>
      <Link
        to="/agents"
        className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-3 py-1.5 text-[12px] font-medium text-ink"
      >
        Open Agents <ExternalLink size={11} aria-hidden="true" />
      </Link>
    </div>
  );
}

function GhostRow() {
  return (
    <div className="flex items-start gap-2.5 rounded-card-lg border border-black/10 bg-white/40 p-3">
      <Skeleton className="size-7 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}
