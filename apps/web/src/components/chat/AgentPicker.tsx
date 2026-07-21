/**
 * "New chat" agent picker — a glass modal listing PUBLISHED agents only (a
 * session pins the agent's published version). Searchable; each row shows
 * the agent's monogram, name, description, and resolved-model chip.
 * Selecting one starts a session against its published version.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, Search, X } from "lucide-react";

import {
  parseAgentDefinition,
  type AgentSummaryDto,
} from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { AgentMonogram } from "../agents/AgentMonogram";
import { EmptyState } from "../ui/EmptyState";
import { StatusChip } from "../ui/StatusChip";
import { Chip } from "./Chip";

/**
 * Model chip label for an agent definition: the explicit model override when
 * set, else the preset slug. Callers pass the PUBLISHED definition (a new
 * session pins the agent's published version — a draft-only model change
 * must not be promised here). Null when the definition is missing or
 * shape-invalid (the chip is simply omitted).
 */
export function agentModelLabel(definitionLike: unknown): string | null {
  const definition = parseAgentDefinition(definitionLike);
  if (definition === null) return null;
  return definition.model.modelId ?? definition.model.preset;
}

export interface AgentPickerProps {
  agents: readonly AgentSummaryDto[];
  /** Model chip labels by agent id (from each agent's draft definition). */
  modelLabels?: ReadonlyMap<string, string>;
  onPick: (agent: AgentSummaryDto) => void;
  onClose: () => void;
}

// Satisfies React's controlled-input contract; the real handler rides
// onInput, matching the shared Input primitive (React's onChange for text
// inputs never fires under happy-dom).
function noopChange() {}

export function AgentPicker({
  agents,
  modelLabels,
  onPick,
  onClose,
}: AgentPickerProps) {
  const [query, setQuery] = useState("");

  const published = useMemo(
    () => agents.filter((agent) => agent.publishedVersionId !== null),
    [agents],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return published;
    return published.filter((agent) => agent.name.toLowerCase().includes(q));
  }, [published, query]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Start a new chat"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/10 backdrop-blur-[2px]"
      />
      <div className="glass-panel panel-enter relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden">
        <header className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-[16px]">Start a new chat</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="lift flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="px-5 pb-3">
          <div className="flex h-9 items-center gap-2 rounded-capsule border border-black/10 bg-white/45 px-3">
            <Search size={14} aria-hidden="true" className="shrink-0 text-ink-4" />
            <input
              autoFocus
              value={query}
              onChange={noopChange}
              onInput={(event) =>
                setQuery((event.target as HTMLInputElement).value)
              }
              placeholder="Search published agents"
              aria-label="Search published agents"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>
        </div>

        <div className="mx-5 h-px bg-black/[0.06]" aria-hidden="true" />

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {published.length === 0 ? (
            <EmptyState
              icon={Bot}
              title="No published agents"
              description="Publish an agent to start chatting with it."
              action={
                <Link
                  to="/agents"
                  className="lift inline-flex h-8 items-center gap-1 rounded-capsule border border-black/10 bg-white/40 px-3 text-[12.5px] font-medium text-ink-2 hover:bg-white/70 hover:text-ink"
                >
                  Open Agents
                </Link>
              }
            />
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-4">
              No agents match “{query}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((agent) => {
                const modelLabel = modelLabels?.get(agent.id) ?? null;
                // A session runs the published version's BUILD — a failed or
                // still-building version would 422 `version_not_ready` on the
                // first message, so say so up front instead of offering a
                // pick that fails with protocol copy.
                const buildReady = agent.buildStatus === "succeeded";
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      onClick={() => onPick(agent)}
                      disabled={!buildReady}
                      title={
                        buildReady
                          ? undefined
                          : agent.buildStatus === "failed"
                            ? "This agent's build failed — fix and republish it before chatting."
                            : "This agent's build is still in progress — try again shortly."
                      }
                      className={cn(
                        "flex w-full items-center gap-3 rounded-card px-3 py-2.5 text-left",
                        buildReady
                          ? "lift hover:bg-black/[0.04]"
                          : "cursor-not-allowed opacity-60",
                      )}
                    >
                      <AgentMonogram name={agent.name} size="md" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-medium text-ink">
                          {agent.name}
                        </span>
                        {agent.description !== null ? (
                          <span className="line-clamp-1 text-[12px] text-ink-3">
                            {agent.description}
                          </span>
                        ) : null}
                      </span>
                      {!buildReady ? (
                        <StatusChip
                          tone={agent.buildStatus === "failed" ? "error" : "neutral"}
                          dot
                        >
                          {agent.buildStatus === "failed" ? "Build failed" : "Building…"}
                        </StatusChip>
                      ) : modelLabel !== null ? (
                        <Chip mono className="shrink-0" title="Resolved model">
                          {modelLabel}
                        </Chip>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
