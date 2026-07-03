import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "ink";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-black/[0.05] text-ink-2",
  success: "bg-ok/12 text-ok",
  warning: "bg-warn/15 text-warn-ink",
  error: "bg-err/12 text-err",
  ink: "bg-ink text-white",
};

const DOT: Record<StatusTone, string> = {
  neutral: "bg-ink-4",
  success: "bg-ok",
  warning: "bg-warn",
  error: "bg-err",
  ink: "bg-white",
};

export interface StatusChipProps {
  tone?: StatusTone;
  /** Show a leading state dot (semantic color = meaning). */
  dot?: boolean;
  children: ReactNode;
  className?: string;
  title?: string;
}

/** Compact capsule state chip — the E1 way to show meaning-as-color. */
export function StatusChip({
  tone = "neutral",
  dot = false,
  children,
  className,
  title,
}: StatusChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-capsule px-2 py-0.5 text-[11px] font-medium",
        TONE[tone],
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[tone])} />
      ) : null}
      {children}
    </span>
  );
}
