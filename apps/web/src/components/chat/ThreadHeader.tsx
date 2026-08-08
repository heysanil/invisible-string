/**
 * Thread header: session title, monogram-fronted agent chip + pinned agent
 * version, resolved model chip, a workflow provenance chip for
 * trigger-origin sessions, the session-actions menu (eve 0.31 context
 * controls) and an "Edit agent ↗" link into the agent editor.
 *
 * The menu is Popover + Button — the house pattern (TestRunPopover,
 * ContextAttachments). Clear and compact are non-destructive and fire
 * straight off the menu; RESET is destructive (the retired eve session id can
 * never accept another message) so it only ever *asks*, and the owning
 * container puts a ConfirmDialog in front of it.
 */
import { Fragment, useEffect, useRef } from "react";
import {
  ArrowUpRight,
  Cpu,
  Eraser,
  GitBranch,
  Layers,
  MoreHorizontal,
  RotateCcw,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { AgentMonogram } from "../agents/AgentMonogram";
import { Button } from "../ui/Button";
import { Popover } from "../ui/Popover";
import { livenessOf, StatusDot, type Liveness } from "./StatusDot";
import { Chip } from "./Chip";
import type {
  AgentSessionStatus,
  RunStatus,
} from "@invisible-string/shared";

/** The three eve 0.31 session context controls. */
export type SessionContextAction = "clear" | "compact" | "reset";

export interface ThreadHeaderProps {
  title: string;
  agentName: string;
  agentId: string;
  /** Pinned agent version (short hash / id) — the session's frozen version. */
  versionLabel: string | null;
  /** Resolved model id from the run's session.started event. */
  modelId: string | null;
  /** Workflow provenance — set only for trigger-origin sessions. */
  workflowName: string | null;
  sessionStatus: AgentSessionStatus;
  lastRunStatus: RunStatus | null;
  /**
   * Fires a context control. `reset` is expected to open a confirm step in
   * the caller, not to run immediately.
   */
  onContextAction?: (action: SessionContextAction) => void;
  /** The control whose request is in flight (spinner + disabled). */
  contextActionPending?: SessionContextAction | null;
  /**
   * Set while the session cannot take a control — a run is in flight, so eve
   * would queue the command behind it. The reason is shown in the menu
   * rather than leaving dead-looking rows.
   */
  contextActionsBlockedReason?: string | null;
}

const LIVENESS_TEXT: Record<Liveness, string> = {
  running: "Running",
  waiting: "Waiting for your input",
  error: "Failed",
  stopped: "Stopped",
  idle: "Idle",
};

const CONTEXT_ACTIONS: readonly {
  action: SessionContextAction;
  icon: LucideIcon;
  label: string;
  description: string;
  destructive?: boolean;
}[] = [
  {
    action: "clear",
    icon: Eraser,
    label: "Clear context",
    description: "Forget the messages so far. The thread stays.",
  },
  {
    action: "compact",
    icon: Layers,
    label: "Compact context",
    description: "Summarize the messages so far to free up room.",
  },
  {
    action: "reset",
    icon: RotateCcw,
    label: "Reset session",
    description: "Retire this session and start a fresh one.",
    destructive: true,
  },
];

export function ThreadHeader({
  title,
  agentName,
  agentId,
  versionLabel,
  modelId,
  workflowName,
  sessionStatus,
  lastRunStatus,
  onContextAction,
  contextActionPending,
  contextActionsBlockedReason,
}: ThreadHeaderProps) {
  const liveness = livenessOf(sessionStatus, lastRunStatus);
  return (
    <header className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusDot state={liveness} />
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {title}
          </h1>
          <span className="shrink-0 text-[11px] text-ink-4">
            {LIVENESS_TEXT[liveness]}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip
            leading={
              // Chip-scale monogram: the important overrides win over the
              // size preset (cn has no tailwind-merge).
              <AgentMonogram
                name={agentName}
                size="sm"
                className="size-4! text-[8px]!"
              />
            }
            title="Agent"
          >
            {agentName}
          </Chip>
          {versionLabel !== null ? (
            <Chip icon={GitBranch} mono title="Pinned agent version">
              {versionLabel}
            </Chip>
          ) : null}
          {modelId !== null ? (
            <Chip icon={Cpu} mono title="Resolved model">
              {modelId}
            </Chip>
          ) : null}
          {workflowName !== null ? (
            <Chip icon={Zap} title="Started by workflow">
              {workflowName}
            </Chip>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onContextAction !== undefined ? (
          <SessionActionsMenu
            onContextAction={onContextAction}
            pending={contextActionPending ?? null}
            blockedReason={contextActionsBlockedReason ?? null}
          />
        ) : null}
        <Link
          to="/agents/$agentId"
          params={{ agentId }}
          className="lift inline-flex h-8 shrink-0 items-center gap-1 rounded-capsule border border-black/10 bg-white/40 px-3 text-[12.5px] font-medium text-ink-2 hover:bg-white/70 hover:text-ink"
        >
          Edit agent
          <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>
    </header>
  );
}

function SessionActionsMenu({
  onContextAction,
  pending,
  blockedReason,
}: {
  onContextAction: (action: SessionContextAction) => void;
  pending: SessionContextAction | null;
  blockedReason: string | null;
}) {
  return (
    <Popover
      label="Session actions"
      align="end"
      // The menu floats over the TRANSCRIPT, and `glass-panel`'s 55%-white
      // backdrop-filter is neutered here: the thread pane is itself a
      // glass-panel, and a nested backdrop-filter samples its already
      // composited backdrop, so nothing behind actually blurs and the text
      // shows straight through. Floating surfaces over dense text take the
      // opaque `--surface-solid` (the same answer `.cm-tooltip` uses, and the
      // token `prefers-reduced-transparency` already falls back to); the glass
      // border, shadow and enter animation are untouched.
      className="w-72 bg-[var(--surface-solid)]!"
      trigger={
        <Button
          variant="quiet"
          size="sm"
          // `cn` has no tailwind-merge, so overrides of a preset must be
          // !important (same convention as AgentMonogram's size override).
          className="w-8 px-0!"
          title="Session actions"
        >
          <MoreHorizontal size={16} aria-hidden="true" />
          <span className="sr-only">Session actions</span>
        </Button>
      }
    >
      {({ close }) => (
        <SessionActionsMenuBody
          close={close}
          onContextAction={onContextAction}
          pending={pending}
          blockedReason={blockedReason}
        />
      )}
    </Popover>
  );
}

/**
 * Menu body, split out ONLY so it can hold a hook: the auto-close effect
 * needs the Popover's `close`, which exists only inside its render prop.
 *
 * Non-destructive actions (clear, compact) keep the menu open so their
 * spinner is actually visible, and it closes itself once the mutation
 * settles. Closing on click — as this did — unmounted the row before
 * `pending` could render, so the `loading` state threaded all the way down
 * from ThreadContainer was never seen and the actions felt inert until their
 * toast landed. `reset` still closes immediately: its confirm step takes over
 * the screen, so a menu lingering behind it is just clutter.
 */
function SessionActionsMenuBody({
  close,
  onContextAction,
  pending,
  blockedReason,
}: {
  close: () => void;
  onContextAction: (action: SessionContextAction) => void;
  pending: SessionContextAction | null;
  blockedReason: string | null;
}) {
  const sawPending = useRef(false);
  useEffect(() => {
    if (pending !== null) {
      sawPending.current = true;
      return;
    }
    if (sawPending.current) {
      sawPending.current = false;
      close();
    }
  }, [pending, close]);

  return (
        <div className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-4">
            Context
          </p>
          {blockedReason !== null ? (
            <p className="px-2 pb-1.5 text-[12px] leading-snug text-ink-3">
              {blockedReason}
            </p>
          ) : null}
          {CONTEXT_ACTIONS.map((entry) => (
            <Fragment key={entry.action}>
              {/* Reset is set apart by a rule, not by colour: the red belongs
                  on its confirm step, where the consequence is explained. */}
              {entry.destructive === true ? (
                <span className="my-1 h-px bg-black/[0.1]" aria-hidden="true" />
              ) : null}
              <Button
                variant="quiet"
                size="sm"
                loading={pending === entry.action}
                disabled={blockedReason !== null || pending !== null}
                onClick={() => {
                  // Destructive hands off to a confirm step that owns the
                  // screen; the others stay open to show their spinner and
                  // are closed by the settle effect above.
                  if (entry.destructive === true) close();
                  onContextAction(entry.action);
                }}
                // `!` overrides the size preset — `cn` has no tailwind-merge.
                className="h-auto! w-full items-start! justify-start! gap-2.5 whitespace-normal! px-2! py-2 text-left"
              >
                {pending === entry.action ? null : (
                  <entry.icon
                    size={14}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-ink-3"
                  />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium text-ink">
                    {entry.label}
                  </span>
                  <span className="text-[11.5px] font-normal leading-snug text-ink-4">
                    {entry.description}
                  </span>
                </span>
              </Button>
            </Fragment>
          ))}
        </div>
  );
}
