import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ChipTone = "neutral" | "ok" | "warn" | "err" | "ink";

export interface ChipProps {
  children: ReactNode;
  tone?: ChipTone;
  /** Small leading dot (semantic status). */
  dot?: boolean;
  className?: string;
  title?: string;
}

const TONE: Record<ChipTone, string> = {
  neutral: "bg-black/[0.05] text-ink-2",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/15 text-warn",
  err: "bg-err/12 text-err",
  ink: "bg-ink text-white",
};

const DOT: Record<ChipTone, string> = {
  neutral: "bg-ink-4",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  ink: "bg-white",
};

/** Small capsule label — status, role, count, policy. */
export function Chip({ children, tone = "neutral", dot = false, className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-capsule px-2.5 py-1 text-[12px] font-medium leading-none",
        TONE[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])}
        />
      ) : null}
      {children}
    </span>
  );
}
