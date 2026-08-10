/**
 * Connection health indicator (connectors redesign spec §7/§10) — E1
 * color-as-meaning: ok green, auth_* amber (fixable by the user), unreachable
 * red, unknown ink-muted. Rendered as dot + label in the detail's health
 * panel and as a bare dot on cards / picker rows (`dotOnly`).
 */
import type { ConnectionHealth } from "@invisible-string/shared";

import { cn } from "../../lib/cn";

export const HEALTH_LABEL: Record<ConnectionHealth, string> = {
  unknown: "Not checked",
  ok: "Healthy",
  unreachable: "Unreachable",
  auth_required: "Auth required",
  auth_error: "Auth error",
};

const DOT: Record<ConnectionHealth, string> = {
  unknown: "bg-ink-4",
  ok: "bg-ok",
  unreachable: "bg-err",
  auth_required: "bg-warn",
  auth_error: "bg-warn",
};

const TEXT: Record<ConnectionHealth, string> = {
  unknown: "text-ink-3",
  ok: "text-ok",
  unreachable: "text-err",
  auth_required: "text-warn",
  auth_error: "text-warn",
};

export interface HealthBadgeProps {
  health: ConnectionHealth;
  /** Bare dot with the label as tooltip + SR text (cards, compact rows). */
  dotOnly?: boolean;
  className?: string;
}

export function HealthBadge({ health, dotOnly = false, className }: HealthBadgeProps) {
  const label = HEALTH_LABEL[health];
  if (dotOnly) {
    return (
      <span title={label} className={cn("inline-flex shrink-0", className)}>
        <span aria-hidden="true" className={cn("size-2 rounded-full", DOT[health])} />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] font-medium",
        TEXT[health],
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[health])} />
      {label}
    </span>
  );
}
