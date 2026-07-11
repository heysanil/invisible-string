/**
 * Small capsule chips used across the chat surface (agent name, pinned
 * version, resolved model, workflow provenance). Ink-on-glass, optional
 * leading icon or custom leading adornment (e.g. an agent monogram).
 */
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";

export interface ChipProps {
  icon?: LucideIcon;
  /** Custom leading adornment (e.g. an AgentMonogram); wins over `icon`. */
  leading?: React.ReactNode;
  children: React.ReactNode;
  /** Render the label in ui-monospace (model ids, versions). */
  mono?: boolean;
  className?: string;
  title?: string;
}

export function Chip({ icon: Icon, leading, children, mono, className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-capsule border border-black/[0.07] bg-black/[0.035] px-2 py-0.5 text-[11.5px] font-medium text-ink-2",
        className,
      )}
    >
      {leading ??
        (Icon ? (
          <Icon size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-3" />
        ) : null)}
      <span className={cn("truncate", mono && "font-mono text-[11px]")}>{children}</span>
    </span>
  );
}
