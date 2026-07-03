/**
 * Small capsule chips used across the chat surface (workflow name, pinned
 * version, resolved model). Ink-on-glass, optional leading icon.
 */
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";

export interface ChipProps {
  icon?: LucideIcon;
  children: React.ReactNode;
  /** Render the label in ui-monospace (model ids, versions). */
  mono?: boolean;
  className?: string;
  title?: string;
}

export function Chip({ icon: Icon, children, mono, className, title }: ChipProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-capsule border border-black/[0.07] bg-black/[0.035] px-2 py-0.5 text-[11.5px] font-medium text-ink-2",
        className,
      )}
    >
      {Icon ? <Icon size={12} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-3" /> : null}
      <span className={cn("truncate", mono && "font-mono text-[11px]")}>{children}</span>
    </span>
  );
}
