/**
 * The trigger's card at the top of the pipeline pane: a compact
 * `triggerSummary()` header that expands in place (accordion) to the full
 * draft editor — the EXISTING {@link TriggerEditor}, imported, never forked —
 * plus a `live` slot for the server-backed half (LiveTriggerConfig: token
 * mint/rotate, Slack team binding), which the route provides because it
 * carries queries the card should not own.
 *
 * Expansion is controlled by the parent (the pane keeps at most one thing
 * expanded); `panel-enter` supplies the 180ms-class ease-out reveal and the
 * tokens' reduced-motion block clamps it.
 */
import { ChevronDown, Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkflowConfig } from "@invisible-string/shared";

import type { BuilderAction } from "../../lib/builder/model";
import type { BuilderDiagnostic } from "../../lib/builder/diagnostics";
import { triggerSummary } from "../../lib/builder/summary";
import { cn } from "../../lib/cn";
import { DiagnosticsList } from "../builder/DiagnosticsList";
import { TriggerEditor } from "../builder/TriggerEditor";

export interface TriggerCardProps {
  definition: WorkflowConfig;
  dispatch: (action: BuilderAction) => void;
  /** Trigger-bucket diagnostics (BuilderDiagnostics.trigger). */
  diagnostics?: readonly BuilderDiagnostic[];
  expanded: boolean;
  onToggle: () => void;
  /** Server-backed trigger config (LiveTriggerConfig), route-provided. */
  live?: ReactNode;
  /** Applied-proposal flash (setTrigger landed). */
  flash?: boolean;
  /** "✦ ask copilot to fix" on the diagnostics list. */
  onAskCopilot?: ((prompt: string) => void) | undefined;
}

export function TriggerCard({
  definition,
  dispatch,
  diagnostics = [],
  expanded,
  onToggle,
  live,
  flash = false,
  onAskCopilot,
}: TriggerCardProps) {
  const summary = triggerSummary(definition);
  return (
    <section
      data-testid="trigger-card"
      className={cn(
        "rounded-card-lg border bg-white/45",
        expanded ? "border-ink/60 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]" : "border-black/10",
        flash && "pillar-flash",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 rounded-card-lg px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full",
            expanded ? "bg-ink text-white" : "bg-black/[0.05] text-ink-2",
          )}
        >
          <Zap size={12} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-ink">Trigger</span>
            <span className="shrink-0 rounded-capsule border border-black/[0.08] bg-white/60 px-1.5 text-[10.5px] text-ink-3">
              {summary.typeLabel}
            </span>
            {diagnostics.length > 0 ? (
              <span className="shrink-0 rounded-capsule bg-warn/15 px-1.5 text-[10.5px] font-medium text-warn-ink">
                {diagnostics.length} issue{diagnostics.length === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
          <span className="truncate text-[12px] text-ink-3">{summary.detail}</span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-ink-4 transition-transform duration-150 ease-out",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded ? (
        <div className="panel-enter flex flex-col gap-4 border-t border-black/[0.06] px-3.5 pb-4 pt-3.5">
          {diagnostics.length > 0 ? (
            <DiagnosticsList
              diagnostics={diagnostics}
              {...(onAskCopilot ? { onAskCopilot } : {})}
            />
          ) : null}
          <TriggerEditor definition={definition} dispatch={dispatch} />
          {live}
        </div>
      ) : null}
    </section>
  );
}
