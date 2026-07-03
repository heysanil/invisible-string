import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Usually a ghost capsule CTA. */
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-5 p-10 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
        <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <h2 className="text-[15px]">{title}</h2>
        <p className="text-sm leading-relaxed text-ink-3">{description}</p>
      </div>
      {action}
    </div>
  );
}
