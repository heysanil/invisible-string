/**
 * Layout chrome for a container step's children: an indented left rail per
 * lane, each lane stacked VERTICALLY under a small label capsule (branch
 * lanes are never columns — E1 keeps the strip one readable column at every
 * width). The strip supplies the children (its own recursive list rendering);
 * this component owns only the rail + labels, so the recursion lives in one
 * place.
 */
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export interface NestedLane {
  key: string;
  /** Lane capsule text ("For each item", "When …", "Else"); null = no label. */
  label: string | null;
  /** Secondary text after the label (e.g. the condition, muted). */
  detail?: string | undefined;
  children: ReactNode;
}

export interface NestedStepsProps {
  lanes: readonly NestedLane[];
  className?: string;
}

export function NestedSteps({ lanes, className }: NestedStepsProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {lanes.map((lane) => (
        <div
          key={lane.key}
          data-testid="nested-lane"
          className="ml-3 border-l border-black/[0.1] pl-3"
        >
          {lane.label !== null ? (
            <p className="mb-1 flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 rounded-capsule bg-black/[0.05] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
                {lane.label}
              </span>
              {lane.detail !== undefined && lane.detail !== "" ? (
                <span className="truncate text-[11.5px] text-ink-4">
                  {lane.detail}
                </span>
              ) : null}
            </p>
          ) : null}
          {lane.children}
        </div>
      ))}
    </div>
  );
}
