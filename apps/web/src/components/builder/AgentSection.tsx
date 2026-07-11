/**
 * AGENT section of the workflow editor — "Who does the work". A card
 * radio-group of the workspace's PUBLISHED agents (monogram + name +
 * description + state chips); selecting one dispatches `setAgentId`. The
 * selected card grows an "Edit agent ↗" capsule into the agent editor.
 *
 * Degraded states are designed, not accidental:
 * - selected agent deleted → dimmed "Unknown agent" card with an error chip;
 * - selected agent unpublished → its dimmed card with a warning chip (the
 *   diagnostics list above the section carries the publish-blocking message);
 * - no published agents at all → an empty card linking to /agents.
 */
import { Link } from "@tanstack/react-router";
import { Bot, ExternalLink } from "lucide-react";
import type { AgentSummaryDto } from "@invisible-string/shared";

import type { BuilderAction } from "../../lib/builder/model";
import { cn } from "../../lib/cn";
import { AgentMonogram } from "../agents/AgentMonogram";
import { ErrorState } from "../ui/ErrorState";
import { Skeleton } from "../ui/Skeleton";
import { StatusChip } from "../ui/StatusChip";

export interface AgentSectionProps {
  /** Workspace agent inventory; null while loading. */
  agents: readonly AgentSummaryDto[] | null;
  /** The agents-list query FAILED (null + isError ≠ loading — show an error, not skeletons forever). */
  isError?: boolean;
  onRetry?: () => void;
  /** The draft's `agentId`. */
  selectedAgentId: string | null;
  dispatch: (action: BuilderAction) => void;
}

export function AgentSection({
  agents,
  isError = false,
  onRetry,
  selectedAgentId,
  dispatch,
}: AgentSectionProps) {
  if (agents === null && isError) {
    return (
      <ErrorState
        compact
        message="Couldn't load this workspace's agents."
        {...(onRetry ? { onRetry } : {})}
      />
    );
  }
  if (agents === null) {
    return (
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" aria-hidden="true">
        <GhostCard />
        <GhostCard />
      </div>
    );
  }

  const published = agents.filter((agent) => agent.publishedVersionId !== null);
  const selected = selectedAgentId
    ? (agents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;
  /** Selected but not offerable: deleted row or never-published draft. */
  const selectedIsStale =
    selectedAgentId !== null &&
    (selected === null || selected.publishedVersionId === null);

  if (published.length === 0 && !selectedIsStale) {
    return <NoPublishedAgents />;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {selectedIsStale ? (
        <StaleAgentCard agent={selected} />
      ) : null}

      {published.length === 0 ? (
        <NoPublishedAgents />
      ) : (
        <AgentRadioGroup
          agents={published}
          selectedAgentId={selectedAgentId}
          onSelect={(id) => dispatch({ type: "setAgentId", id })}
        />
      )}
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────────

/**
 * ARIA radio-group keyboard contract (same as the SegmentedControl
 * primitive): ONE tab stop (roving tabIndex on the selected card, first card
 * when nothing is selected) and Arrow/Home/End moving both focus and
 * selection — a screen reader announcing "radio, 1 of N" must get working
 * arrow keys, and a workspace full of agents must not flood the Tab order.
 */
function AgentRadioGroup({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: readonly AgentSummaryDto[];
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
}) {
  const selectedIndex = agents.findIndex((agent) => agent.id === selectedAgentId);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : 0;

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next: number;
    const current = (() => {
      const radios = Array.from(
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      );
      const focused = radios.findIndex((el) => el === document.activeElement);
      return { radios, index: focused >= 0 ? focused : tabbableIndex };
    })();
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current.index + 1) % agents.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current.index - 1 + agents.length) % agents.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = agents.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    current.radios[next]?.focus();
    const target = agents[next];
    if (target) onSelect(target.id);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Agent"
      onKeyDown={onKeyDown}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
    >
      {agents.map((agent, index) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedAgentId}
          tabbable={index === tabbableIndex}
          onSelect={() => onSelect(agent.id)}
        />
      ))}
    </div>
  );
}

function AgentCard({
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
  const buildFailed = agent.buildStatus === "failed";
  // The selected card's "Edit agent" capsule is a SIBLING of the radio,
  // absolutely positioned over the card's bottom-right corner — a focusable
  // link nested inside the radio button violates WCAG 4.1.2
  // (nested-interactive) and swallows selection clicks that land on it.
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={cn(
          "lift flex h-full w-full items-start gap-3 rounded-card-lg border p-3.5 text-left",
          selected
            ? "border-ink/80 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
            : "border-black/10 bg-white/40 hover:border-black/20 hover:bg-white/60",
        )}
      >
        <AgentMonogram name={agent.name} active={selected} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold text-ink">{agent.name}</span>
          {agent.description ? (
            <span className="line-clamp-2 text-[12px] leading-snug text-ink-3">
              {agent.description}
            </span>
          ) : null}
          <span
            className={cn(
              "mt-1 flex flex-wrap items-center gap-1.5",
              // Keep the chips clear of the overlaid edit capsule.
              selected && "pr-24",
            )}
          >
            {buildFailed ? (
              <StatusChip tone="error" dot>
                Build failed
              </StatusChip>
            ) : (
              <StatusChip tone="success" dot>
                Published
              </StatusChip>
            )}
          </span>
        </span>
      </button>
      {selected ? (
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className="lift absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink"
        >
          Edit agent <ExternalLink size={10} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/** The draft references an agent that can't do the work — keep it visible. */
function StaleAgentCard({ agent }: { agent: AgentSummaryDto | null }) {
  return (
    <div
      data-testid="stale-agent-card"
      className="flex items-start gap-3 rounded-card-lg border border-black/10 bg-white/30 p-3.5 opacity-70"
    >
      <AgentMonogram name={agent?.name ?? "?"} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13.5px] font-semibold text-ink">
          {agent ? agent.name : "Unknown agent"}
        </span>
        <span className="text-[12px] leading-snug text-ink-3">
          {agent
            ? "This agent hasn't been published — publish it in Agents, or pick another below."
            : "The selected agent no longer exists — pick another below."}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          {agent ? (
            <StatusChip tone="warning" dot>
              Not published
            </StatusChip>
          ) : (
            <StatusChip tone="error" dot>
              Missing
            </StatusChip>
          )}
          {agent ? (
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              className="lift inline-flex items-center gap-1 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink"
            >
              Open agent <ExternalLink size={10} aria-hidden="true" />
            </Link>
          ) : null}
        </span>
      </span>
    </div>
  );
}

function NoPublishedAgents() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-black/15 px-6 py-8 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
        <Bot size={17} aria-hidden="true" />
      </span>
      <p className="text-[13px] font-medium text-ink">No published agents yet</p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">
        A workflow delegates its work to a published agent. Create and publish
        one, then pick it here.
      </p>
      <Link
        to="/agents"
        className="lift inline-flex items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-4 py-2 text-[13px] font-medium text-ink"
      >
        Open Agents <ExternalLink size={12} aria-hidden="true" />
      </Link>
    </div>
  );
}

function GhostCard() {
  return (
    <div className="flex items-start gap-3 rounded-card-lg border border-black/10 bg-white/40 p-3.5">
      <Skeleton className="size-9 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}
