/**
 * The hairline spine between step cards — three duties in one element:
 *
 * - INSERT: a "+" capsule fades in on hover/focus and opens the
 *   {@link AddStepMenu} (hidden entirely in read-only/run contexts).
 * - DROP TARGET: a dragged card (see StepCard's handle) can land here; the
 *   strip translates the drop into a `moveStep`.
 * - RUN PULSE: `active` marks the spine feeding the currently-running step —
 *   a slow ink pulse, `motion-safe:` only so reduced-motion gets a solid dot.
 *
 * The "+" button stays in the layout only while an insert is possible; the
 * spine itself is decorative (aria-hidden) so screen readers hear one insert
 * button per gap, nothing else.
 */
import { useState, type DragEvent } from "react";
import { Plus } from "lucide-react";
import type { PipelineStepKind } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { Popover } from "../ui/Popover";
import { AddStepMenu } from "./AddStepMenu";

/** MIME type carrying the dragged step id between handle and connector. */
export const STEP_DRAG_TYPE = "application/x-pipeline-step";

export interface StepConnectorProps {
  /** Insert a freshly minted step of `kind` at this gap. Omit = no insert affordance. */
  onAdd?: ((kind: PipelineStepKind) => void) | undefined;
  /** "Describe it instead →" (focus the composer). */
  onDescribe?: (() => void) | undefined;
  /** A dragged card dropped on this gap. Omit = not a drop target. */
  onDropStep?: ((stepId: string) => void) | undefined;
  /** False inside for_each bodies (no nested loops in v1). */
  allowForEach?: boolean;
  /** Run overlay: this gap feeds the running step — pulse it. */
  active?: boolean;
  /** Accessible name suffix, e.g. "before “summarize”". */
  positionLabel?: string;
}

export function StepConnector({
  onAdd,
  onDescribe,
  onDropStep,
  allowForEach = true,
  active = false,
  positionLabel,
}: StepConnectorProps) {
  const [dragOver, setDragOver] = useState(false);

  const dropProps =
    onDropStep === undefined
      ? {}
      : {
          onDragOver: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(STEP_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOver(true);
          },
          onDragLeave: () => setDragOver(false),
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            setDragOver(false);
            const stepId = event.dataTransfer.getData(STEP_DRAG_TYPE);
            if (stepId !== "") onDropStep(stepId);
          },
        };

  return (
    <div
      className={cn(
        "group/connector relative flex h-6 items-center justify-center",
        dragOver && "h-9",
      )}
      data-drag-over={dragOver || undefined}
      {...dropProps}
    >
      {/* The spine. Purely visual — announced via the insert button only. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2",
          dragOver ? "bg-ink/50" : "bg-black/[0.12]",
        )}
      />
      {active ? (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink motion-safe:animate-pulse"
        />
      ) : null}
      {onAdd !== undefined ? (
        <Popover
          label={positionLabel ? `Add a step ${positionLabel}` : "Add a step"}
          align="start"
          className="left-1/2 -translate-x-1/2"
          trigger={
            <button
              type="button"
              aria-label={
                positionLabel ? `Add a step ${positionLabel}` : "Add a step"
              }
              className={cn(
                "lift relative z-10 flex size-5 items-center justify-center rounded-full border border-black/15 bg-white text-ink-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]",
                "opacity-0 transition-opacity duration-150 ease-out",
                "group-hover/connector:opacity-100 focus-visible:opacity-100",
                dragOver && "opacity-100",
              )}
            >
              <Plus size={11} aria-hidden="true" />
            </button>
          }
        >
          {({ close }) => (
            <AddStepMenu
              allowForEach={allowForEach}
              onPick={(kind) => {
                close();
                onAdd(kind);
              }}
              onDescribe={
                onDescribe === undefined
                  ? undefined
                  : () => {
                      close();
                      onDescribe();
                    }
              }
            />
          )}
        </Popover>
      ) : null}
    </div>
  );
}
