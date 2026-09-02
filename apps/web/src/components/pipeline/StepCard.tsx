/**
 * One step of the pipeline strip, in three densities:
 *
 * - "compact" — icon · name · kind · chip on one line (narrow contexts).
 * - "default" — + the one-line `stepSummary()`, diagnostics badge, overflow
 *   menu (Duplicate / Move / Remove) and a drag handle. The EDITING card.
 * - "run"     — + {@link StepStatusBadge}, duration and iteration counters;
 *   the same card IS the run timeline (one grammar at rest and in motion),
 *   so editing affordances disappear rather than disable.
 *
 * Interactivity is deliberately un-nested (WCAG 4.1.2): the selectable
 * surface is one button; the menu and drag handle are SIBLINGS overlaid on
 * the card's top-right corner, revealed on hover/focus-within. The drag
 * handle's keyboard fallback is ArrowUp/ArrowDown while it has focus — the
 * same reorders the overflow menu offers, so drag is never the only path.
 *
 * A pending copilot proposal targeting this step marks it with `ghostMode`
 * (dashed ink ring for an update, dashed err ring for a remove) — the
 * strip-side half of the ghost-proposal vocabulary (GhostStepCard is the
 * other half, for steps that do not exist yet).
 */
import { useState, type DragEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import type { PipelineStep, RunStepStatus } from "@invisible-string/shared";

import {
  STEP_KIND_LABELS,
  stepChipSummary,
  stepSummary,
  type StepSummaryContext,
} from "../../lib/builder/summary";
import { STEP_KIND_ICONS, stepDisplayTitle } from "../../lib/copilot/mutations";
import { cn } from "../../lib/cn";
import { Popover } from "../ui/Popover";
import { StepStatusBadge } from "./StepStatusBadge";
import { STEP_DRAG_TYPE } from "./StepConnector";

export type StepCardDensity = "compact" | "default" | "run";

/** Per-step run overlay (derived by the runs view's progress reducer). */
export interface StepRunState {
  status: RunStepStatus;
  /** 1-based attempt of the latest start (retries surface as "try n"). */
  attempt?: number;
  durationMs?: number;
  /** for_each aggregate: iterations finished / planned (null = unknown yet). */
  iterations?: { done: number; total: number | null };
}

export interface StepCardProps {
  step: PipelineStep;
  ctx: StepSummaryContext;
  density?: StepCardDensity;
  selected?: boolean;
  /** Roving tabindex — exactly one card in the strip is tabbable. */
  tabbable?: boolean;
  /** Diagnostics on this card (badge count; `hasError` picks the tone). */
  issueCount?: number;
  hasError?: boolean;
  /** Run overlay; implies no editing affordances. */
  run?: StepRunState | null;
  /** Pending-proposal marker (see module doc). */
  ghostMode?: "update" | "remove" | null;
  /** Applied-proposal flash (pillar-flash treatment). */
  flash?: boolean;
  onSelect?: (() => void) | undefined;
  onDuplicate?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  /** Null = at the edge (rendered disabled). Omit both to hide reordering. */
  onMoveUp?: (() => void) | null | undefined;
  onMoveDown?: (() => void) | null | undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function StepCard({
  step,
  ctx,
  density = "default",
  selected = false,
  tabbable = true,
  issueCount = 0,
  hasError = false,
  run = null,
  ghostMode = null,
  flash = false,
  onSelect,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StepCardProps) {
  const [dragging, setDragging] = useState(false);
  const Icon = STEP_KIND_ICONS[step.kind];
  const title = stepDisplayTitle(step);
  const chip = stepChipSummary(step, ctx);
  const summary = density === "compact" ? null : stepSummary(step, ctx);
  const editable =
    density === "default" &&
    (onDuplicate !== undefined ||
      onRemove !== undefined ||
      onMoveUp !== undefined ||
      onMoveDown !== undefined);
  const showHandle = editable && (onMoveUp !== undefined || onMoveDown !== undefined);

  function onHandleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp" && onMoveUp) {
      event.preventDefault();
      onMoveUp();
    } else if (event.key === "ArrowDown" && onMoveDown) {
      event.preventDefault();
      onMoveDown();
    }
  }

  function onDragStart(event: DragEvent<HTMLButtonElement>) {
    event.dataTransfer.setData(STEP_DRAG_TYPE, step.id);
    event.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }

  return (
    <div
      className={cn("group/card relative", dragging && "opacity-50")}
      data-testid="step-card"
      data-step-kind={step.kind}
    >
      <button
        type="button"
        data-step-id={step.id}
        data-ghost={ghostMode ?? undefined}
        tabIndex={tabbable ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        aria-label={`${title} — ${STEP_KIND_LABELS[step.kind]} step`}
        onClick={onSelect}
        className={cn(
          "lift flex w-full items-start gap-2.5 rounded-card-lg border text-left",
          density === "compact" ? "px-2.5 py-1.5" : "px-3 py-2.5",
          selected
            ? "border-ink/80 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
            : "border-black/10 bg-white/45 hover:border-black/20 hover:bg-white/65",
          ghostMode === "update" && "border-dashed border-ink/40",
          ghostMode === "remove" && "border-dashed border-err/50",
          flash && "pillar-flash",
          editable && "pr-16",
        )}
      >
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full",
            density === "compact" ? "mt-0 size-5" : "mt-0.5 size-6",
            selected ? "bg-ink text-white" : "bg-black/[0.05] text-ink-2",
          )}
        >
          <Icon size={density === "compact" ? 11 : 12} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "truncate text-[13px] font-medium leading-snug",
                ghostMode === "remove"
                  ? "text-ink-3 line-through decoration-ink-3/60"
                  : "text-ink",
              )}
            >
              {title}
            </span>
            <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-ink-4">
              {STEP_KIND_LABELS[step.kind]}
            </span>
            {chip !== null ? (
              <span
                data-testid="step-chip"
                className={cn(
                  "max-w-[45%] shrink-0 truncate rounded-capsule border px-1.5 text-[10.5px]",
                  chip.status === "ok" || chip.status === "loading"
                    ? "border-black/[0.08] bg-white/60 text-ink-3"
                    : chip.status === "none"
                      ? "border-dashed border-black/15 bg-transparent text-ink-4"
                      : "border-err/30 bg-err/[0.05] text-err",
                )}
              >
                {chip.label}
              </span>
            ) : null}
          </span>
          {summary !== null ? (
            <span className="truncate text-[12px] leading-snug text-ink-3">
              {summary}
            </span>
          ) : null}
          {density === "run" && run !== null ? (
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <StepStatusBadge
                status={run.status}
                {...(run.attempt !== undefined ? { attempt: run.attempt } : {})}
              />
              {run.iterations !== undefined ? (
                <span className="text-[11px] text-ink-4">
                  {run.iterations.done}
                  {run.iterations.total !== null ? ` / ${run.iterations.total}` : ""}{" "}
                  items
                </span>
              ) : null}
              {run.durationMs !== undefined ? (
                <span className="text-[11px] tabular-nums text-ink-4">
                  {formatDuration(run.durationMs)}
                </span>
              ) : null}
            </span>
          ) : null}
          {density !== "run" && issueCount > 0 ? (
            <span
              data-testid="step-issue-badge"
              className={cn(
                "mt-0.5 inline-flex w-fit items-center gap-1 rounded-capsule px-1.5 py-0.5 text-[10.5px] font-medium",
                hasError ? "bg-err/12 text-err" : "bg-warn/15 text-warn-ink",
              )}
            >
              <AlertTriangle size={9} aria-hidden="true" />
              {issueCount} issue{issueCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </span>
      </button>

      {editable ? (
        <span
          className={cn(
            "absolute right-2 top-2 flex items-center gap-0.5",
            "opacity-0 transition-opacity duration-150 ease-out",
            "focus-within:opacity-100 group-hover/card:opacity-100",
          )}
        >
          {showHandle ? (
            <button
              type="button"
              draggable
              aria-label={`Move ${title} (arrow keys, or drag onto a gap)`}
              title="Drag to move · arrow keys to reorder"
              onDragStart={onDragStart}
              onDragEnd={() => setDragging(false)}
              onKeyDown={onHandleKeyDown}
              className="flex size-6 cursor-grab items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink active:cursor-grabbing"
            >
              <GripVertical size={13} aria-hidden="true" />
            </button>
          ) : null}
          <Popover
            label={`Step actions for ${title}`}
            align="end"
            trigger={
              <button
                type="button"
                aria-label={`Step actions for ${title}`}
                className="flex size-6 items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            }
          >
            {({ close }) => (
              <div role="menu" aria-label="Step actions" className="flex w-44 flex-col gap-0.5">
                {onDuplicate !== undefined ? (
                  <MenuItem
                    label="Duplicate"
                    icon={<Copy size={12} aria-hidden="true" />}
                    onClick={() => {
                      close();
                      onDuplicate();
                    }}
                  />
                ) : null}
                {onMoveUp !== undefined ? (
                  <MenuItem
                    label="Move up"
                    icon={<ArrowUp size={12} aria-hidden="true" />}
                    disabled={onMoveUp === null}
                    onClick={() => {
                      close();
                      onMoveUp?.();
                    }}
                  />
                ) : null}
                {onMoveDown !== undefined ? (
                  <MenuItem
                    label="Move down"
                    icon={<ArrowDown size={12} aria-hidden="true" />}
                    disabled={onMoveDown === null}
                    onClick={() => {
                      close();
                      onMoveDown?.();
                    }}
                  />
                ) : null}
                {onRemove !== undefined ? (
                  <MenuItem
                    label="Remove"
                    tone="danger"
                    icon={<Trash2 size={12} aria-hidden="true" />}
                    onClick={() => {
                      close();
                      onRemove();
                    }}
                  />
                ) : null}
              </div>
            )}
          </Popover>
        </span>
      ) : null}
    </div>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
  disabled = false,
  tone = "default",
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-card px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-150 ease-out",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink",
        tone === "danger"
          ? "text-err hover:bg-err/[0.06]"
          : "text-ink-2 hover:bg-black/[0.05] hover:text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
