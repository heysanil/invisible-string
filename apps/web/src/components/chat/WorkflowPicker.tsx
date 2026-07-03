/**
 * "New chat" workflow picker — a glass modal listing PUBLISHED workflows
 * only (a session pins the published version). Searchable; each row shows
 * the workflow name + its trigger chip. Selecting one starts a session
 * against its published version.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Workflow, X, Zap } from "lucide-react";

import type { WorkflowSummaryDto } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { EmptyState } from "../ui/EmptyState";
import { Chip } from "./Chip";

export interface WorkflowPickerProps {
  workflows: readonly WorkflowSummaryDto[];
  onPick: (workflow: WorkflowSummaryDto) => void;
  onClose: () => void;
}

export function WorkflowPicker({
  workflows,
  onPick,
  onClose,
}: WorkflowPickerProps) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);

  const published = useMemo(
    () => workflows.filter((workflow) => workflow.publishedVersionId !== null),
    [workflows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return published;
    return published.filter((workflow) =>
      workflow.name.toLowerCase().includes(q),
    );
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
      <div
        ref={dialogRef}
        className="glass-panel panel-enter relative flex max-h-[70vh] w-full max-w-md flex-col overflow-hidden"
      >
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
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search published workflows"
              aria-label="Search published workflows"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>
        </div>

        <div className="mx-5 h-px bg-black/[0.06]" aria-hidden="true" />

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {published.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="No published workflows"
              description="Publish a workflow in the builder to start a chat with it."
            />
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-4">
              No workflows match “{query}”.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((workflow) => (
                <li key={workflow.id}>
                  <button
                    type="button"
                    onClick={() => onPick(workflow)}
                    className={cn(
                      "lift flex w-full items-center gap-3 rounded-card px-3 py-2.5 text-left hover:bg-black/[0.04]",
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-ink-3">
                      <Zap size={15} strokeWidth={1.9} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
                      {workflow.name}
                    </span>
                    {workflow.triggerType !== null ? (
                      <Chip>{workflow.triggerType}</Chip>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
